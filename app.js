/* Dodo Driver Pay — app logic. Vanilla JS, no dependencies, works offline. */
(function () {
  'use strict';

  var P = window.DodoPricing;
  var LS = {
    settings: 'dodoPay.settings',
    session: 'dodoPay.session',
    roster: 'dodoPay.roster',
    geo: 'dodoPay.geoCache',
    dist: 'dodoPay.distCache',
    queue: 'dodoPay.queue',
    history: 'dodoPay.history'
  };

  // ---------- storage helpers ----------
  function load(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  var settings = Object.assign({
    scriptUrl: '', token: '', pricing: Object.assign({}, P.DEFAULT_CONFIG),
    roadDistance: true, straightFactor: 1.0, theme: ''
  }, load(LS.settings, {}));
  settings.pricing = Object.assign({}, P.DEFAULT_CONFIG, settings.pricing || {});

  var roster = load(LS.roster, []);
  var geoCache = load(LS.geo, {});
  var distCache = load(LS.dist, {});
  var queue = load(LS.queue, []);
  var history = load(LS.history, []);

  // Session: parsed file + edits.
  var S = Object.assign({
    fileName: '', headers: [], rows: [], mapping: {}, carrier: '', date: '', dateOverride: '',
    statuses: null, deliveries: [], routeAdj: {}, applied: false
  }, load(LS.session, {}));

  var view = { tab: 'upload', filter: 'all', search: '', selected: {}, lastClicked: null };
  var result = null; // output of P.calculate

  // ---------- small utils ----------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var gbp = P.fmt;
  function norm(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function normPostcode(pc) { return String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function prettyPostcode(pc) {
    var p = normPostcode(pc);
    return p.length > 3 ? p.slice(0, -3) + ' ' + p.slice(-3) : p;
  }
  function stripQuotes(v) { return String(v == null ? '' : v).trim().replace(/^"+|"+$/g, '').replace(/^'/, '').trim(); }
  var debounceTimers = {};
  function debounce(key, fn, ms) {
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(fn, ms || 300);
  }
  function persistSession() { debounce('session', function () { save(LS.session, S); }, 250); }

  function toast(html, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = html;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 6000);
  }

  // ---------- dates ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ymdLondon(d) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      var o = {};
      parts.forEach(function (p) { o[p.type] = p.value; });
      return o.year + '-' + o.month + '-' + o.day;
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }
  function parseDate(v) {
    var s = stripQuotes(v);
    if (!s) return '';
    var m;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { // ISO timestamp → London calendar date
      var d = new Date(s);
      return isNaN(d) ? '' : ymdLondon(d);
    }
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/))) { // UK day-first
      var y = m[3].length === 2 ? '20' + m[3] : m[3];
      return y + '-' + pad(m[2]) + '-' + pad(m[1]);
    }
    if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-](\d{4})/))) {
      var mi = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
      if (mi >= 0) return m[3] + '-' + pad(mi + 1) + '-' + pad(m[1]);
    }
    var t = new Date(s);
    return isNaN(t) ? '' : ymdLondon(t);
  }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function tabLabel(ymd) { // 2026-10-19 → 19-Oct-2026
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? m[3] + '-' + MONTHS[Number(m[2]) - 1] + '-' + m[1] : 'Undated';
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    var first = text.split(/\r?\n/, 1)[0] || '';
    var delim = [',', ';', '\t'].map(function (d) { return [d, first.split(d).length]; })
      .sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], field = '', q = false, i = 0, c;
    for (; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (v) {
        v = v == null ? '' : String(v);
        return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n');
  }
  function download(name, text) {
    var blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- column mapping ----------
  var FIELDS = [
    { key: 'orderId', label: 'Order ID', req: true, cands: ['external id', 'order id', 'order no', 'order number', 'order', 'order id 1', 'order_id'] },
    { key: 'merchant', label: 'Merchant', cands: ['merchant name', 'merchant', 'store', 'shop'] },
    { key: 'customer', label: 'Customer', cands: ['customer name', 'customer', 'recipient'] },
    { key: 'date', label: 'Delivery date', cands: ['commited delivery window start', 'committed delivery window start', 'delivery date', 'date', 'day', 'actual', 'delivery before', 'dropoff time', 'collection time', 'creation time'] },
    { key: 'distance', label: 'Distance', cands: ['distance mi', 'distance miles', 'distance', 'miles', 'distance km', 'mileage'] },
    { key: 'pickup', label: 'Pickup postcode', cands: ['pickup postcode', 'pick up postcode', 'collection postcode', 'pickup post code', 'from postcode'] },
    { key: 'dropoff', label: 'Drop-off postcode', cands: ['dropoff postcode', 'drop off postcode', 'delivery postcode', 'customer postcode', 'postcode', 'to postcode'] },
    { key: 'driver', label: 'Driver (if present)', cands: ['agent name', 'driver', 'driver name', 'courier', 'courier name', 'rider', 'agent'] },
    { key: 'carrier', label: 'Carrier', cands: ['carrier', 'delivery partner', 'partner'] },
    { key: 'status', label: 'Status', cands: ['delivery status', 'status', 'order status'] },
    { key: 'route', label: 'Route', cands: ['route external id', 'route', 'route id', 'route name'] }
  ];

  function autoMap(headers) {
    var n = headers.map(norm);
    var used = {};
    var map = {};
    FIELDS.forEach(function (f) {
      var hit = -1;
      f.cands.some(function (c) {
        var i = n.findIndex(function (h, idx) { return !used[idx] && h === c; });
        if (i >= 0) { hit = i; return true; }
        return false;
      });
      if (hit < 0) {
        f.cands.some(function (c) {
          if (c.length < 5) return false;
          var i = n.findIndex(function (h, idx) { return !used[idx] && h.indexOf(c) >= 0; });
          if (i >= 0) { hit = i; return true; }
          return false;
        });
      }
      if (hit >= 0) { used[hit] = true; map[f.key] = headers[hit]; } else map[f.key] = '';
    });
    return map;
  }

  function col(row, key) {
    var h = S.mapping[key];
    if (!h) return '';
    var i = S.headers.indexOf(h);
    return i >= 0 ? (row[i] == null ? '' : row[i]) : '';
  }

  function isKm() { return /\bkm\b|kilomet/i.test(S.mapping.distance || ''); }

  function rowDate(row) {
    var d = S.mapping.date ? parseDate(col(row, 'date')) : '';
    return d || S.dateOverride || '';
  }

  function isCancelled(s) { return /cancel/i.test(s || ''); }

  // ---------- load file ----------
  function loadText(text, name) {
    var rows = parseCSV(text);
    if (rows.length < 2) { toast('That file has no data rows.', 'bad'); return; }
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var body = rows.slice(1).filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
    var hadEdits = S.deliveries && S.deliveries.length;
    if (hadEdits && !confirm('Replace the current data (' + S.deliveries.length + ' deliveries, driver assignments and extras)?')) return;
    S = {
      fileName: name, headers: headers, rows: body, mapping: autoMap(headers), carrier: '', date: '',
      dateOverride: '', statuses: null, deliveries: [], routeAdj: {}, applied: false
    };
    view.selected = {};
    initFilters();
    persistSession();
    renderUpload();
    renderAll();
  }

  function initFilters() {
    var carriers = distinct('carrier');
    var dodo = carriers.filter(function (c) { return /dodo/i.test(c); })[0];
    S.carrier = dodo || '';
    var statuses = distinct('status');
    S.statuses = statuses.filter(function (s) { return !isCancelled(s); });
    var dates = dateCounts();
    var best = Object.keys(dates).sort(function (a, b) { return dates[b] - dates[a]; })[0];
    S.date = Object.keys(dates).length > 1 ? best : '';
    if (!S.mapping.date) S.dateOverride = S.dateOverride || ymdLondon(new Date());
  }

  function distinct(key) {
    if (!S.mapping[key]) return [];
    var seen = {};
    S.rows.forEach(function (r) { var v = stripQuotes(col(r, key)); if (v) seen[v] = (seen[v] || 0) + 1; });
    return Object.keys(seen).sort();
  }

  function dateCounts(ignoreDate) {
    var out = {};
    S.rows.forEach(function (r) {
      if (!passesFilters(r, true)) return;
      var d = rowDate(r) || '';
      out[d] = (out[d] || 0) + 1;
    });
    return out;
  }

  function passesFilters(r, ignoreDate) {
    if (S.carrier && S.mapping.carrier && stripQuotes(col(r, 'carrier')) !== S.carrier) return false;
    if (S.statuses && S.mapping.status) {
      var st = stripQuotes(col(r, 'status'));
      if (st && S.statuses.indexOf(st) < 0) return false;
    }
    if (!ignoreDate && S.date && rowDate(r) !== S.date) return false;
    return true;
  }

  // Build deliveries from rows + mapping, keeping edits made earlier.
  function applyMapping() {
    var prev = {};
    (S.deliveries || []).forEach(function (d) { prev[d.key] = d; });
    var seenKeys = {};
    var out = [];
    S.rows.forEach(function (r, idx) {
      if (!passesFilters(r)) return;
      var id = stripQuotes(col(r, 'orderId')) || ('row ' + (idx + 2));
      var key = id;
      if (seenKeys[key]) key = id + '#' + idx;
      seenKeys[key] = true;
      var rawDist = stripQuotes(col(r, 'distance')).replace(/[^0-9.\-]/g, '');
      var csvDist = rawDist !== '' && !isNaN(rawDist) ? Number(rawDist) * (isKm() ? 0.621371 : 1) : null;
      var p = prev[key] || {};
      var d = {
        key: key,
        id: id,
        row: idx,
        merchant: stripQuotes(col(r, 'merchant')),
        customer: stripQuotes(col(r, 'customer')),
        date: rowDate(r),
        pickup: prettyPostcode(col(r, 'pickup')),
        dropoff: prettyPostcode(col(r, 'dropoff')),
        route: stripQuotes(col(r, 'route')),
        status: stripQuotes(col(r, 'status')),
        driver: p.driver != null ? p.driver : stripQuotes(col(r, 'driver')),
        extra: p.extra || '',
        remark: p.remark || '',
        distance: null,
        distanceSource: 'missing'
      };
      if (p.distanceSource === 'manual') {
        d.distance = p.distance; d.distanceSource = 'manual';
      } else if (csvDist !== null) {
        d.distance = Math.round(csvDist * 100) / 100; d.distanceSource = 'csv';
      } else {
        var c = distCache[pairKey(d.pickup, d.dropoff)];
        if (c) { d.distance = c.mi; d.distanceSource = c.src; }
      }
      if (d.driver) addToRoster(d.driver);
      out.push(d);
    });
    S.deliveries = out;
    S.applied = true;
    persistSession();
  }

  function addToRoster(name) {
    name = String(name || '').trim();
    if (!name) return;
    if (roster.some(function (r) { return r.toLowerCase() === name.toLowerCase(); })) return;
    roster.push(name);
    roster.sort(function (a, b) { return a.localeCompare(b); });
    save(LS.roster, roster);
  }
  function canonicalDriver(name) {
    name = String(name || '').trim().replace(/\s+/g, ' ');
    var hit = roster.filter(function (r) { return r.toLowerCase() === name.toLowerCase(); })[0];
    return hit || name;
  }

  // ---------- distances ----------
  function pairKey(a, b) { return normPostcode(a) + '>' + normPostcode(b); }

  function haversineMiles(a, b) {
    var R = 3958.7613, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function fetchJSON(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 20000) : null;
    return fetch(url, Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {}))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(function () { if (t) clearTimeout(t); });
  }

  function geocode(postcodes) {
    var need = postcodes.filter(function (p) { return p && !geoCache[normPostcode(p)]; });
    var chunks = [];
    for (var i = 0; i < need.length; i += 100) chunks.push(need.slice(i, i + 100));
    return chunks.reduce(function (pr, chunk) {
      return pr.then(function () {
        return fetchJSON('https://api.postcodes.io/postcodes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postcodes: chunk })
        }).then(function (j) {
          (j.result || []).forEach(function (x) {
            if (x.result) geoCache[normPostcode(x.query)] = [x.result.latitude, x.result.longitude];
          });
        });
      });
    }, Promise.resolve()).then(function () {
      // Terminated postcodes are not in the bulk endpoint; try them one by one.
      var missing = need.filter(function (p) { return !geoCache[normPostcode(p)]; });
      return Promise.all(missing.map(function (p) {
        return fetchJSON('https://api.postcodes.io/terminated_postcodes/' + encodeURIComponent(normPostcode(p)))
          .then(function (j) { if (j.result) geoCache[normPostcode(p)] = [j.result.latitude, j.result.longitude]; })
          .catch(function () {});
      }));
    }).then(function () { save(LS.geo, geoCache); });
  }

  // OSRM table: one pickup → many drop-offs per request.
  function roadDistances(pickup, drops) {
    var from = geoCache[normPostcode(pickup)];
    var out = {};
    var chunks = [];
    for (var i = 0; i < drops.length; i += 80) chunks.push(drops.slice(i, i + 80));
    return chunks.reduce(function (pr, chunk) {
      return pr.then(function () {
        var coords = [from].concat(chunk.map(function (d) { return geoCache[normPostcode(d)]; }));
        var path = coords.map(function (c) { return c[1].toFixed(6) + ',' + c[0].toFixed(6); }).join(';');
        var dest = chunk.map(function (_, k) { return k + 1; }).join(';');
        var url = 'https://router.project-osrm.org/table/v1/driving/' + path +
          '?sources=0&destinations=' + dest + '&annotations=distance';
        return fetchJSON(url, null, 30000).then(function (j) {
          var row = (j.distances || [])[0] || [];
          chunk.forEach(function (d, k) {
            if (row[k] != null) out[normPostcode(d)] = row[k] / 1609.344;
          });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  var distRunning = false;
  function calculateDistances(force) {
    if (distRunning) return;
    var targets = S.deliveries.filter(function (d) {
      return d.distanceSource !== 'csv' && d.distanceSource !== 'manual' && (force || d.distance == null) && d.pickup && d.dropoff;
    });
    var noPc = S.deliveries.filter(function (d) { return d.distance == null && (!d.pickup || !d.dropoff); }).length;
    if (!targets.length) {
      setDistStatus(noPc ? '<div class="notice warn">' + noPc + ' deliveries have no postcodes — type the miles in manually.</div>' : '');
      return;
    }
    if (!navigator.onLine) {
      setDistStatus('<div class="notice warn">Offline — ' + targets.length + ' distances can\'t be looked up now. Enter miles manually, or click “Calculate distances” when back online.</div>');
      return;
    }
    distRunning = true;
    setDistStatus('<div class="notice">Looking up ' + targets.length + ' distances…</div>');
    var pcs = {};
    targets.forEach(function (d) { pcs[d.pickup] = 1; pcs[d.dropoff] = 1; });
    var roadFailed = false;
    geocode(Object.keys(pcs)).then(function () {
      if (!settings.roadDistance) return {};
      var byPickup = {};
      targets.forEach(function (d) {
        if (!geoCache[normPostcode(d.pickup)] || !geoCache[normPostcode(d.dropoff)]) return;
        (byPickup[d.pickup] = byPickup[d.pickup] || {})[d.dropoff] = 1;
      });
      var res = {};
      return Object.keys(byPickup).reduce(function (pr, pu) {
        return pr.then(function () {
          return roadDistances(pu, Object.keys(byPickup[pu])).then(function (m) {
            Object.keys(m).forEach(function (k) { res[normPostcode(pu) + '>' + k] = m[k]; });
          }).catch(function () { roadFailed = true; });
        });
      }, Promise.resolve()).then(function () { return res; });
    }).then(function (road) {
      var done = 0, failed = 0;
      targets.forEach(function (d) {
        var k = pairKey(d.pickup, d.dropoff);
        var a = geoCache[normPostcode(d.pickup)], b = geoCache[normPostcode(d.dropoff)];
        if (road[k] != null) {
          distCache[k] = { mi: Math.round(road[k] * 100) / 100, src: 'road' };
        } else if (a && b) {
          distCache[k] = { mi: Math.round(haversineMiles(a, b) * (Number(settings.straightFactor) || 1) * 100) / 100, src: 'straight' };
        } else { failed++; return; }
        d.distance = distCache[k].mi;
        d.distanceSource = distCache[k].src;
        done++;
      });
      save(LS.dist, distCache);
      persistSession();
      var msg = '<div class="notice ok">Distances found for ' + done + ' deliveries.</div>';
      if (roadFailed || targets.some(function (d) { return d.distanceSource === 'straight'; })) {
        msg += '<div class="notice warn">Road routing was unavailable for some — those use a straight-line estimate (marked “est.”). Check them before paying.</div>';
      }
      if (failed) msg += '<div class="notice bad">' + failed + ' postcodes couldn\'t be found — enter miles manually.</div>';
      setDistStatus(msg);
      renderAll();
    }).catch(function (e) {
      setDistStatus('<div class="notice bad">Distance lookup failed (' + esc(e.message) + '). Enter miles manually or try again.</div>');
    }).finally(function () { distRunning = false; });
  }
  function setDistStatus(html) { $('#distStatus').innerHTML = html; }

  // ---------- calculation ----------
  function recalc() {
    var dels = S.deliveries.map(function (d) {
      return { key: d.key, id: d.id, date: d.date, driver: d.driver, distance: d.distance, extra: d.extra, remark: d.remark,
        merchant: d.merchant, customer: d.customer, pickup: d.pickup, dropoff: d.dropoff, route: d.route,
        distanceSource: d.distanceSource, status: d.status };
    });
    result = P.calculate(dels, settings.pricing, S.routeAdj);
    return result;
  }

  // ---------- rendering ----------
  function renderAll() {
    recalc();
    renderFormula();
    renderActionBar();
    if (view.tab === 'deliveries') renderDeliveries();
    if (view.tab === 'routes') renderRoutes();
    if (view.tab === 'sheets') renderSheets();
    renderQueuePill();
  }

  function renderFormula() {
    $('#formulaText').textContent = P.describe(settings.pricing);
    $$('[data-cfg]').forEach(function (el) {
      var k = el.getAttribute('data-cfg');
      el.textContent = k === 'bandMiles' ? settings.pricing[k] : gbp(settings.pricing[k]);
    });
    $('#bandTable').innerHTML = P.bandTable(30, settings.pricing).map(function (b) {
      return '<div><span>' + b.from.toFixed(1) + '–' + b.to.toFixed(1) + '</span><b class="num">' + gbp(b.fee) + '</b></div>';
    }).join('');
  }

  function renderActionBar() {
    $('#abDeliveries').textContent = result.deliveries.length;
    $('#abUnassigned').textContent = result.unassigned;
    $('#abUnpriced').textContent = result.unpriced;
    $('#abDrivers').textContent = result.drivers.length;
    $('#abTotal').textContent = gbp(result.totals.payable);
    $('#abUnassigned').style.color = result.unassigned ? 'var(--warn)' : '';
    $('#abUnpriced').style.color = result.unpriced ? 'var(--bad)' : '';
  }

  function renderUpload() {
    var has = S.headers && S.headers.length;
    $('#mappingCard').classList.toggle('hidden', !has);
    $('#fileInfo').classList.toggle('hidden', !has);
    if (!has) return;
    $('#fileInfo').innerHTML = '<b>' + esc(S.fileName) + '</b> — ' + S.rows.length + ' rows, ' + S.headers.length + ' columns';
    var opts = function (sel) {
      return '<option value="">— none —</option>' + S.headers.map(function (h) {
        return '<option' + (h === sel ? ' selected' : '') + '>' + esc(h) + '</option>';
      }).join('');
    };
    $('#mappingGrid').innerHTML = FIELDS.map(function (f) {
      return '<label class="field">' + esc(f.label) + (f.req ? ' *' : '') +
        '<select data-map="' + f.key + '">' + opts(S.mapping[f.key]) + '</select></label>';
    }).join('');
    renderFilters();
  }

  function renderFilters() {
    var carriers = distinct('carrier');
    $('#fCarrier').innerHTML = '<option value="">All carriers</option>' + carriers.map(function (c) {
      return '<option' + (c === S.carrier ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    $('#fCarrier').disabled = !S.mapping.carrier;

    var dc = dateCounts();
    var keys = Object.keys(dc).sort();
    $('#fDate').innerHTML = '<option value="">All dates (' + keys.reduce(function (s, k) { return s + dc[k]; }, 0) + ')</option>' +
      keys.map(function (k) {
        return '<option value="' + esc(k) + '"' + (k === S.date ? ' selected' : '') + '>' + esc(k ? tabLabel(k) : 'No date') + ' (' + dc[k] + ')</option>';
      }).join('');
    $('#fDateOverrideWrap').classList.toggle('hidden', !!S.mapping.date);
    $('#fDateOverride').value = S.dateOverride || '';

    var statuses = distinct('status');
    $('#fStatuses').innerHTML = statuses.length ? statuses.map(function (s) {
      var on = !S.statuses || S.statuses.indexOf(s) >= 0;
      return '<label class="row small" style="gap:4px;margin-right:10px"><input type="checkbox" data-status="' + esc(s) + '"' + (on ? ' checked' : '') + '>' + esc(s) + '</label>';
    }).join('') : '<span class="small muted">No status column</span>';

    var n = S.rows.filter(function (r) { return passesFilters(r); }).length;
    $('#includeCount').textContent = n + ' of ' + S.rows.length + ' rows will be included';

    var notes = [];
    if (!S.mapping.orderId) notes.push('<div class="notice warn">Pick the Order ID column.</div>');
    if (!S.mapping.distance && !(S.mapping.pickup && S.mapping.dropoff)) {
      notes.push('<div class="notice warn">No distance or postcode columns found — you\'ll need to enter miles for each delivery.</div>');
    } else if (!S.mapping.distance) {
      notes.push('<div class="notice">No distance column — distances will be calculated from pickup &amp; drop-off postcodes (road distance). For exact parity with Evermile, include a distance column in the export.</div>');
    }
    if (keys.length > 1) {
      notes.push('<div class="notice">This file has ' + keys.length + ' delivery dates. ' +
        (S.date ? 'Showing <b>' + tabLabel(S.date) + '</b> only.' : 'All dates included — each date gets its own Google Sheets tab.') + '</div>');
    }
    $('#mappingNotice').innerHTML = notes.join('');
  }

  function matchesView(d) {
    if (view.filter === 'unassigned' && d.driver) return false;
    if (view.filter === 'nodist' && d.fee != null) return false;
    if (view.search) {
      var s = view.search.toLowerCase();
      var hay = [d.id, d.merchant, d.customer, d.pickup, d.dropoff, d.driver, d.route, d.remark].join(' ').toLowerCase();
      if (hay.indexOf(s) < 0) return false;
    }
    return true;
  }

  var SRC_LABEL = { csv: 'CSV', road: 'road', straight: 'est.', manual: 'manual', missing: 'missing' };
  var SRC_TITLE = {
    csv: 'Distance taken from the uploaded file',
    road: 'Road distance from OpenStreetMap routing (pickup → drop-off)',
    straight: 'Straight-line estimate — check before paying',
    manual: 'Entered manually',
    missing: 'No distance yet'
  };

  function renderDeliveries() {
    var rows = result.deliveries;
    var visible = rows.filter(matchesView);
    $('#driverList').innerHTML = roster.map(function (r) { return '<option value="' + esc(r) + '">'; }).join('');
    var multiDate = Object.keys(rows.reduce(function (o, d) { o[d.date] = 1; return o; }, {})).length > 1;
    var html = visible.map(function (d) {
      var p = d.pricing;
      var sel = view.selected[d.key];
      var feeCell = p.ok
        ? '<b>' + gbp(p.fee) + '</b>' + (p.atFloor ? '<span class="badge floor" title="Below minimum">min</span>' : '') +
          '<span class="sub">' + p.bandedMiles.toFixed(1) + ' mi × ' + gbp(settings.pricing.perMile) + ' + ' + gbp(settings.pricing.base) + ' = ' + gbp(p.card) + '</span>'
        : '<span class="badge missing">no distance</span>';
      return '<tr data-key="' + esc(d.key) + '" class="' + (sel ? 'selected' : '') + '" title="' + esc(p.breakdown) + '">' +
        '<td><input type="checkbox" class="sel"' + (sel ? ' checked' : '') + ' aria-label="Select ' + esc(d.id) + '"></td>' +
        '<td><b>' + esc(d.id) + '</b>' + (multiDate ? '<span class="sub">' + esc(tabLabel(d.date)) + '</span>' : '') +
          (d.route ? '<span class="sub">' + esc(d.route) + '</span>' : '') + '</td>' +
        '<td>' + esc(d.merchant) + '<span class="sub">' + esc(d.customer) + '</span></td>' +
        '<td class="small">' + esc(d.pickup || '—') + ' → ' + esc(d.dropoff || '—') + '</td>' +
        '<td class="num"><input class="dist" type="number" step="0.01" min="0" value="' + (d.distance == null ? '' : d.distance) + '" aria-label="Distance">' +
          '<span class="badge ' + d.distanceSource + '" title="' + SRC_TITLE[d.distanceSource] + '">' + SRC_LABEL[d.distanceSource] + '</span></td>' +
        '<td><input class="driver" list="driverList" value="' + esc(d.driver) + '" placeholder="Assign…" aria-label="Driver"></td>' +
        '<td class="num">' + feeCell + '</td>' +
        '<td class="num"><input class="money extra" type="number" step="0.01" value="' + (d.extra ? d.extra : '') + '" placeholder="0.00" aria-label="Extra charge"></td>' +
        '<td><input class="remark" value="' + esc(d.remark) + '" placeholder="Remark" aria-label="Remark"></td>' +
        '<td class="num"><b>' + (d.dropTotal == null ? '—' : gbp(d.dropTotal)) + '</b></td>' +
        '</tr>';
    }).join('');
    if (!rows.length) html = '<tr><td colspan="10" class="muted" style="padding:24px;text-align:center">Upload a CSV in step 1 to get started.</td></tr>';
    else if (!visible.length) html = '<tr><td colspan="10" class="muted" style="padding:24px;text-align:center">Nothing matches this filter.</td></tr>';
    $('#delTable tbody').innerHTML = html;
    var nSel = Object.keys(view.selected).filter(function (k) { return view.selected[k]; }).length;
    $('#selCount').textContent = nSel + ' selected';
    $('#selAll').checked = visible.length > 0 && visible.every(function (d) { return view.selected[d.key]; });
    $$('#viewFilter button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.f === view.filter)); });
  }

  function renderRoutes() {
    var t = result.totals;
    $('#stats').innerHTML = [
      ['Drivers', result.drivers.length], ['Routes', result.routes.length], ['Drops', t.drops],
      ['Delivery fees', gbp(t.fees)], ['Extras & adjustments', gbp(t.extras + t.dropBonus + t.adjustments)],
      ['Total payable', gbp(t.payable)]
    ].map(function (s) { return '<div class="stat"><div class="k">' + s[0] + '</div><div class="v">' + s[1] + '</div></div>'; }).join('');

    var warn = '';
    if (result.unassigned) warn += '<div class="notice warn">' + result.unassigned + ' deliveries have no driver and are not in any total.</div>';
    if (result.unpriced) warn += '<div class="notice bad">' + result.unpriced + ' deliveries have no distance and are priced at £0 until you add miles.</div>';
    var showBonus = settings.pricing.extraDropFee > 0;

    $('#driverTable').innerHTML =
      '<thead><tr><th>Driver</th><th class="num">Routes</th><th class="num">Drops</th><th class="num">Miles</th>' +
      '<th class="num">Delivery fees</th><th class="num">Extra charges</th>' + (showBonus ? '<th class="num">Multi-drop</th>' : '') +
      '<th class="num">Route adj.</th><th>Remarks</th><th class="num">Final payable</th></tr></thead><tbody>' +
      result.drivers.map(function (d) {
        return '<tr><td><b>' + esc(d.driver) + '</b>' + (d.unpriced ? ' <span class="badge missing">' + d.unpriced + ' unpriced</span>' : '') + '</td>' +
          '<td class="num">' + d.routes + '</td><td class="num">' + d.drops + '</td><td class="num">' + d.miles.toFixed(2) + '</td>' +
          '<td class="num">' + gbp(d.fees) + '</td><td class="num">' + gbp(d.extras) + '</td>' +
          (showBonus ? '<td class="num">' + gbp(d.dropBonus) + '</td>' : '') +
          '<td class="num">' + gbp(d.adjustment) + '</td><td class="small">' + esc(d.adjustmentRemark) + '</td>' +
          '<td class="num"><b>' + gbp(d.payable) + '</b></td></tr>';
      }).join('') +
      (result.drivers.length ? '' : '<tr><td colspan="10" class="muted" style="padding:20px;text-align:center">Assign drivers in step 2.</td></tr>') +
      '</tbody><tfoot><tr><td>Total</td><td></td><td class="num">' + t.drops + '</td><td></td><td class="num">' + gbp(t.fees) + '</td>' +
      '<td class="num">' + gbp(t.extras) + '</td>' + (showBonus ? '<td class="num">' + gbp(t.dropBonus) + '</td>' : '') +
      '<td class="num">' + gbp(t.adjustments) + '</td><td></td><td class="num">' + gbp(t.payable) + '</td></tr></tfoot>';

    var open = {};
    $$('#routeList details[open]').forEach(function (d) { open[d.dataset.key] = 1; });
    $('#routeList').innerHTML = warn + result.routes.map(function (r) {
      var adj = S.routeAdj[r.key] || {};
      return '<details class="route" data-key="' + esc(r.key) + '"' + (open[r.key] ? ' open' : '') + '>' +
        '<summary><span class="chev">▶</span><span class="who">' + esc(r.driver) + '<span class="sub">' + esc(tabLabel(r.date)) + '</span></span>' +
        '<span><b>' + r.drops + '</b> drops</span><span>' + r.miles.toFixed(2) + ' mi</span>' +
        '<span class="muted">fees ' + gbp(r.fees) + '</span>' +
        (r.extras ? '<span class="muted">extras ' + gbp(r.extras) + '</span>' : '') +
        (r.dropBonus ? '<span class="muted">multi-drop ' + gbp(r.dropBonus) + '</span>' : '') +
        (r.adjustment ? '<span class="muted">adj. ' + gbp(r.adjustment) + '</span>' : '') +
        '<span class="spacer"></span><b class="num" style="font-size:16px">' + gbp(r.total) + '</b></summary>' +
        '<div class="body"><div class="table-wrap" style="border:0;border-radius:0"><table><thead><tr>' +
        '<th>#</th><th>Order</th><th>Merchant</th><th>Drop-off</th><th class="num">Miles</th><th>Calculation</th>' +
        '<th class="num">Fee</th><th class="num">Extra</th><th>Remark</th><th class="num">Total</th></tr></thead><tbody>' +
        r.deliveries.map(function (d, i) {
          return '<tr><td class="muted">' + (i + 1) + '</td><td>' + esc(d.id) + '</td><td>' + esc(d.merchant) + '</td>' +
            '<td>' + esc(d.dropoff) + '</td><td class="num">' + (d.distance == null ? '—' : d.distance.toFixed(2)) + '</td>' +
            '<td class="small">' + esc(d.pricing.breakdown) + '</td><td class="num">' + (d.fee == null ? '—' : gbp(d.fee)) + '</td>' +
            '<td class="num">' + (d.extra ? gbp(d.extra) : '') + '</td><td class="small">' + esc(d.remark) + '</td>' +
            '<td class="num"><b>' + (d.dropTotal == null ? '—' : gbp(d.dropTotal)) + '</b></td></tr>';
        }).join('') +
        '</tbody><tfoot><tr><td></td><td colspan="3">Route subtotal (' + r.drops + ' drops)</td><td class="num">' + r.miles.toFixed(2) + '</td><td></td>' +
        '<td class="num">' + gbp(r.fees) + '</td><td class="num">' + gbp(r.extras) + '</td><td></td><td class="num">' + gbp(r.fees + r.extras) + '</td></tr></tfoot></table></div>' +
        '<div class="adj"><span class="small" style="font-weight:600">Route extra / adjustment £</span>' +
        '<input class="money radj" type="number" step="0.01" value="' + (adj.amount || '') + '" placeholder="0.00" data-key="' + esc(r.key) + '">' +
        '<input class="remark rremark" value="' + esc(adj.remark || '') + '" placeholder="Reason (e.g. waiting time)" data-key="' + esc(r.key) + '" style="flex:1;min-width:180px">' +
        '<span class="small muted">Use a negative amount for deductions.</span></div></div></details>';
    }).join('') + (result.routes.length ? '' : '<p class="muted">No routes yet — assign drivers in step 2.</p>');
  }

  function renderSheets() {
    var ok = settings.scriptUrl && settings.token;
    $('#sheetsStatus').innerHTML = ok
      ? '<div class="notice ok">Connected to Apps Script endpoint. <span class="small">(' + esc(settings.scriptUrl.slice(0, 60)) + '…)</span></div>'
      : '<div class="notice warn">Not connected yet. Open <b>Settings</b> and paste your Apps Script Web App URL and token (see README).</div>';
    $('#queueList').innerHTML = queue.length ? '<div class="table-wrap"><table><thead><tr><th>Tab</th><th class="num">Rows</th><th>Queued</th><th>Status</th><th></th></tr></thead><tbody>' +
      queue.map(function (q) {
        return '<tr><td><b>' + esc(q.tabName) + '</b></td><td class="num">' + q.count + '</td><td class="small">' + esc(new Date(q.createdAt).toLocaleString('en-GB')) + '</td>' +
          '<td class="small">' + esc(q.error ? 'Error: ' + q.error : (navigator.onLine ? 'Waiting to sync' : 'Waiting for connection')) + '</td>' +
          '<td><button class="btn ghost danger small" data-dequeue="' + esc(q.id) + '" type="button">Remove</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted" style="margin:0">Nothing queued.</p>';
    $('#historyList').innerHTML = history.length ? '<div class="table-wrap"><table><thead><tr><th>Tab</th><th>Action</th><th class="num">Deliveries</th><th class="num">Total</th><th>When</th><th></th></tr></thead><tbody>' +
      history.slice(0, 50).map(function (h) {
        return '<tr><td><b>' + esc(h.tabName) + '</b></td><td>' + esc(h.mode) + '</td><td class="num">' + h.count + '</td><td class="num">' + esc(h.total || '') + '</td>' +
          '<td class="small">' + esc(new Date(h.at).toLocaleString('en-GB')) + '</td>' +
          '<td>' + (h.url ? '<a href="' + esc(h.url) + '" target="_blank" rel="noopener">Open tab ↗</a>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted" style="margin:0">No uploads yet.</p>';
  }

  function renderNet() {
    var on = navigator.onLine;
    var pill = $('#netPill');
    pill.className = 'pill ' + (on ? 'ok' : 'bad');
    pill.lastElementChild.textContent = on ? 'Online' : 'Offline';
  }
  function renderQueuePill() {
    var p = $('#queuePill');
    p.classList.toggle('hidden', !queue.length);
    p.lastElementChild.textContent = queue.length + ' upload' + (queue.length > 1 ? 's' : '') + ' queued';
  }

  // ---------- Google Sheets payload ----------
  function buildPayloads() {
    var r = recalc();
    var dates = {};
    r.deliveries.forEach(function (d) { (dates[d.date] = dates[d.date] || []).push(d); });
    var formula = P.describe(settings.pricing);
    return Object.keys(dates).sort().map(function (date) {
      var dels = dates[date];
      var routes = r.routes.filter(function (x) { return x.date === date; });
      var drivers = {};
      routes.forEach(function (x) {
        var o = drivers[x.driver] = drivers[x.driver] || { routes: 0, drops: 0, miles: 0, fees: 0, extras: 0, bonus: 0, adj: 0, remarks: [], total: 0 };
        o.routes++; o.drops += x.drops; o.miles += x.miles; o.fees += x.fees; o.extras += x.extras;
        o.bonus += x.dropBonus; o.adj += x.adjustment; o.total += x.total;
        if (x.adjustmentRemark) o.remarks.push(x.adjustmentRemark);
      });
      var m = P.money;
      var driverRows = Object.keys(drivers).sort().map(function (name) {
        var o = drivers[name];
        return [name, o.routes, o.drops, m(o.miles), m(o.fees), m(o.extras), m(o.bonus), m(o.adj), o.remarks.join('; '), m(o.total)];
      });
      var sum = function (rows, i) { return m(rows.reduce(function (s, x) { return s + (Number(x[i]) || 0); }, 0)); };
      var routeRows = routes.map(function (x) {
        return [tabLabel(x.date), x.driver, x.drops, x.miles, x.fees, x.extras, x.dropBonus, x.adjustment, x.adjustmentRemark, x.total];
      });
      var sorted = dels.slice().sort(function (a, b) {
        if (!a.driver !== !b.driver) return a.driver ? -1 : 1; // unassigned last
        return (a.driver || '').localeCompare(b.driver || '') || String(a.id).localeCompare(String(b.id));
      });
      var delRows = sorted.map(function (d) {
        var p = d.pricing;
        return [
          tabLabel(d.date), d.driver || '(unassigned)', d.id, d.merchant, d.customer, d.pickup, d.dropoff, d.route,
          d.distance == null ? '' : d.distance, SRC_LABEL[d.distanceSource] || '',
          p.ok ? p.bandedMiles : '', p.ok ? settings.pricing.base : '', p.ok ? p.mileage : '', p.ok ? p.card : '',
          p.ok ? (p.atFloor ? 'Yes' : 'No') : '', d.fee == null ? '' : d.fee, d.extra || 0, d.remark, d.dropTotal == null ? '' : d.dropTotal,
          p.breakdown
        ];
      });
      var total = sum(driverRows, 9);
      return {
        tabName: tabLabel(date),
        count: dels.length,
        total: gbp(total),
        body: {
          meta: {
            formula: formula,
            generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }),
            sourceFile: S.fileName,
            totalPayable: total
          },
          drivers: {
            header: ['Driver', 'Routes', 'Drops', 'Miles', 'Delivery fees £', 'Extra charges £', 'Multi-drop £', 'Route adjustments £', 'Remarks', 'Final payable £'],
            rows: driverRows,
            totals: ['TOTAL', sum(driverRows, 1), sum(driverRows, 2), sum(driverRows, 3), sum(driverRows, 4), sum(driverRows, 5), sum(driverRows, 6), sum(driverRows, 7), '', total],
            money: [4, 5, 6, 7, 9]
          },
          routes: {
            header: ['Date', 'Driver', 'Drops', 'Miles', 'Delivery fees £', 'Extra charges £', 'Multi-drop £', 'Adjustment £', 'Adjustment remark', 'Route total £'],
            rows: routeRows,
            totals: ['TOTAL', '', sum(routeRows, 2), sum(routeRows, 3), sum(routeRows, 4), sum(routeRows, 5), sum(routeRows, 6), sum(routeRows, 7), '', sum(routeRows, 9)],
            money: [4, 5, 6, 7, 9]
          },
          deliveries: {
            header: ['Date', 'Driver', 'Order ID', 'Merchant', 'Customer', 'Pickup', 'Drop-off', 'Route', 'Distance (mi)', 'Distance source',
              'Charged band (mi)', 'Base £', 'Mileage £', 'Card £', 'Minimum applied', 'Delivery fee £', 'Extra charge £', 'Remark', 'Drop total £', 'Calculation'],
            rows: delRows,
            money: [11, 12, 13, 15, 16, 18]
          }
        }
      };
    });
  }

  // ---------- upload + offline queue ----------
  function api(body) {
    return fetch(settings.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: settings.token }, body)),
      redirect: 'follow'
    }).then(function (r) {
      return r.text().then(function (t) {
        try { return JSON.parse(t); } catch (e) {
          var err = new Error('Unexpected response from Apps Script — check the Web App URL and that access is set to "Anyone".');
          err.fatal = true;
          throw err;
        }
      });
    });
  }

  function startUpload() {
    recalc();
    if (!result.deliveries.length) { toast('Nothing to upload yet — load a CSV first.', 'bad'); return; }
    if (result.unpriced && !confirm(result.unpriced + ' deliveries have no distance and will show no fee. Upload anyway?')) return;
    if (result.unassigned && !confirm(result.unassigned + ' deliveries have no driver and won\'t appear in any route total. Upload anyway?')) return;
    var payloads = buildPayloads();
    payloads.forEach(function (p) {
      // Replace an older pending upload of the same tab so the latest numbers win.
      queue = queue.filter(function (q) { return q.tabName !== p.tabName; });
      queue.push({ id: String(Date.now()) + Math.random().toString(36).slice(2, 6), tabName: p.tabName, count: p.count, total: p.total, body: p.body, createdAt: Date.now(), mode: null });
    });
    save(LS.queue, queue);
    renderQueuePill();
    if (!settings.scriptUrl || !settings.token) {
      toast('Saved to the upload queue. Add your Apps Script URL &amp; token in Settings to send it.', '', 8000);
      openSettings();
      return;
    }
    if (!navigator.onLine) {
      toast('You\'re offline — ' + payloads.length + ' upload' + (payloads.length > 1 ? 's' : '') + ' queued. It will sync automatically when you\'re back online.', '', 8000);
      if (view.tab === 'sheets') renderSheets();
      return;
    }
    processQueue();
  }

  var syncing = false;
  function processQueue() {
    if (syncing || !queue.length || !settings.scriptUrl || !settings.token || !navigator.onLine) return Promise.resolve();
    syncing = true;
    var items = queue.slice();
    return items.reduce(function (pr, item) {
      return pr.then(function (stop) {
        if (stop) return true;
        return syncItem(item).then(function () { return false; }, function (e) {
          if (e && e.fatal) {
            item.error = e.message;
            save(LS.queue, queue);
            toast(esc(e.message), 'bad', 9000);
          } else {
            toast('Couldn\'t reach Google — upload kept in the queue and will retry automatically.', '', 7000);
          }
          return true;
        });
      });
    }, Promise.resolve(false)).finally(function () {
      syncing = false;
      renderQueuePill();
      if (view.tab === 'sheets') renderSheets();
    });
  }

  function syncItem(item) {
    var chooseMode = item.mode
      ? Promise.resolve(item.mode)
      : api({ action: 'check', tabName: item.tabName }).then(function (c) {
        if (!c.ok) { var e = new Error(c.error || 'Check failed'); e.fatal = true; throw e; }
        return c.exists ? askConflict(item.tabName, c.url, c.nextVersionName) : 'create';
      });
    return chooseMode.then(function (mode) {
      if (mode === 'cancel') { dequeue(item.id); toast('Upload of ' + esc(item.tabName) + ' cancelled.'); return; }
      item.mode = mode;
      save(LS.queue, queue);
      return api(Object.assign({ action: 'upload', tabName: item.tabName, mode: mode }, item.body)).then(function (res) {
        if (res.conflict) { item.mode = null; return syncItem(item); }
        if (!res.ok) { var e = new Error(res.error || 'Upload failed'); e.fatal = true; throw e; }
        dequeue(item.id);
        history.unshift({ tabName: res.tabName, url: res.url, mode: mode === 'update' ? 'Updated' : (mode === 'version' ? 'New version' : 'Created'), count: item.count, total: item.total, at: Date.now() });
        history = history.slice(0, 200);
        save(LS.history, history);
        toast('✓ Uploaded <b>' + esc(res.tabName) + '</b> (' + item.count + ' deliveries, ' + esc(item.total) + '). <a href="' + esc(res.url) + '" target="_blank" rel="noopener">Open tab ↗</a>', 'ok', 15000);
      });
    });
  }

  function dequeue(id) {
    queue = queue.filter(function (q) { return q.id !== id; });
    save(LS.queue, queue);
  }

  function askConflict(name, url, next) {
    return new Promise(function (resolve) {
      var dlg = $('#dlgConflict');
      $('#cfName').textContent = name;
      $('#cfNext').textContent = '“' + next + '”';
      var link = $('#cfLink');
      if (url) { link.href = url; link.classList.remove('hidden'); } else link.classList.add('hidden');
      var done = function (choice) {
        $$('#dlgConflict [data-choice]').forEach(function (b) { b.onclick = null; });
        dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(choice);
      };
      $$('#dlgConflict [data-choice]').forEach(function (b) {
        b.onclick = function () { done(b.dataset.choice); };
      });
      dlg.onclose = function () { done('cancel'); };
      dlg.showModal();
    });
  }

  // ---------- settings ----------
  function openSettings() {
    $('#sUrl').value = settings.scriptUrl;
    $('#sToken').value = settings.token;
    $('#sBase').value = settings.pricing.base;
    $('#sPerMile').value = settings.pricing.perMile;
    $('#sFloor').value = settings.pricing.floor;
    $('#sBand').value = settings.pricing.bandMiles;
    $('#sDrop').value = settings.pricing.extraDropFee;
    $('#sRoad').checked = !!settings.roadDistance;
    $('#sFactor').value = settings.straightFactor;
    $('#sTheme').value = settings.theme || '';
    $('#sUnlock').checked = false;
    lockPricing(true);
    $('#testResult').textContent = '';
    $('#dlgSettings').showModal();
  }
  function lockPricing(lock) { $$('#pricingFields input').forEach(function (i) { i.disabled = lock; }); }
  function readSettingsForm() {
    var num = function (id, d) { var v = parseFloat($(id).value); return isNaN(v) ? d : v; };
    settings.scriptUrl = $('#sUrl').value.trim();
    settings.token = $('#sToken').value.trim();
    settings.pricing = {
      base: num('#sBase', P.DEFAULT_CONFIG.base),
      perMile: num('#sPerMile', P.DEFAULT_CONFIG.perMile),
      floor: num('#sFloor', P.DEFAULT_CONFIG.floor),
      bandMiles: num('#sBand', P.DEFAULT_CONFIG.bandMiles),
      extraDropFee: num('#sDrop', 0)
    };
    settings.roadDistance = $('#sRoad').checked;
    settings.straightFactor = num('#sFactor', 1);
    settings.theme = $('#sTheme').value;
  }
  function applyTheme() {
    if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  // ---------- events ----------
  function selectTab(tab) {
    view.tab = tab;
    $$('nav.steps button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    $$('section.panel').forEach(function (s) { s.classList.toggle('active', s.id === 'panel-' + tab); });
    renderAll();
    window.scrollTo(0, 0);
  }

  function findDelivery(key) { return S.deliveries.filter(function (d) { return d.key === key; })[0]; }

  function bind() {
    $$('nav.steps button').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });

    var dz = $('#dropZone'), fi = $('#fileInput');
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
    dz.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) readFile(f); });
    fi.addEventListener('change', function () { if (fi.files[0]) readFile(fi.files[0]); fi.value = ''; });

    $('#btnSample').addEventListener('click', function () {
      if (window.DODO_SAMPLE_CSV) loadText(window.DODO_SAMPLE_CSV, 'validation-sample.csv');
    });
    $('#btnReset').addEventListener('click', function () {
      if (!confirm('Clear the loaded file, driver assignments, extras and remarks? (Settings, queue and history are kept.)')) return;
      S = { fileName: '', headers: [], rows: [], mapping: {}, carrier: '', date: '', dateOverride: '', statuses: null, deliveries: [], routeAdj: {}, applied: false };
      view.selected = {};
      save(LS.session, S);
      renderUpload();
      renderAll();
    });

    $('#mappingGrid').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-map');
      if (!k) return;
      S.mapping[k] = e.target.value;
      if (k === 'carrier' || k === 'status' || k === 'date') initFilters();
      persistSession();
      renderFilters();
    });
    $('#fCarrier').addEventListener('change', function (e) { S.carrier = e.target.value; persistSession(); renderFilters(); });
    $('#fDate').addEventListener('change', function (e) { S.date = e.target.value; persistSession(); renderFilters(); });
    $('#fDateOverride').addEventListener('change', function (e) { S.dateOverride = e.target.value; persistSession(); renderFilters(); });
    $('#fStatuses').addEventListener('change', function (e) {
      var s = e.target.getAttribute('data-status');
      if (s == null) return;
      S.statuses = S.statuses || distinct('status');
      if (e.target.checked) { if (S.statuses.indexOf(s) < 0) S.statuses.push(s); }
      else S.statuses = S.statuses.filter(function (x) { return x !== s; });
      persistSession();
      renderFilters();
    });
    $('#btnApply').addEventListener('click', function () {
      if (!S.mapping.orderId) { toast('Choose the Order ID column first.', 'bad'); return; }
      applyMapping();
      selectTab('deliveries');
      calculateDistances(false);
    });

    // Deliveries table (delegated)
    var tbody = $('#delTable tbody');
    tbody.addEventListener('click', function (e) {
      if (!e.target.classList.contains('sel')) return;
      var tr = e.target.closest('tr');
      var key = tr.dataset.key;
      var on = e.target.checked;
      if (e.shiftKey && view.lastClicked) {
        var keys = $$('#delTable tbody tr[data-key]').map(function (r) { return r.dataset.key; });
        var a = keys.indexOf(view.lastClicked), b = keys.indexOf(key);
        if (a >= 0 && b >= 0) keys.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (k) { view.selected[k] = on; });
      }
      view.selected[key] = on;
      view.lastClicked = key;
      renderDeliveries();
    });
    tbody.addEventListener('change', function (e) {
      var tr = e.target.closest('tr');
      if (!tr) return;
      var d = findDelivery(tr.dataset.key);
      if (!d) return;
      var t = e.target;
      if (t.classList.contains('dist')) {
        var v = t.value.trim();
        d.distance = v === '' ? null : Math.max(0, Number(v));
        d.distanceSource = v === '' ? 'missing' : 'manual';
      } else if (t.classList.contains('driver')) {
        d.driver = canonicalDriver(t.value);
        addToRoster(d.driver);
      } else if (t.classList.contains('extra')) {
        d.extra = t.value === '' ? '' : Number(t.value);
      } else if (t.classList.contains('remark')) {
        d.remark = t.value;
      } else return;
      persistSession();
      renderAll();
    });
    $('#selAll').addEventListener('change', function (e) {
      result.deliveries.filter(matchesView).forEach(function (d) { view.selected[d.key] = e.target.checked; });
      renderDeliveries();
    });
    $('#viewFilter').addEventListener('click', function (e) {
      var f = e.target.dataset && e.target.dataset.f;
      if (!f) return;
      view.filter = f;
      renderDeliveries();
    });
    $('#search').addEventListener('input', function (e) {
      view.search = e.target.value.trim();
      debounce('search', renderDeliveries, 150);
    });
    $('#btnAssign').addEventListener('click', function () {
      var name = canonicalDriver($('#bulkDriver').value);
      if (!name) { toast('Type or pick a driver name first.', 'bad'); return; }
      var n = 0;
      S.deliveries.forEach(function (d) { if (view.selected[d.key]) { d.driver = name; n++; } });
      if (!n) { toast('Select some deliveries first (tick the boxes).', 'bad'); return; }
      addToRoster(name);
      view.selected = {};
      persistSession();
      renderAll();
      toast('Assigned ' + n + ' deliveries to <b>' + esc(name) + '</b>.', 'ok', 3000);
    });
    $('#btnUnassign').addEventListener('click', function () {
      S.deliveries.forEach(function (d) { if (view.selected[d.key]) d.driver = ''; });
      view.selected = {};
      persistSession();
      renderAll();
    });
    $('#btnDistances').addEventListener('click', function () {
      var force = S.deliveries.some(function (d) { return d.distanceSource === 'straight'; }) &&
        confirm('Re-check estimated (straight-line) distances too?');
      if (force) S.deliveries.forEach(function (d) { if (d.distanceSource === 'straight') { delete distCache[pairKey(d.pickup, d.dropoff)]; d.distance = null; d.distanceSource = 'missing'; } });
      calculateDistances(force);
    });

    // Routes
    $('#routeList').addEventListener('change', function (e) {
      var k = e.target.dataset.key;
      if (!k) return;
      var adj = S.routeAdj[k] = S.routeAdj[k] || {};
      if (e.target.classList.contains('radj')) adj.amount = e.target.value === '' ? '' : Number(e.target.value);
      if (e.target.classList.contains('rremark')) adj.remark = e.target.value;
      persistSession();
      renderAll();
    });
    $('#btnCsvSummary').addEventListener('click', function () {
      var r = recalc();
      var rows = [['Driver', 'Date', 'Drops', 'Miles', 'Delivery fees', 'Extra charges', 'Multi-drop', 'Adjustment', 'Remark', 'Route total']];
      r.routes.forEach(function (x) { rows.push([x.driver, tabLabel(x.date), x.drops, x.miles, x.fees, x.extras, x.dropBonus, x.adjustment, x.adjustmentRemark, x.total]); });
      rows.push([]);
      rows.push(['Driver', 'Routes', 'Drops', 'Miles', 'Delivery fees', 'Extra charges', 'Multi-drop', 'Adjustments', 'Remarks', 'Final payable']);
      r.drivers.forEach(function (x) { rows.push([x.driver, x.routes, x.drops, x.miles, x.fees, x.extras, x.dropBonus, x.adjustment, x.adjustmentRemark, x.payable]); });
      rows.push(['TOTAL', '', r.totals.drops, '', r.totals.fees, r.totals.extras, r.totals.dropBonus, r.totals.adjustments, '', r.totals.payable]);
      download('dodo-driver-pay-summary.csv', toCSV(rows));
    });
    $('#btnCsvDeliveries').addEventListener('click', function () {
      var rows = [];
      buildPayloads().forEach(function (p, i) {
        if (i === 0) rows.push(p.body.deliveries.header);
        p.body.deliveries.rows.forEach(function (r) { rows.push(r); });
      });
      download('dodo-driver-pay-deliveries.csv', toCSV(rows));
    });

    // Upload
    $('#btnUpload').addEventListener('click', startUpload);
    $('#btnUpload2').addEventListener('click', startUpload);
    $('#btnSyncNow').addEventListener('click', function () {
      queue.forEach(function (q) { delete q.error; });
      save(LS.queue, queue);
      if (!navigator.onLine) toast('Still offline — will sync when the connection returns.');
      processQueue();
    });
    $('#queueList').addEventListener('click', function (e) {
      var id = e.target.getAttribute('data-dequeue');
      if (id && confirm('Remove this queued upload?')) { dequeue(id); renderSheets(); renderQueuePill(); }
    });

    // Settings
    $('#btnSettings').addEventListener('click', openSettings);
    $('#sUnlock').addEventListener('change', function (e) { lockPricing(!e.target.checked); });
    $('#btnPricingDefault').addEventListener('click', function () {
      var d = P.DEFAULT_CONFIG;
      $('#sBase').value = d.base; $('#sPerMile').value = d.perMile; $('#sFloor').value = d.floor;
      $('#sBand').value = d.bandMiles; $('#sDrop').value = d.extraDropFee;
    });
    $('#btnTest').addEventListener('click', function () {
      readSettingsForm();
      var out = $('#testResult');
      if (!settings.scriptUrl) { out.textContent = 'Enter the Web App URL.'; return; }
      out.textContent = 'Testing…';
      api({ action: 'ping' }).then(function (r) {
        out.innerHTML = r.ok ? '<span style="color:var(--ok)">✓ Connected to “' + esc(r.spreadsheetName) + '”</span>' : '<span style="color:var(--bad)">' + esc(r.error) + '</span>';
      }).catch(function (e) { out.innerHTML = '<span style="color:var(--bad)">' + esc(e.message || 'Could not connect') + '</span>'; });
    });
    $('#dlgSettings').addEventListener('close', function () {
      if ($('#dlgSettings').returnValue !== 'save') return;
      readSettingsForm();
      save(LS.settings, settings);
      applyTheme();
      renderAll();
      processQueue();
      toast('Settings saved.', 'ok', 2500);
    });

    // Connectivity
    window.addEventListener('online', function () { renderNet(); processQueue(); if (view.tab === 'sheets') renderSheets(); });
    window.addEventListener('offline', function () { renderNet(); if (view.tab === 'sheets') renderSheets(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) save(LS.session, S); else processQueue();
    });
    window.addEventListener('pagehide', function () { save(LS.session, S); });
    setInterval(processQueue, 60000);
  }

  function readFile(file) {
    var r = new FileReader();
    r.onload = function () { loadText(String(r.result), file.name); };
    r.onerror = function () { toast('Could not read that file.', 'bad'); };
    r.readAsText(file);
  }

  // One-click connect: #connect=<base64url {"u": webAppUrl, "t": token}> (generated by setup() in Code.gs).
  function consumeConnectLink() {
    var m = /[#&]connect=([A-Za-z0-9_\-=]+)/.exec(location.hash);
    if (!m) return;
    try {
      var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      var cfg = JSON.parse(atob(b64));
      if (cfg.u && cfg.t) {
        settings.scriptUrl = cfg.u;
        settings.token = cfg.t;
        save(LS.settings, settings);
        toast('✓ Connected to Google Sheets. You can bookmark this page.', 'ok', 6000);
      }
    } catch (e) {
      toast('That connect link is invalid — paste the URL and token in Settings instead.', 'bad');
    }
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', location.pathname + location.search);
    else location.hash = '';
  }

  // ---------- boot ----------
  consumeConnectLink();
  applyTheme();
  bind();
  renderNet();
  renderUpload();
  renderAll();
  if (S.applied && S.deliveries.length) selectTab('deliveries');
  processQueue();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
