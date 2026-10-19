/*
 * Dodo driver pricing engine.
 *
 * Formula (from "Dodo pricing for claude.xlsx"):
 *   1. Round the delivery distance UP to the next distance band (0.5 mi).
 *   2. Card fee = Base £8.00 + £0.40 × banded miles.
 *   3. Fee = max(card fee, £10.00 floor).
 *
 * e.g. 8.20 mi → 8.5 mi band → 8.00 + 0.40 × 8.5 = £11.40
 *      5.00 mi → 5.0 mi band → 8.00 + 0.40 × 5.0 = £10.00
 *      3.10 mi → 3.5 mi band → £9.40, below floor → £10.00
 *
 * Works in the browser (window.DodoPricing) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  var DEFAULT_CONFIG = {
    base: 8.0,          // £ fixed per delivery
    perMile: 0.4,       // £ per banded mile
    floor: 10.0,        // £ minimum per delivery
    bandMiles: 0.5,     // distance is rounded UP to a multiple of this
    extraDropFee: 0.0   // £ per drop after the first on a route (0 = off)
  };

  function money(x) {
    return Math.round((x + Number.EPSILON) * 100) / 100;
  }

  function fmt(x) {
    var m = money(x);
    return (m < 0 ? '-£' : '£') + Math.abs(m).toFixed(2);
  }

  function trimNum(x) {
    return String(Math.round(x * 1000) / 1000);
  }

  // Round distance up to the band. The inner rounding stops float noise
  // (e.g. 5.0000000001) from jumping a whole band.
  function bandedMiles(distance, cfg) {
    var band = cfg.bandMiles > 0 ? cfg.bandMiles : 0;
    if (!band) return distance;
    var steps = Math.ceil(Math.round((distance / band) * 1e6) / 1e6);
    return money(steps * band);
  }

  function deliveryFee(distance, config) {
    var cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    if (distance === null || distance === undefined || distance === '' || isNaN(distance)) {
      return { ok: false, fee: null, breakdown: 'No distance — enter miles to price this drop' };
    }
    var d = Math.max(0, Number(distance));
    var banded = bandedMiles(d, cfg);
    var mileage = money(cfg.perMile * banded);
    var card = money(cfg.base + mileage);
    var atFloor = card < cfg.floor;
    var fee = atFloor ? money(cfg.floor) : card;
    var bandLow = money(Math.max(0, banded - cfg.bandMiles));

    var parts = [];
    parts.push(trimNum(d) + ' mi');
    if (cfg.bandMiles > 0) {
      parts.push('band ' + bandLow.toFixed(1) + '–' + banded.toFixed(1) + ' mi → charged as ' + banded.toFixed(1) + ' mi');
    }
    parts.push(fmt(cfg.base) + ' base + ' + banded.toFixed(1) + ' × ' + fmt(cfg.perMile) + ' = ' + fmt(card));
    if (atFloor) parts.push('below ' + fmt(cfg.floor) + ' minimum → ' + fmt(fee));

    return {
      ok: true,
      distance: d,
      bandLow: bandLow,
      bandedMiles: banded,
      mileage: mileage,
      card: card,
      atFloor: atFloor,
      fee: fee,
      breakdown: parts.join(' · ')
    };
  }

  // Band table for display / cross-checking against the pricing sheet.
  function bandTable(maxMiles, config) {
    var cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    var rows = [];
    var step = cfg.bandMiles > 0 ? cfg.bandMiles : 0.5;
    for (var hi = step; hi <= maxMiles + 1e-9; hi = money(hi + step)) {
      rows.push({ from: money(hi - step), to: hi, fee: deliveryFee(hi, cfg).fee });
    }
    return rows;
  }

  /*
   * Compute everything from a list of deliveries:
   *   deliveries: [{ id, date, driver, distance, extra, ... }]
   *   adjustments: { 'driver|date': { amount, remark } }  — optional route-level extra charge
   * Returns per-delivery fees, per-route (driver × date) totals and per-driver payables.
   */
  function calculate(deliveries, config, adjustments) {
    var cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    adjustments = adjustments || {};
    var routes = {};
    var drivers = {};

    var priced = deliveries.map(function (d) {
      var p = deliveryFee(d.distance, cfg);
      var extra = Number(d.extra) || 0;
      return Object.assign({}, d, {
        pricing: p,
        fee: p.ok ? p.fee : null,
        extra: money(extra),
        dropTotal: p.ok ? money(p.fee + extra) : null
      });
    });

    priced.forEach(function (d) {
      if (!d.driver) return;
      var key = d.driver + '|' + d.date;
      var r = routes[key];
      if (!r) {
        r = routes[key] = {
          key: key, driver: d.driver, date: d.date, drops: 0, miles: 0,
          fees: 0, extras: 0, dropBonus: 0, unpriced: 0, deliveries: []
        };
      }
      r.drops += 1;
      r.deliveries.push(d);
      if (d.pricing.ok) {
        r.miles += d.pricing.distance;
        r.fees += d.fee;
      } else {
        r.unpriced += 1;
      }
      r.extras += d.extra;
    });

    var routeList = Object.keys(routes).map(function (k) {
      var r = routes[k];
      r.miles = money(r.miles);
      r.fees = money(r.fees);
      r.extras = money(r.extras);
      r.dropBonus = money(Math.max(0, r.drops - 1) * cfg.extraDropFee);
      var adj = adjustments[k] || {};
      r.adjustment = money(Number(adj.amount) || 0);
      r.adjustmentRemark = adj.remark || '';
      r.total = money(r.fees + r.extras + r.dropBonus + r.adjustment);
      return r;
    }).sort(function (a, b) {
      return a.date === b.date ? a.driver.localeCompare(b.driver) : (a.date < b.date ? -1 : 1);
    });

    routeList.forEach(function (r) {
      var dr = drivers[r.driver];
      if (!dr) {
        dr = drivers[r.driver] = {
          driver: r.driver, routes: 0, drops: 0, miles: 0, fees: 0,
          extras: 0, dropBonus: 0, adjustment: 0, remarks: [], unpriced: 0
        };
      }
      dr.routes += 1;
      dr.drops += r.drops;
      dr.miles += r.miles;
      dr.fees += r.fees;
      dr.extras += r.extras;
      dr.dropBonus += r.dropBonus;
      dr.adjustment += r.adjustment;
      if (r.adjustmentRemark) dr.remarks.push(r.adjustmentRemark);
      dr.unpriced += r.unpriced;
    });

    var driverList = Object.keys(drivers).sort().map(function (name) {
      var dr = drivers[name];
      dr.miles = money(dr.miles);
      dr.fees = money(dr.fees);
      dr.extras = money(dr.extras);
      dr.dropBonus = money(dr.dropBonus);
      dr.adjustment = money(dr.adjustment);
      dr.adjustmentRemark = dr.remarks.join('; ');
      dr.payable = money(dr.fees + dr.extras + dr.dropBonus + dr.adjustment);
      return dr;
    });

    var totals = driverList.reduce(function (t, d) {
      t.drops += d.drops; t.fees += d.fees; t.extras += d.extras;
      t.dropBonus += d.dropBonus; t.adjustments += d.adjustment; t.payable += d.payable;
      return t;
    }, { drops: 0, fees: 0, extras: 0, dropBonus: 0, adjustments: 0, payable: 0 });
    Object.keys(totals).forEach(function (k) { if (k !== 'drops') totals[k] = money(totals[k]); });

    return {
      config: cfg,
      deliveries: priced,
      routes: routeList,
      drivers: driverList,
      totals: totals,
      unassigned: priced.filter(function (d) { return !d.driver; }).length,
      unpriced: priced.filter(function (d) { return !d.pricing.ok; }).length
    };
  }

  function describe(config) {
    var cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    var s = 'Fee per drop = max(' + fmt(cfg.floor) + ', ' + fmt(cfg.base) + ' + ' + fmt(cfg.perMile) +
      ' × distance rounded up to the next ' + cfg.bandMiles + ' mi)';
    if (cfg.extraDropFee) s += '; + ' + fmt(cfg.extraDropFee) + ' per extra drop on a route';
    return s;
  }

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    money: money,
    fmt: fmt,
    bandedMiles: bandedMiles,
    deliveryFee: deliveryFee,
    bandTable: bandTable,
    calculate: calculate,
    describe: describe
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DodoPricing = api;
})(typeof self !== 'undefined' ? self : this);
