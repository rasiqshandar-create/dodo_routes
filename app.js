/* Dodo Routes — driver-wise pickups, deliveries and pay. Vanilla JS, no dependencies, works offline. */
(function () {
  'use strict';

  var P = window.DodoPricing;
  var LS = {
    settings: 'dodoPay.settings', session: 'dodoRoutes.session', geo: 'dodoPay.geoCache',
    dist: 'dodoPay.distCache', queue: 'dodoPay.queue', history: 'dodoPay.history'
  };

  // ---------- storage ----------
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  var settings = Object.assign({ scriptUrl: '', token: '', pricing: {}, roadDistance: true, theme: '' }, load(LS.settings, {}));
  settings.pricing = Object.assign({}, P.DEFAULT_CONFIG, settings.pricing || {});
  var geoCache = load(LS.geo, {});
  var distCache = load(LS.dist, {});
  var queue = load(LS.queue, []);
  var uploadHistory = load(LS.history, []);

  function emptySession() {
    return { fileName: '', headers: [], rows: [], mapping: {}, date: '', dateOverride: '', edits: {}, routeAdj: {} };
  }
  var S = Object.assign(emptySession(), load(LS.session, {}));
  var view = { driver: '' }; // '' = all drivers
  var result = null;

  // ---------- utils ----------
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var gbp = P.fmt;
  function norm(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function clean(v) { return String(v == null ? '' : v).trim().replace(/^"+|"+$/g, '').replace(/^'(?=[+0-9])/, '').trim(); }
  function normPc(pc) { return String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  var PC_RE = /\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})\b/i;
  function postcodeOf(text) {
    var m = PC_RE.exec(String(text || ''));
    return m ? (m[1] + ' ' + m[2]).toUpperCase() : '';
  }
  var timers = {};
  function debounce(k, fn, ms) { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms || 250); }
  function persist() { debounce('s', function () { save(LS.session, S); }); }
  function toast(html, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = html;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 5000);
  }
  function initials(name) {
    return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?';
  }

  // ---------- dates & slots ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function londonParts(d) {
    var o = {};
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    } catch (e) {
      o = { year: d.getFullYear(), month: pad(d.getMonth() + 1), day: pad(d.getDate()), hour: pad(d.getHours()), minute: pad(d.getMinutes()) };
    }
    return o;
  }
  function parseDate(v) {
    var s = clean(v), m;
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { var d = new Date(s); if (isNaN(d)) return ''; var o = londonParts(d); return o.year + '-' + o.month + '-' + o.day; }
    if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    if ((m = s.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/))) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(m[2]) + '-' + pad(m[1]);
    if ((m = s.match(/(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{4})/))) {
      var mi = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
      if (mi >= 0) return m[3] + '-' + pad(mi + 1) + '-' + pad(m[1]);
    }
    return '';
  }
  function tabLabel(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? m[3] + '-' + MONTHS[Number(m[2]) - 1] + '-' + m[1] : 'Undated';
  }
  function todayYmd() { var o = londonParts(new Date()); return o.year + '-' + o.month + '-' + o.day; }
  // Show slots compactly: ISO timestamps become "10:00"; free text ("10:00-12:00") is kept as typed.
  function fmtSlot(v) {
    var s = clean(v);
    if (!s) return '';
    var parts = s.split(/\s*(?:–|—|\bto\b|\s-\s)\s*/);
    var iso = /^\d{4}-\d{2}-\d{2}T/;
    if (parts.every(function (p) { return iso.test(p); })) {
      return parts.map(function (p) { var o = londonParts(new Date(p)); return o.hour + ':' + o.minute; }).join('–');
    }
    if (iso.test(s)) { var o = londonParts(new Date(s)); return o.hour + ':' + o.minute; }
    return s;
  }
  function slotSortKey(v) {
    var s = clean(v), m;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { var o = londonParts(new Date(s)); return o.hour + o.minute; }
    m = s.match(/(\d{1,2})[:.](\d{2})/);
    return m ? pad(m[1]) + m[2] : '9999';
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
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
  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\r\n');
  }
  function download(name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- columns ----------
  var FIELDS = [
    { key: 'orderId', label: 'Order ID', req: true, c: ['order id', 'external id', 'order number', 'order no', 'order', 'order id 1'] },
    { key: 'date', label: 'Delivery date', c: ['delivery date', 'date', 'day'] },
    { key: 'merchant', label: 'Merchant name', c: ['merchant name', 'merchant', 'store', 'shop'] },
    { key: 'merchantPhone', label: 'Merchant phone', c: ['merchant phone', 'store phone', 'pickup phone'] },
    { key: 'pickupAddress', label: 'Pickup address', c: ['pickup address', 'collection address', 'pickup postcode', 'collection postcode'] },
    { key: 'pickupSlot', label: 'Pickup slot', c: ['pickup slot', 'collection slot', 'pickup window', 'pickup time', 'commited pickup window start'] },
    { key: 'customer', label: 'Customer name', c: ['customer name', 'customer', 'recipient', 'recipient name'] },
    { key: 'phone', label: 'Customer phone', c: ['customer phone', 'customer phone number', 'phone', 'mobile', 'recipient phone'] },
    { key: 'address', label: 'Customer address', c: ['customer address', 'delivery address', 'dropoff address', 'address', 'dropoff postcode', 'delivery postcode'] },
    { key: 'deliverySlot', label: 'Delivery slot', c: ['delivery slot', 'delivery window', 'delivery time', 'commited delivery window start', 'delivery before'] },
    { key: 'instructions', label: 'Delivery instructions', c: ['delivery instructions', 'instructions', 'delivery notes', 'notes', 'order note'] },
    { key: 'parcels', label: 'Parcel count', c: ['parcel count', 'parcels', 'num parcels', 'no of parcels', 'number of parcels', 'packages', 'items'] },
    { key: 'driver', label: 'Driver name', c: ['driver name', 'driver', 'agent name', 'courier', 'rider'] },
    { key: 'vehicle', label: 'Vehicle type', c: ['vehicle type', 'vehicle'] },
    { key: 'distance', label: 'Distance (miles)', c: ['distance miles', 'distance mi', 'distance', 'miles', 'distance km'] },
    { key: 'stop', label: 'Stop sequence', c: ['stop sequence', 'stop', 'sequence', 'route order index', 'drop order'] },
    { key: 'extra', label: 'Extra charge £', c: ['extra charge', 'extra charge £', 'extra', 'additional charge'] },
    { key: 'remark', label: 'Remarks', c: ['remarks', 'remark', 'pay remark'] },
    { key: 'carrier', label: 'Carrier (filter)', c: ['carrier'] },
    { key: 'status', label: 'Status (filter)', c: ['delivery status', 'status'] }
  ];

  function autoMap(headers) {
    var n = headers.map(norm), used = {}, map = {};
    FIELDS.forEach(function (f) {
      var hit = -1;
      f.c.some(function (c) { var i = n.findIndex(function (h, x) { return !used[x] && h === c; }); if (i >= 0) { hit = i; return true; } return false; });
      if (hit < 0) {
        f.c.some(function (c) {
          if (c.length < 6) return false;
          var i = n.findIndex(function (h, x) { return !used[x] && h.indexOf(c) >= 0; });
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
    return i >= 0 ? clean(row[i]) : '';
  }
  function rowDate(r) {
    return (S.mapping.date && parseDate(col(r, 'date'))) ||
      (S.mapping.deliverySlot && parseDate(col(r, 'deliverySlot'))) ||
      S.dateOverride || '';
  }
  var excluded = { carrier: 0, cancelled: 0 };
  function includeRow(r) {
    if (S.mapping.carrier && S.hasDodo && !/dodo/i.test(col(r, 'carrier'))) { excluded.carrier++; return false; }
    if (S.mapping.status && /cancel/i.test(col(r, 'status'))) { excluded.cancelled++; return false; }
    return true;
  }

  // ---------- orders ----------
  function buildOrders() {
    excluded = { carrier: 0, cancelled: 0 };
    var seen = {};
    var kmCol = /\bkm\b|kilomet/i.test(S.mapping.distance || '');
    var out = [];
    S.rows.forEach(function (r, idx) {
      if (!includeRow(r)) return;
      var date = rowDate(r);
      if (S.date && date !== S.date) return;
      var id = col(r, 'orderId') || ('Row ' + (idx + 2));
      var key = seen[id] ? id + '#' + idx : id;
      seen[key] = true;
      var e = S.edits[key] || {};
      var pickupAddress = col(r, 'pickupAddress');
      var address = col(r, 'address');
      var rawDist = col(r, 'distance').replace(/[^0-9.]/g, '');
      var o = {
        key: key, id: id, date: date,
        merchant: col(r, 'merchant'), merchantPhone: col(r, 'merchantPhone'),
        pickupAddress: pickupAddress, pickupPostcode: postcodeOf(pickupAddress),
        pickupSlot: col(r, 'pickupSlot'),
        customer: col(r, 'customer'), phone: col(r, 'phone'),
        address: address, postcode: postcodeOf(address),
        deliverySlot: col(r, 'deliverySlot'), instructions: col(r, 'instructions'),
        parcels: Math.max(1, parseInt(col(r, 'parcels'), 10) || 1),
        parcelsGiven: col(r, 'parcels') !== '',
        driver: e.driver != null ? e.driver : col(r, 'driver'),
        vehicle: col(r, 'vehicle'),
        stop: parseFloat(col(r, 'stop')),
        extra: e.extra != null ? e.extra : (parseFloat(col(r, 'extra').replace(/[^0-9.\-]/g, '')) || ''),
        remark: e.remark != null ? e.remark : col(r, 'remark'),
        distance: null, distanceSource: 'missing'
      };
      if (e.distance != null) { o.distance = e.distance; o.distanceSource = 'manual'; }
      else if (rawDist !== '' && !isNaN(rawDist)) { o.distance = Math.round(Number(rawDist) * (kmCol ? 0.621371 : 1) * 100) / 100; o.distanceSource = 'csv'; }
      else {
        var c = distCache[normPc(o.pickupPostcode) + '>' + normPc(o.postcode)];
        if (c) { o.distance = c.mi; o.distanceSource = c.src; }
      }
      out.push(o);
    });
    return out;
  }

  function recalc() {
    var orders = buildOrders();
    var r = P.calculate(orders, settings.pricing, S.routeAdj);
    var byKey = {};
    r.deliveries.forEach(function (d) { byKey[d.key] = d; });
    var drivers = {};
    r.deliveries.forEach(function (d) {
      var name = d.driver || '';
      var g = drivers[name] = drivers[name] || { name: name, orders: [], vehicles: {}, parcels: 0, miles: 0 };
      g.orders.push(d);
      g.parcels += d.parcels;
      if (d.distance != null) g.miles += d.distance;
      if (d.vehicle) g.vehicles[d.vehicle] = 1;
    });
    var pay = {};
    r.drivers.forEach(function (d) { pay[d.driver] = d; });
    var list = Object.keys(drivers).filter(Boolean).sort(function (a, b) { return a.localeCompare(b); }).map(function (n) {
      var g = drivers[n];
      g.pay = pay[n];
      g.routes = r.routes.filter(function (x) { return x.driver === n; });
      g.miles = P.money(g.miles);
      return g;
    });
    result = {
      calc: r, drivers: list, unassigned: drivers[''] ? drivers[''].orders : [],
      orders: r.deliveries, parcels: r.deliveries.reduce(function (s, d) { return s + d.parcels; }, 0)
    };
    return result;
  }

  // ---------- distances (only when the CSV has none) ----------
  function fetchJSON(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 20000) : null;
    return fetch(url, Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {}))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { if (t) clearTimeout(t); });
  }
  function haversine(a, b) {
    var R = 3958.7613, k = Math.PI / 180, dLat = (b[0] - a[0]) * k, dLon = (b[1] - a[1]) * k;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * k) * Math.cos(b[0] * k) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  var distRunning = false;
  function lookupDistances() {
    if (distRunning || !settings.roadDistance || !navigator.onLine) return;
    var need = buildOrders().filter(function (o) { return o.distance == null && o.pickupPostcode && o.postcode; });
    if (!need.length) return;
    distRunning = true;
    var pcs = {};
    need.forEach(function (o) { pcs[o.pickupPostcode] = 1; pcs[o.postcode] = 1; });
    var todo = Object.keys(pcs).filter(function (p) { return !geoCache[normPc(p)]; });
    var chunks = [];
    for (var i = 0; i < todo.length; i += 100) chunks.push(todo.slice(i, i + 100));
    chunks.reduce(function (pr, ch) {
      return pr.then(function () {
        return fetchJSON('https://api.postcodes.io/postcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postcodes: ch }) })
          .then(function (j) { (j.result || []).forEach(function (x) { if (x.result) geoCache[normPc(x.query)] = [x.result.latitude, x.result.longitude]; }); });
      });
    }, Promise.resolve()).then(function () {
      save(LS.geo, geoCache);
      var byPickup = {};
      need.forEach(function (o) {
        if (geoCache[normPc(o.pickupPostcode)] && geoCache[normPc(o.postcode)]) (byPickup[o.pickupPostcode] = byPickup[o.pickupPostcode] || {})[o.postcode] = 1;
      });
      return Object.keys(byPickup).reduce(function (pr, pu) {
        return pr.then(function () {
          var drops = Object.keys(byPickup[pu]).slice(0, 90);
          var coords = [geoCache[normPc(pu)]].concat(drops.map(function (d) { return geoCache[normPc(d)]; }));
          var url = 'https://router.project-osrm.org/table/v1/driving/' +
            coords.map(function (c) { return c[1].toFixed(6) + ',' + c[0].toFixed(6); }).join(';') +
            '?sources=0&destinations=' + drops.map(function (_, k) { return k + 1; }).join(';') + '&annotations=distance';
          return fetchJSON(url, null, 30000).then(function (j) {
            var row = (j.distances || [])[0] || [];
            drops.forEach(function (d, k) { if (row[k] != null) distCache[normPc(pu) + '>' + normPc(d)] = { mi: Math.round(row[k] / 1609.344 * 100) / 100, src: 'road' }; });
          }).catch(function () {
            drops.forEach(function (d) {
              distCache[normPc(pu) + '>' + normPc(d)] = { mi: Math.round(haversine(geoCache[normPc(pu)], geoCache[normPc(d)]) * 100) / 100, src: 'estimate' };
            });
          });
        });
      }, Promise.resolve());
    }).then(function () { save(LS.dist, distCache); render(); })
      .catch(function () { /* stays "needs miles"; user can type them */ })
      .finally(function () { distRunning = false; });
  }

  // ---------- loading ----------
  function loadText(text, name) {
    var rows = parseCSV(text);
    if (rows.length < 2) { toast('That file has no data rows.', 'bad'); return; }
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    S = emptySession();
    S.fileName = name;
    S.headers = headers;
    S.rows = rows.slice(1).filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
    S.mapping = autoMap(headers);
    initDate();
    view.driver = '';
    persist();
    render();
    lookupDistances();
  }
  function initDate() {
    S.hasDodo = !!S.mapping.carrier && S.rows.some(function (r) { return /dodo/i.test(col(r, 'carrier')); });
    if (!S.mapping.date && !S.mapping.deliverySlot) S.dateOverride = S.dateOverride || todayYmd();
    var counts = dateCounts();
    var keys = Object.keys(counts);
    S.date = keys.length > 1 ? keys.sort(function (a, b) { return counts[b] - counts[a]; })[0] : '';
    if (keys.length === 1 && !keys[0]) S.dateOverride = S.dateOverride || todayYmd();
  }
  function dateCounts() {
    var out = {};
    S.rows.forEach(function (r) { if (!includeRow(r)) return; var d = rowDate(r); out[d] = (out[d] || 0) + 1; });
    return out;
  }
  function readFile(file) {
    var r = new FileReader();
    r.onload = function () { loadText(String(r.result), file.name); };
    r.onerror = function () { toast('Could not read that file.', 'bad'); };
    r.readAsText(file);
  }
  function setEdit(key, field, value) {
    var e = S.edits[key] = S.edits[key] || {};
    if (value === null || value === undefined) delete e[field]; else e[field] = value;
    persist();
  }

  // ---------- rendering ----------
  function render() {
    var has = S.headers && S.headers.length;
    $('#emptyView').classList.toggle('hidden', !!has);
    $('#loadedView').classList.toggle('hidden', !has);
    $('#actionbar').classList.toggle('hidden', !has);
    renderQueuePill();
    if (!has) return;
    recalc();
    renderFileBar();
    renderStats();
    renderChips();
    renderDrivers();
    var t = result.calc.totals;
    $('#abTotal').textContent = gbp(t.payable);
    $('#abMeta').textContent = result.drivers.length + ' drivers · ' + result.orders.length + ' orders' + (S.date || S.dateOverride ? ' · ' + tabLabel(S.date || S.dateOverride) : '');
  }

  function renderFileBar() {
    $('#fileName').textContent = S.fileName;
    var dc = dateCounts(), keys = Object.keys(dc).sort();
    var ex = [];
    buildOrders();
    if (excluded.carrier) ex.push(excluded.carrier + ' non-Dodo');
    if (excluded.cancelled) ex.push(excluded.cancelled + ' cancelled');
    $('#fileMeta').textContent = S.rows.length + ' rows' + (ex.length ? ' · skipped ' + ex.join(', ') : '');

    var noDateCol = !S.mapping.date && !S.mapping.deliverySlot;
    var dateUnknown = noDateCol || (keys.length === 1 && !keys[0]);
    $('#fDate').classList.toggle('hidden', dateUnknown);
    $('#fDateOverride').classList.toggle('hidden', !dateUnknown);
    $('#fDateOverride').value = S.dateOverride || '';
    $('#fDate').innerHTML = (keys.length > 1 ? '<option value="">All dates</option>' : '') + keys.map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === S.date ? ' selected' : '') + '>' + esc(k ? tabLabel(k) : 'No date') + ' (' + dc[k] + ')</option>';
    }).join('');

    var notes = [];
    var missingReq = !S.mapping.orderId;
    if (missingReq) notes.push('<div class="notice bad">Couldn\'t find the Order ID column. Open <b>Column matching</b> below and pick it.</div>');
    if (!S.mapping.driver) notes.push('<div class="notice warn">No driver column found. Assign drivers in the <b>Unassigned</b> list below.</div>');
    var nodist = result.orders.filter(function (o) { return o.distance == null; }).length;
    if (nodist) notes.push('<div class="notice warn">' + nodist + ' order' + (nodist > 1 ? 's have' : ' has') + ' no distance, so the fee can\'t be calculated. Type the miles in the driver\'s <b>Pay</b> section.</div>');
    var est = result.orders.filter(function (o) { return o.distanceSource === 'road' || o.distanceSource === 'estimate'; }).length;
    if (est) notes.push('<div class="notice info">' + est + ' distances were worked out from postcodes (no distance in the CSV). Check them in the Pay section.</div>');
    $('#notices').innerHTML = notes.join('');

    var opts = function (sel) {
      return '<option value="">— not in file —</option>' + S.headers.map(function (h) { return '<option' + (h === sel ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('');
    };
    $('#mappingGrid').innerHTML = FIELDS.map(function (f) {
      return '<label class="field">' + esc(f.label) + (f.req ? ' *' : '') + '<select data-map="' + f.key + '">' + opts(S.mapping[f.key]) + '</select></label>';
    }).join('');
    if (missingReq) $('#colsDetails').open = true;
  }

  function renderStats() {
    var t = result.calc.totals;
    var miles = result.orders.reduce(function (s, o) { return s + (o.distance || 0); }, 0);
    $('#stats').innerHTML = [
      ['Drivers', result.drivers.length], ['Orders', result.orders.length], ['Parcels', result.parcels],
      ['Miles', miles.toFixed(1)], ['Total pay', gbp(t.payable)]
    ].map(function (s) { return '<div class="stat"><div class="k">' + s[0] + '</div><div class="v">' + s[1] + '</div></div>'; }).join('');
  }

  function renderChips() {
    var names = result.drivers.map(function (d) { return d.name; });
    if (view.driver && view.driver !== '__unassigned' && names.indexOf(view.driver) < 0) view.driver = '';
    if (view.driver === '__unassigned' && !result.unassigned.length) view.driver = '';
    var html = '<button class="chip" data-driver="" aria-pressed="' + (view.driver === '') + '">All drivers</button>' +
      result.drivers.map(function (d) {
        return '<button class="chip" data-driver="' + esc(d.name) + '" aria-pressed="' + (view.driver === d.name) + '">' + esc(d.name) + '<span class="c">' + d.orders.length + '</span></button>';
      }).join('') +
      (result.unassigned.length ? '<button class="chip warn" data-driver="__unassigned" aria-pressed="' + (view.driver === '__unassigned') + '">Unassigned<span class="c">' + result.unassigned.length + '</span></button>' : '');
    $('#chips').innerHTML = html;
    $('#driverList').innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
  }

  function pickupGroups(orders) {
    var g = {}, list = [];
    orders.forEach(function (o) {
      var k = [o.merchant, o.pickupAddress, o.pickupSlot].join('|');
      if (!g[k]) { g[k] = { merchant: o.merchant, address: o.pickupAddress, phone: o.merchantPhone, slot: o.pickupSlot, ids: [], parcels: 0 }; list.push(g[k]); }
      g[k].ids.push(o.id);
      g[k].parcels += o.parcels;
    });
    return list.sort(function (a, b) { return slotSortKey(a.slot).localeCompare(slotSortKey(b.slot)) || a.merchant.localeCompare(b.merchant); });
  }
  function deliveryOrder(orders) {
    return orders.slice().sort(function (a, b) {
      var sa = isNaN(a.stop) ? 1e9 : a.stop, sb = isNaN(b.stop) ? 1e9 : b.stop;
      return sa - sb || slotSortKey(a.deliverySlot).localeCompare(slotSortKey(b.deliverySlot)) || String(a.id).localeCompare(String(b.id));
    });
  }

  var SRC = { csv: '', manual: 'edited', road: 'from postcodes', estimate: 'straight-line est.', missing: 'needs miles' };

  function driverCard(d) {
    var pay = d.pay || { payable: 0 };
    var vehicles = Object.keys(d.vehicles).join(', ');
    var pickups = pickupGroups(d.orders);
    var dels = deliveryOrder(d.orders);
    var multiDate = d.routes.length > 1;

    var h = '<article class="card driver" data-driver="' + esc(d.name) + '">' +
      '<div class="head"><div class="avatar">' + esc(initials(d.name)) + '</div>' +
      '<div class="who"><div class="n">' + esc(d.name) + '</div><div class="m">' + [vehicles, d.orders.length + ' orders', d.parcels + ' parcels', d.miles.toFixed(1) + ' mi'].filter(Boolean).map(esc).join(' · ') + '</div></div>' +
      '<span class="spacer"></span>' +
      '<div class="pay"><div class="k">Pay</div><div class="v">' + gbp(pay.payable) + '</div></div>' +
      '<button class="btn quiet noprint" data-print="' + esc(d.name) + '" type="button">Print</button></div>';

    // Output 1 — Pickups
    h += '<section class="sec-pickup"><div class="sec-title"><span class="tag p">1</span>Pickup details</div><div class="wrap"><table class="tbl stack"><thead><tr>' +
      '<th>Order ID</th><th>Merchant</th><th class="num">Parcels</th><th>Pickup slot</th></tr></thead><tbody>' +
      pickups.map(function (p) {
        return '<tr><td class="id" data-l="Order ID">' + p.ids.map(esc).join('<br>') + '</td>' +
          '<td data-l="Merchant"><b>' + esc(p.merchant || '—') + '</b>' + (p.address ? '<span class="sub">' + esc(p.address) + '</span>' : '') +
          (p.phone ? '<span class="sub"><a class="tel" href="tel:' + esc(p.phone.replace(/[^+0-9]/g, '')) + '">' + esc(p.phone) + '</a></span>' : '') + '</td>' +
          '<td class="num" data-l="Parcels"><b>' + p.parcels + '</b></td><td data-l="Pickup slot">' + esc(fmtSlot(p.slot) || '—') + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td data-l="">Total to collect</td><td></td><td class="num">' + d.parcels + '</td><td></td></tr></tfoot></table></div></section>';

    // Output 2 — Deliveries
    h += '<section class="sec-delivery"><div class="sec-title"><span class="tag d">2</span>Delivery details</div><div class="wrap"><table class="tbl stack"><thead><tr>' +
      '<th>#</th><th>Order ID</th><th>Customer</th><th>Address</th><th>Phone</th><th>Delivery slot</th><th class="num">Parcels</th><th>Instructions</th></tr></thead><tbody>' +
      dels.map(function (o, i) {
        return '<tr><td class="muted" data-l="Stop">' + (i + 1) + '</td><td class="id" data-l="Order ID">' + esc(o.id) + '</td>' +
          '<td data-l="Customer">' + esc(o.customer || '—') + '</td><td data-l="Address">' + esc(o.address || '—') + '</td>' +
          '<td data-l="Phone">' + (o.phone ? '<a class="tel" href="tel:' + esc(o.phone.replace(/[^+0-9]/g, '')) + '">' + esc(o.phone) + '</a>' : '—') + '</td>' +
          '<td data-l="Slot">' + esc(fmtSlot(o.deliverySlot) || '—') + '</td><td class="num" data-l="Parcels">' + o.parcels + '</td>' +
          '<td class="instr" data-l="Instructions">' + esc(o.instructions || '') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    // Pay (collapsed)
    var unpriced = d.orders.filter(function (o) { return o.distance == null; }).length;
    h += '<section class="sec-pay noprint"><details class="payd"' + (unpriced ? ' open' : '') + '><summary><span class="chev">▶</span><span class="sec-title" style="margin:0"><span class="tag f">£</span>Pay calculation</span>' +
      (unpriced ? '<span class="badge bad">' + unpriced + ' need miles</span>' : '') +
      '<span class="spacer"></span><b class="num">' + gbp(pay.payable) + '</b></summary>' +
      '<div class="wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>Order ID</th><th class="num">Miles</th><th>Calculation</th><th class="num">Fee</th><th class="num">Extra £</th><th>Remark</th><th class="num">Total</th></tr></thead><tbody>' +
      dels.map(function (o) {
        var p = o.pricing;
        return '<tr data-key="' + esc(o.key) + '"><td class="id">' + esc(o.id) + (multiDate ? '<span class="sub">' + esc(tabLabel(o.date)) + '</span>' : '') + '</td>' +
          '<td class="num"><input class="dist" type="number" step="0.01" min="0" value="' + (o.distance == null ? '' : o.distance) + '" aria-label="Miles">' +
          (SRC[o.distanceSource] ? '<span class="sub"><span class="badge ' + (o.distanceSource === 'missing' ? 'bad' : (o.distanceSource === 'manual' ? '' : 'warn')) + '">' + SRC[o.distanceSource] + '</span></span>' : '') + '</td>' +
          '<td class="small muted">' + (p.ok ? esc(p.bandedMiles.toFixed(1) + ' mi × ' + gbp(settings.pricing.perMile) + ' + ' + gbp(settings.pricing.base) + ' = ' + gbp(p.card) + (p.atFloor ? ' → min ' + gbp(settings.pricing.floor) : '')) : 'Enter miles') + '</td>' +
          '<td class="num">' + (o.fee == null ? '—' : gbp(o.fee)) + '</td>' +
          '<td class="num"><input class="money extra" type="number" step="0.01" value="' + (o.extra || '') + '" placeholder="0.00" aria-label="Extra charge"></td>' +
          '<td><input class="remark" value="' + esc(o.remark) + '" placeholder="Remark" aria-label="Remark"></td>' +
          '<td class="num"><b>' + (o.dropTotal == null ? '—' : gbp(o.dropTotal)) + '</b></td></tr>';
      }).join('') + '</tbody></table></div>' +
      d.routes.map(function (r) {
        var a = S.routeAdj[r.key] || {};
        return '<div class="adj"><span class="small" style="font-weight:650">Route extra / deduction' + (multiDate ? ' (' + esc(tabLabel(r.date)) + ')' : '') + ' £</span>' +
          '<input class="money radj" type="number" step="0.01" data-route="' + esc(r.key) + '" value="' + (a.amount || '') + '" placeholder="0.00">' +
          '<input class="remark rremark" data-route="' + esc(r.key) + '" value="' + esc(a.remark || '') + '" placeholder="Reason, e.g. waiting time" style="flex:1;min-width:160px"></div>';
      }).join('') +
      '<div class="adj small"><span class="muted">Fees ' + gbp(pay.fees || 0) + ' + extras ' + gbp(pay.extras || 0) + (pay.dropBonus ? ' + multi-drop ' + gbp(pay.dropBonus) : '') + ' + route ' + gbp(pay.adjustment || 0) + '</span><span class="spacer"></span><b>= ' + gbp(pay.payable || 0) + '</b></div>' +
      '</details></section></article>';
    return h;
  }

  function unassignedCard(list) {
    return '<article class="card driver" data-driver="__unassigned"><div class="head"><div class="avatar" style="background:var(--warn)">?</div>' +
      '<div class="who"><div class="n">Unassigned</div><div class="m">' + list.length + ' orders without a driver, not included in any pay</div></div></div>' +
      '<section><div class="wrap"><table class="tbl stack"><thead><tr><th>Order ID</th><th>Merchant</th><th>Customer / address</th><th>Slot</th><th>Assign driver</th></tr></thead><tbody>' +
      list.map(function (o) {
        return '<tr data-key="' + esc(o.key) + '"><td class="id" data-l="Order ID">' + esc(o.id) + '</td><td data-l="Merchant">' + esc(o.merchant) + '</td>' +
          '<td data-l="Customer">' + esc(o.customer) + '<span class="sub">' + esc(o.address) + '</span></td><td data-l="Slot">' + esc(fmtSlot(o.deliverySlot)) + '</td>' +
          '<td data-l="Driver"><input class="drv" list="driverList" placeholder="Driver name" aria-label="Assign driver"></td></tr>';
      }).join('') + '</tbody></table></div></section></article>';
  }

  function renderDrivers() {
    var html = '';
    if (view.driver === '__unassigned') html = unassignedCard(result.unassigned);
    else {
      result.drivers.forEach(function (d) { if (!view.driver || view.driver === d.name) html += driverCard(d); });
      if (!view.driver && result.unassigned.length) html += unassignedCard(result.unassigned);
    }
    if (!result.orders.length) html = '<div class="card muted" style="text-align:center;padding:32px">No orders for this date.</div>';
    // Keep open/closed state of pay sections across re-renders.
    var open = {};
    $$('#drivers details.payd').forEach(function (el) { open[el.closest('.driver').dataset.driver] = el.open; });
    $('#drivers').innerHTML = html;
    $$('#drivers details.payd').forEach(function (el) {
      var k = el.closest('.driver').dataset.driver;
      if (open[k] !== undefined) el.open = open[k] || el.open;
    });
  }

  function renderNet() {
    var on = navigator.onLine, p = $('#netPill');
    p.className = 'pill ' + (on ? 'ok' : 'bad');
    p.lastElementChild.textContent = on ? 'Online' : 'Offline';
  }
  function renderQueuePill() {
    var p = $('#queuePill');
    p.classList.toggle('hidden', !queue.length);
    p.lastElementChild.textContent = queue.length + ' waiting to upload';
  }

  // ---------- Google Sheets ----------
  function buildPayloads() {
    var r = recalc();
    var m = P.money;
    var dates = {};
    r.orders.forEach(function (o) { (dates[o.date] = dates[o.date] || []).push(o); });
    return Object.keys(dates).sort().map(function (date) {
      var orders = dates[date];
      var names = {};
      orders.forEach(function (o) { if (o.driver) names[o.driver] = 1; });
      var routes = r.calc.routes.filter(function (x) { return x.date === date; });
      var routeOf = {};
      routes.forEach(function (x) { routeOf[x.driver] = x; });
      var sections = [];
      var summaryRows = Object.keys(names).sort().map(function (n) {
        var x = routeOf[n];
        var os = orders.filter(function (o) { return o.driver === n; });
        var veh = {};
        os.forEach(function (o) { if (o.vehicle) veh[o.vehicle] = 1; });
        return [n, Object.keys(veh).join(', '), x.drops, os.reduce(function (s, o) { return s + o.parcels; }, 0), x.miles, x.fees, x.extras, m(x.dropBonus + x.adjustment), x.adjustmentRemark, x.total];
      });
      var sum = function (i) { return m(summaryRows.reduce(function (s, x) { return s + (Number(x[i]) || 0); }, 0)); };
      var total = sum(9);
      sections.push({
        title: 'DRIVER PAYMENT SUMMARY',
        header: ['Driver', 'Vehicle', 'Orders', 'Parcels', 'Miles', 'Delivery fees £', 'Extra charges £', 'Route adj. £', 'Route remark', 'Final payable £'],
        rows: summaryRows, totals: ['TOTAL', '', sum(2), sum(3), sum(4), sum(5), sum(6), sum(7), '', total], money: [5, 6, 7, 9]
      });
      Object.keys(names).sort().forEach(function (n) {
        var os = orders.filter(function (o) { return o.driver === n; });
        var x = routeOf[n];
        sections.push({
          driverHeading: n + '  ·  ' + os.length + ' orders  ·  pay ' + gbp(x.total),
          title: 'Pickup details',
          header: ['Order ID(s)', 'Merchant', 'Pickup address', 'Parcels to collect', 'Pickup slot'],
          rows: pickupGroups(os).map(function (p) { return [p.ids.join(', '), p.merchant, p.address, p.parcels, fmtSlot(p.slot)]; })
        });
        sections.push({
          title: 'Delivery details',
          header: ['#', 'Order ID', 'Customer', 'Address', 'Phone', 'Delivery slot', 'Parcels', 'Instructions'],
          rows: deliveryOrder(os).map(function (o, i) { return [i + 1, o.id, o.customer, o.address, o.phone ? "'" + o.phone : '', fmtSlot(o.deliverySlot), o.parcels, o.instructions]; })
        });
      });
      var calcRows = orders.slice().sort(function (a, b) {
        if (!a.driver !== !b.driver) return a.driver ? -1 : 1;
        return (a.driver || '').localeCompare(b.driver || '') || String(a.id).localeCompare(String(b.id));
      }).map(function (o) {
        var p = o.pricing;
        return [o.driver || '(unassigned)', o.id, o.merchant, o.distance == null ? '' : o.distance, p.ok ? p.bandedMiles : '',
          o.fee == null ? '' : o.fee, o.extra || 0, o.remark, o.dropTotal == null ? '' : o.dropTotal, p.breakdown];
      });
      sections.push({
        title: 'PAYMENT CALCULATION (per order)',
        header: ['Driver', 'Order ID', 'Merchant', 'Distance (mi)', 'Charged band (mi)', 'Delivery fee £', 'Extra £', 'Remark', 'Order total £', 'Calculation'],
        rows: calcRows, money: [5, 6, 8]
      });
      return {
        tabName: tabLabel(date), count: orders.length, total: gbp(total),
        body: {
          meta: { formula: P.describe(settings.pricing), generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }), sourceFile: S.fileName, totalPayable: total },
          sections: sections
        }
      };
    });
  }

  function api(body) {
    return fetch(settings.scriptUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: settings.token }, body)), redirect: 'follow'
    }).then(function (r) {
      return r.text().then(function (t) {
        try { return JSON.parse(t); } catch (e) {
          var err = new Error('Unexpected reply from Apps Script. Check the Web App URL and that access is "Anyone".');
          err.fatal = true; throw err;
        }
      });
    });
  }

  function startUpload() {
    recalc();
    if (!result.orders.length) { toast('Nothing to upload yet.', 'bad'); return; }
    var nodist = result.orders.filter(function (o) { return o.distance == null; }).length;
    if (nodist && !confirm(nodist + ' orders have no miles, so no fee. Upload anyway?')) return;
    if (result.unassigned.length && !confirm(result.unassigned.length + ' orders have no driver. Upload anyway?')) return;
    var payloads = buildPayloads();
    payloads.forEach(function (p) {
      queue = queue.filter(function (q) { return q.tabName !== p.tabName; });
      queue.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), tabName: p.tabName, count: p.count, total: p.total, body: p.body, createdAt: Date.now(), mode: null });
    });
    save(LS.queue, queue);
    renderQueuePill();
    if (!settings.scriptUrl || !settings.token) {
      toast('Saved. Connect Google Sheets in Settings to send it.', '', 7000);
      openSettings();
      return;
    }
    if (!navigator.onLine) { toast('You\'re offline. The upload is queued and will send automatically when you\'re back online.', '', 7000); return; }
    processQueue();
  }

  var syncing = false;
  function processQueue() {
    if (syncing || !queue.length || !settings.scriptUrl || !settings.token || !navigator.onLine) return Promise.resolve();
    syncing = true;
    return queue.slice().reduce(function (pr, item) {
      return pr.then(function (stop) {
        if (stop) return true;
        return syncItem(item).then(function () { return false; }, function (e) {
          if (e && e.fatal) { item.error = e.message; save(LS.queue, queue); toast(esc(e.message), 'bad', 9000); }
          else toast('Couldn\'t reach Google. The upload is still queued and will retry automatically.', '', 6000);
          return true;
        });
      });
    }, Promise.resolve(false)).finally(function () { syncing = false; renderQueuePill(); if ($('#dlgUploads').open) renderUploads(); });
  }
  function syncItem(item) {
    var mode = item.mode ? Promise.resolve(item.mode) : api({ action: 'check', tabName: item.tabName }).then(function (c) {
      if (!c.ok) { var e = new Error(c.error || 'Check failed'); e.fatal = true; throw e; }
      return c.exists ? askConflict(item.tabName, c.url, c.nextVersionName) : 'create';
    });
    return mode.then(function (md) {
      if (md === 'cancel') { dequeue(item.id); toast('Upload of ' + esc(item.tabName) + ' cancelled.'); return; }
      item.mode = md;
      save(LS.queue, queue);
      return api(Object.assign({ action: 'upload', tabName: item.tabName, mode: md }, item.body)).then(function (res) {
        if (res.conflict) { item.mode = null; return syncItem(item); }
        if (!res.ok) { var e = new Error(res.error || 'Upload failed'); e.fatal = true; throw e; }
        dequeue(item.id);
        uploadHistory.unshift({ tabName: res.tabName, url: res.url, mode: md === 'update' ? 'Updated' : (md === 'version' ? 'New version' : 'Created'), count: item.count, total: item.total, at: Date.now() });
        uploadHistory = uploadHistory.slice(0, 100);
        save(LS.history, uploadHistory);
        toast('✓ Uploaded <b>' + esc(res.tabName) + '</b> (' + item.count + ' orders, ' + esc(item.total) + '). <a href="' + esc(res.url) + '" target="_blank" rel="noopener">Open tab ↗</a>', 'ok', 15000);
      });
    });
  }
  function dequeue(id) { queue = queue.filter(function (q) { return q.id !== id; }); save(LS.queue, queue); }
  function askConflict(name, url, next) {
    return new Promise(function (resolve) {
      var dlg = $('#dlgConflict');
      $('#cfName').textContent = name;
      $('#cfNext').textContent = '“' + next + '”';
      var link = $('#cfLink');
      link.classList.toggle('hidden', !url);
      if (url) link.href = url;
      var done = function (c) {
        $$('#dlgConflict [data-choice]').forEach(function (b) { b.onclick = null; });
        dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(c);
      };
      $$('#dlgConflict [data-choice]').forEach(function (b) { b.onclick = function () { done(b.dataset.choice); }; });
      dlg.onclose = function () { done('cancel'); };
      dlg.showModal();
    });
  }
  function renderUploads() {
    var ok = settings.scriptUrl && settings.token;
    var h = ok ? '' : '<div class="notice warn" style="margin:0">Google Sheets isn\'t connected yet. Open <b>Settings</b>, or use the connect link from the Apps Script setup.</div>';
    h += '<h4>Waiting to upload</h4>' + (queue.length ? queue.map(function (q) {
      return '<div class="row"><b>' + esc(q.tabName) + '</b><span class="muted small">' + q.count + ' orders · ' + esc(q.error ? 'Error: ' + q.error : (navigator.onLine ? 'ready' : 'offline')) + '</span><span class="spacer"></span><button class="btn quiet" data-dequeue="' + esc(q.id) + '" type="button">Remove</button></div>';
    }).join('') : '<span class="muted small">Nothing waiting.</span>');
    h += '<h4>Recent uploads</h4>' + (uploadHistory.length ? uploadHistory.slice(0, 15).map(function (x) {
      return '<div class="row small"><b>' + esc(x.tabName) + '</b><span class="muted">' + esc(x.mode) + ' · ' + x.count + ' orders · ' + esc(x.total || '') + ' · ' + esc(new Date(x.at).toLocaleString('en-GB')) + '</span><span class="spacer"></span>' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">Open ↗</a>' : '') + '</div>';
    }).join('') : '<span class="muted small">No uploads yet.</span>');
    $('#uploadsContent').innerHTML = h;
  }

  // ---------- settings ----------
  function openSettings() {
    $('#sUrl').value = settings.scriptUrl; $('#sToken').value = settings.token;
    $('#sBase').value = settings.pricing.base; $('#sPerMile').value = settings.pricing.perMile; $('#sFloor').value = settings.pricing.floor;
    $('#sBand').value = settings.pricing.bandMiles; $('#sDrop').value = settings.pricing.extraDropFee;
    $('#sRoad').checked = !!settings.roadDistance; $('#sTheme').value = settings.theme || '';
    $('#formulaText').textContent = P.describe(settings.pricing);
    $('#sUnlock').checked = false; lockPricing(true);
    $('#testResult').textContent = '';
    $('#dlgSettings').showModal();
  }
  function lockPricing(l) { $$('#pricingFields input').forEach(function (i) { i.disabled = l; }); }
  function readSettings() {
    var num = function (id, d) { var v = parseFloat($(id).value); return isNaN(v) ? d : v; };
    var D = P.DEFAULT_CONFIG;
    settings.scriptUrl = $('#sUrl').value.trim(); settings.token = $('#sToken').value.trim();
    settings.pricing = { base: num('#sBase', D.base), perMile: num('#sPerMile', D.perMile), floor: num('#sFloor', D.floor), bandMiles: num('#sBand', D.bandMiles), extraDropFee: num('#sDrop', 0) };
    settings.roadDistance = $('#sRoad').checked; settings.theme = $('#sTheme').value;
  }
  function applyTheme() {
    if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme);
    else document.documentElement.removeAttribute('data-theme');
  }
  // One-click connect: #connect=<base64url {"u": webAppUrl, "t": token}> (generated by setup() in Code.gs).
  function consumeConnectLink() {
    var m = /[#&]connect=([A-Za-z0-9_\-=]+)/.exec(location.hash);
    if (!m) return;
    try {
      var cfg = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (cfg.u && cfg.t) {
        settings.scriptUrl = cfg.u; settings.token = cfg.t;
        save(LS.settings, settings);
        setTimeout(function () { toast('✓ Connected to Google Sheets. Bookmark this page.', 'ok', 6000); }, 50);
      }
    } catch (e) { toast('That connect link is invalid. Paste the URL and token in Settings instead.', 'bad'); }
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', location.pathname + location.search);
  }

  // ---------- printing ----------
  function printDriver(name) {
    $$('#drivers .driver').forEach(function (c) { c.classList.toggle('print-target', c.dataset.driver === name); });
    document.body.classList.toggle('print-one', !!name);
    window.print();
  }
  window.addEventListener('afterprint', function () { document.body.classList.remove('print-one'); });

  // ---------- events ----------
  function bind() {
    var dz = $('#dropZone'), fi = $('#fileInput');
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', function () { if (fi.files[0]) readFile(fi.files[0]); fi.value = ''; });
    $('#btnReplace').addEventListener('click', function () { fi.click(); });
    $('#btnClear').addEventListener('click', function () {
      if (!confirm('Clear this file and any extras/remarks you added?')) return;
      S = emptySession(); save(LS.session, S); render();
    });
    $('#btnSample').addEventListener('click', function () { loadText(window.DODO_SAMPLE_CSV, 'sample-orders.csv'); });
    $('#btnTemplate').addEventListener('click', function () { download('dodo-routes-template.csv', window.DODO_TEMPLATE_CSV); });

    $('#mappingGrid').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-map');
      if (!k) return;
      S.mapping[k] = e.target.value;
      if (k === 'date' || k === 'deliverySlot' || k === 'carrier' || k === 'status') initDate();
      persist(); render(); lookupDistances();
    });
    $('#fDate').addEventListener('change', function (e) { S.date = e.target.value; persist(); render(); });
    $('#fDateOverride').addEventListener('change', function (e) { S.dateOverride = e.target.value; persist(); render(); });

    $('#chips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      view.driver = b.dataset.driver;
      render();
    });

    $('#drivers').addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.route) {
        var a = S.routeAdj[t.dataset.route] = S.routeAdj[t.dataset.route] || {};
        if (t.classList.contains('radj')) a.amount = t.value === '' ? '' : Number(t.value);
        else a.remark = t.value;
        persist(); render(); return;
      }
      var tr = t.closest('tr[data-key]');
      if (!tr) return;
      var key = tr.dataset.key;
      if (t.classList.contains('dist')) setEdit(key, 'distance', t.value === '' ? null : Math.max(0, Number(t.value)));
      else if (t.classList.contains('extra')) setEdit(key, 'extra', t.value === '' ? '' : Number(t.value));
      else if (t.classList.contains('remark')) setEdit(key, 'remark', t.value);
      else if (t.classList.contains('drv')) {
        var name = t.value.trim().replace(/\s+/g, ' ');
        var match = result.drivers.filter(function (d) { return d.name.toLowerCase() === name.toLowerCase(); })[0];
        setEdit(key, 'driver', match ? match.name : name);
      } else return;
      render();
    });
    $('#drivers').addEventListener('click', function (e) {
      var b = e.target.closest('[data-print]');
      if (b) printDriver(b.dataset.print);
    });

    $('#btnUpload').addEventListener('click', startUpload);
    $('#btnPrintAll').addEventListener('click', function () { printDriver(view.driver && view.driver !== '__unassigned' ? view.driver : ''); });
    $('#btnCsv').addEventListener('click', function () {
      var rows = [['Date', 'Driver', 'Vehicle', 'Order ID', 'Merchant', 'Pickup address', 'Pickup slot', 'Customer', 'Customer phone', 'Customer address', 'Delivery slot', 'Parcels', 'Instructions', 'Distance (mi)', 'Fee £', 'Extra £', 'Remark', 'Order total £', 'Calculation']];
      recalc().orders.forEach(function (o) {
        rows.push([tabLabel(o.date), o.driver, o.vehicle, o.id, o.merchant, o.pickupAddress, fmtSlot(o.pickupSlot), o.customer, o.phone, o.address, fmtSlot(o.deliverySlot), o.parcels, o.instructions, o.distance == null ? '' : o.distance, o.fee == null ? '' : o.fee, o.extra || '', o.remark, o.dropTotal == null ? '' : o.dropTotal, o.pricing.breakdown]);
      });
      download('dodo-routes-' + tabLabel(S.date || S.dateOverride) + '.csv', toCSV(rows));
    });

    $('#btnUploads').addEventListener('click', function () { renderUploads(); $('#dlgUploads').showModal(); });
    $('#queuePill').addEventListener('click', function () { renderUploads(); $('#dlgUploads').showModal(); });
    $('#btnCloseUploads').addEventListener('click', function () { $('#dlgUploads').close(); });
    $('#btnSyncNow').addEventListener('click', function () {
      queue.forEach(function (q) { delete q.error; }); save(LS.queue, queue);
      if (!navigator.onLine) toast('Still offline. It will send when the connection returns.');
      processQueue();
    });
    $('#uploadsContent').addEventListener('click', function (e) {
      var id = e.target.getAttribute('data-dequeue');
      if (id) { dequeue(id); renderUploads(); renderQueuePill(); }
    });

    $('#btnSettings').addEventListener('click', openSettings);
    $('#sUnlock').addEventListener('change', function (e) { lockPricing(!e.target.checked); });
    $('#btnTest').addEventListener('click', function () {
      readSettings();
      var out = $('#testResult');
      if (!settings.scriptUrl) { out.textContent = 'Enter the Web App URL.'; return; }
      out.textContent = 'Testing…';
      api({ action: 'ping' }).then(function (r) {
        out.innerHTML = r.ok ? '<span style="color:var(--ok)">✓ Connected to “' + esc(r.spreadsheetName) + '”</span>' : '<span style="color:var(--bad)">' + esc(r.error) + '</span>';
      }).catch(function (e) { out.innerHTML = '<span style="color:var(--bad)">' + esc(e.message || 'Could not connect') + '</span>'; });
    });
    $('#dlgSettings').addEventListener('close', function () {
      if ($('#dlgSettings').returnValue !== 'save') return;
      readSettings(); save(LS.settings, settings); applyTheme(); render(); processQueue();
      toast('Settings saved.', 'ok', 2000);
    });

    window.addEventListener('online', function () { renderNet(); processQueue(); lookupDistances(); });
    window.addEventListener('offline', renderNet);
    document.addEventListener('visibilitychange', function () { if (document.hidden) save(LS.session, S); else processQueue(); });
    window.addEventListener('pagehide', function () { save(LS.session, S); });
    setInterval(processQueue, 60000);
  }

  // ---------- boot ----------
  consumeConnectLink();
  applyTheme();
  bind();
  renderNet();
  render();
  processQueue();
  lookupDistances();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
