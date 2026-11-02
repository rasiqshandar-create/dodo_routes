/*
 * Dodo Routes — merge layer.
 *
 * Joins the Tookan route export (stop SEQUENCE, one row per task) with the Retool
 * export (parcels, instructions, DP cost, one row per order).
 *
 *   Tookan "Order ID"  ==  Retool "Order ref"   (Retool "Order ID" is a UUID: never used)
 *
 * When a ref appears more than once in Retool, the best row wins:
 *   same driver as the Tookan agent  >  DP is Dodo / Evermile Own Fleet  >  not cancelled.
 *
 * Sequencing comes from Tookan (row order within each Route ID, untouched).
 * Cost comes from Retool "DP cost"; the Dodo card is only a fallback, and any
 * difference over £0.01 between the two is flagged per order.
 *
 * Works in the browser (window.DodoMerge) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  var P = root.DodoPricing || (typeof require !== 'undefined' ? require('./pricing.js') : null);

  // ---------- column definitions (auto-matched by header name) ----------
  var TOOKAN_FIELDS = [
    { key: 'routeId', label: 'Route ID', req: true, c: ['route id', 'route'] },
    { key: 'date', label: 'Date', c: ['date', 'route date'] },
    { key: 'taskId', label: 'Task ID', c: ['task id', 'job id'] },
    { key: 'type', label: 'Service Type', req: true, c: ['service type', 'task type', 'type'] },
    { key: 'agentId', label: 'Agent ID', c: ['agent id', 'driver id', 'fleet id'] },
    { key: 'agentName', label: 'Agent Name', req: true, c: ['agent name', 'driver name', 'fleet name', 'agent'] },
    { key: 'orderId', label: 'Order ID', req: true, c: ['order id', 'order ref', 'order'] },
    { key: 'name', label: 'Customer Name', c: ['customer name', 'name'] },
    { key: 'address', label: 'Address', c: ['address', 'job address'] },
    { key: 'phone', label: 'Phone Number', c: ['phone number', 'phone', 'customer phone'] },
    { key: 'time', label: 'Time', c: ['time', 'job time'] },
    { key: 'estTime', label: 'Estimated Time (mins)', c: ['estimated time mins', 'estimated time'] },
    { key: 'estDist', label: 'Estimated Distance (km)', c: ['estimated distance kms', 'estimated distance km', 'estimated distance'] }
  ];
  var RETOOL_FIELDS = [
    { key: 'ref', label: 'Order ref', req: true, c: ['order ref', 'order reference', 'external id'] },
    { key: 'merchant', label: 'Merchant name', c: ['merchant name', 'merchant'] },
    { key: 'dp', label: 'DP', c: ['dp', 'delivery partner', 'carrier'] },
    { key: 'orderStatus', label: 'Order status', c: ['order status'] },
    { key: 'deliveryStatus', label: 'Delivery status', c: ['delivery status', 'status'] },
    { key: 'cost', label: 'DP cost', req: true, c: ['dp cost', 'driver cost', 'cost'] },
    { key: 'price', label: 'Platform price', c: ['platform price', 'price'] },
    { key: 'pickupAddress', label: 'Pickup address', c: ['pickup address'] },
    { key: 'customer', label: 'Customer name', c: ['customer name'] },
    { key: 'customerAddress', label: 'Customer address', c: ['customer address'] },
    { key: 'customerPhone', label: 'Customer phone', c: ['customer phone'] },
    { key: 'pickupSlot', label: 'Pickup slot', c: ['pickup slot'] },
    { key: 'deliverySlot', label: 'Delivery slot', c: ['delivery slot'] },
    { key: 'driver', label: 'Driver name', c: ['driver name', 'driver'] },
    { key: 'driverPhone', label: 'Driver phone', c: ['driver phone'] },
    { key: 'vehicle', label: 'Vehicle type', c: ['vehicle type', 'vehicle'] },
    { key: 'parcels', label: 'Parcel count', c: ['parcel count', 'parcels', 'num parcels'] },
    { key: 'miles', label: 'Distance miles', c: ['distance miles', 'distance mi', 'distance'] },
    { key: 'instructions', label: 'Delivery instructions', c: ['delivery instructions', 'instructions'] },
    { key: 'tracking', label: 'DP tracking URL', c: ['dp tracking url', 'tracking url'] }
  ];

  // RFC 4180 CSV with delimiter sniffing (comma / semicolon / tab).
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/, 1)[0] || '';
    var delim = [',', ';', '\t'].map(function (d) { return [d, first.split(d).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], f = '', q = false, c;
    for (var i = 0; i < text.length; i++) {
      c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  // Which export is this? Lets either file go in either drop zone.
  function detectKind(headers) {
    var n = headers.map(norm);
    var has = function (h) { return n.indexOf(h) >= 0; };
    if (has('route id') && (has('service type') || has('agent name'))) return 'tookan';
    if (has('order ref') || has('dp cost')) return 'retool';
    return '';
  }

  function norm(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  function autoMap(headers, fields) {
    var n = headers.map(norm), used = {}, map = {};
    fields.forEach(function (f) {
      var hit = -1;
      f.c.some(function (c) {
        var i = n.findIndex(function (h, x) { return !used[x] && h === c; });
        if (i >= 0) { hit = i; return true; }
        return false;
      });
      if (hit < 0) {
        f.c.some(function (c) {
          if (c.length < 6) return false;
          var i = n.findIndex(function (h, x) { return !used[x] && h.indexOf(c) === 0; });
          if (i >= 0) { hit = i; return true; }
          return false;
        });
      }
      if (hit >= 0) { used[hit] = true; map[f.key] = headers[hit]; } else map[f.key] = '';
    });
    return map;
  }

  // Strip CSV-export artefacts: surrounding quotes and Excel's leading apostrophe ('+44…).
  function clean(v) {
    return String(v == null ? '' : v).replace(/^﻿/, '').trim().replace(/^"+|"+$/g, '').replace(/^'+/, '').trim();
  }

  function toObjects(headers, rows, mapping, fields) {
    var idx = {};
    fields.forEach(function (f) { idx[f.key] = mapping[f.key] ? headers.indexOf(mapping[f.key]) : -1; });
    return rows.map(function (r, i) {
      var o = { _row: i + 2 };
      fields.forEach(function (f) { o[f.key] = idx[f.key] >= 0 ? clean(r[idx[f.key]]) : ''; });
      return o;
    });
  }

  // ---------- normalisers ----------
  function normRef(v) { return clean(v).toUpperCase().replace(/\s+/g, ''); }
  function normName(v) { return clean(v).replace(/\s+/g, ' ').toLowerCase(); }

  // Phone → digits with optional leading +; UK numbers in readable groups.
  function phoneDigits(v) {
    var s = clean(v);
    var plus = /^\+/.test(s) || /^00/.test(s);
    var d = s.replace(/[^0-9]/g, '').replace(/^00/, '');
    if (!d) return '';
    if (!plus && /^0\d{9,10}$/.test(d)) return '+44' + d.slice(1); // UK national format
    return (plus ? '+' : '') + d;
  }
  function fmtPhone(v) {
    var p = phoneDigits(v);
    var m;
    if ((m = /^\+44(7\d{3})(\d{6})$/.exec(p))) return '+44 ' + m[1] + ' ' + m[2];
    if ((m = /^\+44(20)(\d{4})(\d{4})$/.exec(p))) return '+44 ' + m[1] + ' ' + m[2] + ' ' + m[3];
    if ((m = /^\+44(\d{4})(\d{6})$/.exec(p))) return '+44 ' + m[1] + ' ' + m[2];
    if ((m = /^\+44(\d{3})(\d{3})(\d{4})$/.exec(p))) return '+44 ' + m[1] + ' ' + m[2] + ' ' + m[3];
    return p || clean(v);
  }
  function parseMoney(v) {
    var s = clean(v).replace(/[£,\s]/g, '');
    if (s === '' || isNaN(s)) return null;
    return P.money(Number(s));
  }
  function parseNum(v) {
    var s = clean(v).replace(/[^0-9.\-]/g, '');
    return s === '' || isNaN(s) ? null : Number(s);
  }
  function serviceType(v) {
    var s = norm(v);
    if (/pick|collect/.test(s)) return 'PICKUP';
    if (/deliver|drop/.test(s)) return 'DELIVERY';
    return s.toUpperCase();
  }
  function fmtDuration(mins) {
    if (mins == null) return '';
    var h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return (h ? h + ' hr' + (h === 1 ? '' : 's') + ' ' : '') + m + ' min' + (m === 1 ? '' : 's');
  }

  var PREFERRED_DP = /dodo|evermile\s*own\s*fleet|evermileownfleet|own\s*fleet/i;
  function isCancelled(r) { return /cancel/i.test(r.orderStatus + ' ' + r.deliveryStatus); }

  // Pick the Retool row for one Tookan order on one agent's route.
  function pickRetool(candidates, agentName) {
    if (!candidates || !candidates.length) return null;
    var agent = normName(agentName);
    var best = null, bestScore = -1;
    candidates.forEach(function (r) {
      var score = (agent && normName(r.driver) === agent ? 4 : 0) + (PREFERRED_DP.test(r.dp) ? 2 : 0) + (isCancelled(r) ? 0 : 1);
      if (score > bestScore) { best = r; bestScore = score; }
    });
    return best;
  }

  /*
   * build(tookanRows, retoolRows, options) — rows are objects keyed by the field keys above.
   * options: { pricing, edits: { 'routeId|REF': { extra, remark } }, routeAdj: { routeId: { amount, remark } } }
   */
  function build(tookanRows, retoolRows, options) {
    options = options || {};
    var pricing = Object.assign({}, P.DEFAULT_CONFIG, options.pricing || {});
    var edits = options.edits || {};
    var routeAdj = options.routeAdj || {};

    var byRef = {};
    (retoolRows || []).forEach(function (r) {
      var k = normRef(r.ref);
      if (k) (byRef[k] = byRef[k] || []).push(r);
    });

    var routes = [], routeById = {}, unmatched = [], warnings = [];
    (tookanRows || []).forEach(function (t) {
      var rid = clean(t.routeId) || ('(no route) ' + clean(t.agentName));
      var route = routeById[rid];
      if (!route) {
        route = routeById[rid] = {
          routeId: rid, date: clean(t.date), agentId: clean(t.agentId), agentName: clean(t.agentName).replace(/\s+/g, ' '),
          estTimeMins: parseNum(t.estTime), estDistKm: parseNum(t.estDist),
          tasks: [], ordersByRef: {}, orders: []
        };
        routes.push(route);
      }
      route.tasks.push(t);
    });

    routes.forEach(function (route) {
      route.estTimeText = fmtDuration(route.estTimeMins);
      route.estDistText = route.estDistKm == null ? '' : route.estDistKm.toFixed(2) + ' KMS';

      // Resolve each distinct order once.
      route.tasks.forEach(function (t) {
        var k = normRef(t.orderId);
        if (!k || route.ordersByRef[k] !== undefined) return;
        var cands = byRef[k];
        if (!cands && k.charAt(0) === '#') cands = byRef[k.slice(1)];
        if (!cands && k.charAt(0) !== '#') cands = byRef['#' + k];
        var r = pickRetool(cands, route.agentName);
        if (!r) { route.ordersByRef[k] = null; return; }
        var e = edits[route.routeId + '|' + k] || {};
        var miles = parseNum(r.miles);
        var card = miles == null ? null : P.deliveryFee(miles, pricing);
        var dpCost = parseMoney(r.cost);
        var cost = dpCost != null ? dpCost : (card ? card.fee : null);
        var o = {
          key: route.routeId + '|' + k, ref: clean(t.orderId), refKey: k, retool: r,
          merchant: clean(r.merchant), customer: clean(r.customer), dp: clean(r.dp),
          status: clean(r.deliveryStatus || r.orderStatus), cancelled: isCancelled(r),
          retoolDriver: clean(r.driver), driverMatches: !r.driver || normName(r.driver) === normName(route.agentName),
          parcels: parseNum(r.parcels), instructions: clean(r.instructions), vehicle: clean(r.vehicle),
          pickupSlot: clean(r.pickupSlot), deliverySlot: clean(r.deliverySlot), tracking: clean(r.tracking),
          miles: miles, dpCost: dpCost, card: card, cardFee: card ? card.fee : null,
          cost: cost, costSource: dpCost != null ? 'retool' : (card ? 'card' : 'none'),
          diff: dpCost != null && card ? P.money(dpCost - card.fee) : null,
          extra: e.extra === '' || e.extra == null ? 0 : P.money(Number(e.extra) || 0),
          extraRaw: e.extra == null ? '' : e.extra, remark: e.remark || '',
          hasPickup: false, hasDelivery: false, duplicates: (cands || []).length
        };
        o.mismatch = o.diff != null && Math.abs(o.diff) > 0.01;
        o.total = o.cost == null ? null : P.money(o.cost + o.extra);
        route.ordersByRef[k] = o;
        route.orders.push(o);
      });

      // Stops in Tookan order; tasks whose order has no Retool match are skipped (and reported).
      var seen = {};
      route.stops = [];
      route.tasks.forEach(function (t) {
        var k = normRef(t.orderId);
        var o = route.ordersByRef[k];
        var type = serviceType(t.type);
        if (!o) {
          var uk = route.routeId + '|' + k;
          if (!seen[uk]) {
            seen[uk] = { routeId: route.routeId, agentName: route.agentName, orderId: clean(t.orderId) || '(blank)', types: [] };
            unmatched.push(seen[uk]);
          }
          seen[uk].types.push(type);
          return;
        }
        if (type === 'PICKUP') o.hasPickup = true;
        if (type === 'DELIVERY') o.hasDelivery = true;
        route.stops.push({
          type: type, ref: clean(t.orderId), order: o, taskId: clean(t.taskId),
          name: clean(t.name), address: clean(t.address).replace(/\s{2,}/g, ' '),
          phone: fmtPhone(t.phone), phoneTel: phoneDigits(t.phone), time: clean(t.time)
        });
      });
      route.stops.forEach(function (s, i) {
        s.seq = i + 1;
        // Pay shows once per order: on its DELIVERY row, or on the PICKUP row if there is no delivery.
        s.showCost = s.type === 'DELIVERY' || !s.order.hasDelivery;
        s.parcels = s.order.parcels;
        s.instructions = s.type === 'DELIVERY' || !s.order.hasDelivery ? s.order.instructions : '';
      });

      // Totals — each order counted once.
      var m = P.money;
      route.orderCount = route.orders.length;
      route.parcels = route.orders.reduce(function (a, o) { return a + (o.parcels || 0); }, 0);
      route.miles = m(route.orders.reduce(function (a, o) { return a + (o.miles || 0); }, 0));
      route.cost = m(route.orders.reduce(function (a, o) { return a + (o.cost || 0); }, 0));
      route.cardTotal = m(route.orders.reduce(function (a, o) { return a + (o.cardFee || 0); }, 0));
      route.extras = m(route.orders.reduce(function (a, o) { return a + o.extra; }, 0));
      var adj = routeAdj[route.routeId] || {};
      route.adjustment = adj.amount === '' || adj.amount == null ? 0 : m(Number(adj.amount) || 0);
      route.adjustmentRaw = adj.amount == null ? '' : adj.amount;
      route.adjustmentRemark = adj.remark || '';
      route.payable = m(route.cost + route.extras + route.adjustment);
      route.mismatches = route.orders.filter(function (o) { return o.mismatch; }).length;
      route.cardFallbacks = route.orders.filter(function (o) { return o.costSource === 'card'; }).length;
      route.unpriced = route.orders.filter(function (o) { return o.costSource === 'none'; }).length;
      route.vehicles = Object.keys(route.orders.reduce(function (a, o) { if (o.vehicle) a[o.vehicle] = 1; return a; }, {}));

      route.orders.forEach(function (o) {
        if (!o.driverMatches) warnings.push({ kind: 'driver', routeId: route.routeId, agentName: route.agentName, orderId: o.ref, text: 'Retool driver is "' + o.retoolDriver + '", Tookan agent is "' + route.agentName + '"' });
        if (o.cancelled) warnings.push({ kind: 'cancelled', routeId: route.routeId, agentName: route.agentName, orderId: o.ref, text: 'Retool status is ' + o.status });
        if (o.costSource === 'card') warnings.push({ kind: 'nocost', routeId: route.routeId, agentName: route.agentName, orderId: o.ref, text: 'No Retool DP cost; using card ' + P.fmt(o.cardFee) });
        if (o.costSource === 'none') warnings.push({ kind: 'unpriced', routeId: route.routeId, agentName: route.agentName, orderId: o.ref, text: 'No DP cost and no miles; not priced' });
        if (!o.hasPickup) warnings.push({ kind: 'single', routeId: route.routeId, agentName: route.agentName, orderId: o.ref, text: 'Delivery only (no pickup task in Tookan)' });
        if (!o.hasDelivery) warnings.push({ kind: 'single', routeId: route.routeId, agentName: route.agentName, orderId: o.ref, text: 'Pickup only (no delivery task in Tookan)' });
      });
      delete route.tasks;
    });

    var totals = routes.reduce(function (t, r) {
      t.routes++; t.stops += r.stops.length; t.orders += r.orderCount; t.parcels += r.parcels;
      t.cost += r.cost; t.cardTotal += r.cardTotal; t.payable += r.payable; t.mismatches += r.mismatches;
      return t;
    }, { routes: 0, stops: 0, orders: 0, parcels: 0, cost: 0, cardTotal: 0, payable: 0, mismatches: 0 });
    ['cost', 'cardTotal', 'payable'].forEach(function (k) { totals[k] = P.money(totals[k]); });

    return { routes: routes, unmatched: unmatched, warnings: warnings, totals: totals, pricing: pricing };
  }

  var api = {
    TOOKAN_FIELDS: TOOKAN_FIELDS, RETOOL_FIELDS: RETOOL_FIELDS,
    parseCSV: parseCSV, detectKind: detectKind, autoMap: autoMap, toObjects: toObjects, clean: clean, build: build,
    normRef: normRef, normName: normName, fmtPhone: fmtPhone, phoneDigits: phoneDigits,
    parseMoney: parseMoney, serviceType: serviceType, fmtDuration: fmtDuration, pickRetool: pickRetool
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DodoMerge = api;
})(typeof self !== 'undefined' ? self : this);
