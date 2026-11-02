/* Dodo Routes — Tookan route + Retool export → one route sheet (and pay) per driver. Vanilla JS, works offline. */
(function () {
  'use strict';

  var P = window.DodoPricing;
  var M = window.DodoMerge;
  var LS = {
    settings: 'dodoPay.settings', session: 'dodoRoutes.session.v2',
    queue: 'dodoPay.queue', history: 'dodoPay.history'
  };

  // ---------- storage ----------
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  var settings = Object.assign({ scriptUrl: '', token: '', pricing: {}, theme: '' }, load(LS.settings, {}));
  settings.pricing = Object.assign({}, P.DEFAULT_CONFIG, settings.pricing || {});
  var queue = load(LS.queue, []);
  var uploadHistory = load(LS.history, []);

  function emptyFile() { return { fileName: '', headers: [], rows: [], mapping: {} }; }
  function emptySession() { return { tookan: emptyFile(), retool: emptyFile(), date: '', edits: {}, routeAdj: {} }; }
  var S = Object.assign(emptySession(), load(LS.session, {}));
  var view = { route: '' }; // '' = all routes
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
  function telHref(digits) { return digits ? 'tel:' + digits : ''; }

  // ---------- dates ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function parseDate(v) {
    var s = M.clean(v), m;
    if (!s) return '';
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
  function niceDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? m[3] + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  }

  // ---------- CSV out ----------
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

  // ---------- loading ----------
  var KIND_LABEL = { tookan: 'Tookan route export', retool: 'Retool order export' };
  function fieldsFor(kind) { return kind === 'tookan' ? M.TOOKAN_FIELDS : M.RETOOL_FIELDS; }

  function loadText(text, name, zone) {
    var rows = M.parseCSV(text);
    if (rows.length < 2) { toast(esc(name) + ' has no data rows.', 'bad'); return; }
    var headers = rows[0].map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
    var kind = M.detectKind(headers) || zone;
    if (zone && kind !== zone) toast(esc(name) + ' looks like the ' + KIND_LABEL[kind] + ', so it went there.', '', 5000);
    if (!kind) { toast('Couldn\'t tell which export ' + esc(name) + ' is. Drop it on the matching box.', 'bad'); return; }
    S[kind] = {
      fileName: name, headers: headers, mapping: M.autoMap(headers, fieldsFor(kind)),
      rows: rows.slice(1).filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })
    };
    if (kind === 'tookan') { S.edits = {}; S.routeAdj = {}; S.date = ''; view.route = ''; }
    persist();
    render();
  }
  function readFiles(files, zone) {
    Array.prototype.slice.call(files).forEach(function (file) {
      var r = new FileReader();
      r.onload = function () { loadText(String(r.result), file.name, files.length > 1 ? '' : zone); };
      r.onerror = function () { toast('Could not read ' + esc(file.name) + '.', 'bad'); };
      r.readAsText(file);
    });
  }
  function ready() { return S.tookan.rows.length && S.retool.rows.length; }

  // ---------- build ----------
  function recalc() {
    var T = M.toObjects(S.tookan.headers, S.tookan.rows, S.tookan.mapping, M.TOOKAN_FIELDS);
    var R = M.toObjects(S.retool.headers, S.retool.rows, S.retool.mapping, M.RETOOL_FIELDS);
    var dates = {};
    T.forEach(function (t) { var d = parseDate(t.date); dates[d] = (dates[d] || 0) + 1; });
    var keys = Object.keys(dates).sort();
    if (S.date && !dates[S.date]) S.date = '';
    if (!S.date && keys.length > 1) S.date = keys.slice().sort(function (a, b) { return dates[b] - dates[a]; })[0];
    if (S.date) T = T.filter(function (t) { return parseDate(t.date) === S.date; });
    var out = M.build(T, R, { pricing: settings.pricing, edits: S.edits, routeAdj: S.routeAdj });
    out.dates = dates;
    out.routes.forEach(function (r) { r.ymd = parseDate(r.date); });
    result = out;
    return out;
  }

  // ---------- rendering ----------
  function render() {
    var has = ready();
    renderZones();
    $('#emptyView').classList.toggle('hidden', !!has);
    $('#loadedView').classList.toggle('hidden', !has);
    $('#actionbar').classList.toggle('hidden', !has);
    renderQueuePill();
    if (!has) return;
    recalc();
    renderFileBar();
    renderWarnings();
    renderStats();
    renderChips();
    renderRoutes();
    $('#abTotal').textContent = gbp(result.totals.payable);
    $('#abMeta').textContent = result.routes.length + ' routes · ' + result.totals.stops + ' stops' + (S.date ? ' · ' + tabLabel(S.date) : '');
  }

  function zoneHtml(kind, n, hint) {
    var f = S[kind];
    var done = f.rows.length > 0;
    return '<label class="drop' + (done ? ' done' : '') + '" data-zone="' + kind + '" tabindex="0">' +
      '<span class="icon">' + (done ? '✓' : n) + '</span>' +
      '<strong>' + KIND_LABEL[kind] + '</strong>' +
      (done ? '<span class="small">' + esc(f.fileName) + ' · ' + f.rows.length + ' rows</span><span class="small muted">Drop again to replace</span>'
        : '<span class="small muted">' + hint + '</span><span class="small muted">Drop CSV or click to choose</span>') +
      '<input type="file" accept=".csv,.tsv,.txt,text/csv" class="hidden" multiple></label>';
  }
  function renderZones() {
    $('#zones').innerHTML =
      zoneHtml('tookan', '1', 'Route order: Route ID, Service Type, Agent Name, Order ID…') +
      zoneHtml('retool', '2', 'Order details: Order ref, DP cost, Parcel count, Delivery instructions…');
  }

  function renderFileBar() {
    var keys = Object.keys(result.dates).sort();
    $('#fileChips').innerHTML = ['tookan', 'retool'].map(function (k) {
      return '<span class="filechip"><b>' + (k === 'tookan' ? 'Tookan' : 'Retool') + '</b> ' + esc(S[k].fileName) + ' <span class="muted">· ' + S[k].rows.length + ' rows</span></span>';
    }).join('');
    $('#fDate').innerHTML = (keys.length > 1 ? '<option value="">All dates</option>' : '') + keys.map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === S.date ? ' selected' : '') + '>' + esc(k ? tabLabel(k) : 'No date') + '</option>';
    }).join('');
    $('#dateWrap').classList.toggle('hidden', keys.length < 2);

    var grid = function (kind) {
      var f = S[kind];
      var opts = function (sel) {
        return '<option value="">— not in file —</option>' + f.headers.map(function (h) { return '<option' + (h === sel ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('');
      };
      return '<div class="mapgroup"><div class="small" style="font-weight:700;margin:8px 0 4px">' + KIND_LABEL[kind] + '</div><div class="mapgrid">' +
        fieldsFor(kind).map(function (fd) {
          return '<label class="field">' + esc(fd.label) + (fd.req ? ' *' : '') + '<select data-kind="' + kind + '" data-map="' + fd.key + '">' + opts(f.mapping[fd.key]) + '</select></label>';
        }).join('') + '</div></div>';
    };
    $('#mappingGrid').innerHTML = grid('tookan') + grid('retool');
    var missing = ['tookan', 'retool'].some(function (k) { return fieldsFor(k).some(function (fd) { return fd.req && !S[k].mapping[fd.key]; }); });
    if (missing) $('#colsDetails').open = true;
    $('#notices').innerHTML = missing ? '<div class="notice bad">Some required columns weren\'t found. Open <b>Column matching</b> and pick them.</div>' : '';
  }

  var WARN_TITLE = {
    unmatched: 'Not in Retool (skipped from route sheet)', driver: 'Driver differs between Tookan and Retool',
    cancelled: 'Cancelled in Retool', nocost: 'No Retool DP cost (card used)', unpriced: 'No cost and no miles',
    single: 'Pickup or delivery task missing', mismatch: 'Retool DP cost differs from card'
  };
  function allWarnings() {
    var w = result.unmatched.map(function (u) {
      return { kind: 'unmatched', routeId: u.routeId, agentName: u.agentName, orderId: u.orderId, text: 'Tookan ' + u.types.join(' + ').toLowerCase() + ' task has no Retool order with this ref' };
    }).concat(result.warnings);
    result.routes.forEach(function (r) {
      r.orders.forEach(function (o) {
        if (o.mismatch) w.push({ kind: 'mismatch', routeId: r.routeId, agentName: r.agentName, orderId: o.ref, text: 'Retool ' + gbp(o.dpCost) + ' vs card ' + gbp(o.cardFee) + ' (' + o.miles + ' mi), diff ' + gbp(o.diff) });
      });
    });
    return w;
  }
  function renderWarnings() {
    var w = allWarnings();
    var box = $('#warnings');
    box.classList.toggle('hidden', !w.length);
    if (!w.length) return;
    var groups = {};
    w.forEach(function (x) { (groups[x.kind] = groups[x.kind] || []).push(x); });
    var order = ['unmatched', 'driver', 'cancelled', 'unpriced', 'nocost', 'single', 'mismatch'];
    var serious = (groups.unmatched || []).length + (groups.driver || []).length + (groups.cancelled || []).length + (groups.unpriced || []).length;
    var wasOpen = box.querySelector('details') && box.querySelector('details').open;
    box.innerHTML = '<details' + (wasOpen || serious ? ' open' : '') + '><summary><span class="badge ' + (serious ? 'bad' : 'warn') + '">' + w.length + '</span> Checks for Ops' +
      '<span class="muted small"> · ' + order.filter(function (k) { return groups[k]; }).map(function (k) { return groups[k].length + ' × ' + WARN_TITLE[k]; }).join(' · ') + '</span></summary>' +
      order.filter(function (k) { return groups[k]; }).map(function (k) {
        return '<div class="wgroup"><div class="wtitle">' + WARN_TITLE[k] + ' (' + groups[k].length + ')</div><table class="tbl"><tbody>' +
          groups[k].map(function (x) {
            return '<tr><td class="id">' + esc(x.orderId) + '</td><td class="small">Route ' + esc(x.routeId) + ' · ' + esc(x.agentName) + '</td><td class="small">' + esc(x.text) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }).join('') + '</details>';
  }

  function renderStats() {
    var t = result.totals;
    $('#stats').innerHTML = [
      ['Routes', t.routes], ['Stops', t.stops], ['Orders', t.orders], ['Parcels', t.parcels],
      ['Driver pay', gbp(t.payable), 'card ' + gbp(t.cardTotal)]
    ].map(function (s) { return '<div class="stat"><div class="k">' + s[0] + '</div><div class="v">' + s[1] + '</div>' + (s[2] ? '<div class="small muted">' + s[2] + '</div>' : '') + '</div>'; }).join('');
  }

  function renderChips() {
    if (view.route && !result.routes.some(function (r) { return r.routeId === view.route; })) view.route = '';
    $('#chips').innerHTML = '<button class="chip" data-route="" aria-pressed="' + (view.route === '') + '">All routes</button>' +
      result.routes.map(function (r) {
        return '<button class="chip" data-route="' + esc(r.routeId) + '" aria-pressed="' + (view.route === r.routeId) + '">' + esc(r.agentName) + '<span class="c">' + esc(r.routeId) + '</span></button>';
      }).join('');
  }

  function routeCard(r) {
    var h = '<article class="card sheet" data-route="' + esc(r.routeId) + '">';
    // Header: mirrors the Tookan route PDF, plus pay.
    h += '<header class="sheet-head">' +
      '<div class="sh-top"><div class="sh-company">Dodo Delivery</div><div class="sh-date">Date : <b>' + esc(r.date || niceDate(r.ymd)) + '</b></div></div>' +
      '<div class="sh-driver">Driver ID : <b>' + esc(r.agentId || '—') + '</b><span class="sp"></span>Driver Name : <b>' + esc(r.agentName) + '</b></div>' +
      '<div class="sh-meta"><span class="route-badge">Route ID ' + esc(r.routeId) + '</span>' +
      '<span>Estimated Time : <b>' + esc(r.estTimeText || '—') + '</b></span>' +
      '<span>Estimated Distance : <b>' + esc(r.estDistText || '—') + '</b></span>' +
      '<span class="spacer"></span>' +
      '<span class="sh-pay"><span class="k">Driver pay</span><span class="v">' + gbp(r.payable) + '</span>' +
      '<span class="k2">' + r.orderCount + ' orders · ' + r.parcels + ' parcels' + (r.vehicles.length ? ' · ' + esc(r.vehicles.join(', ')) : '') + '</span></span>' +
      '<button class="btn quiet noprint" data-print="' + esc(r.routeId) + '" type="button">Print</button></div></header>';

    // Main route table — Tookan sequence, untouched.
    h += '<div class="wrap"><table class="tbl route stack"><colgroup><col class="c-seq"><col class="c-type"><col class="c-id"><col class="c-name"><col class="c-addr"><col class="c-phone"><col class="c-time"><col class="c-parcels"><col class="c-instr"><col class="c-pay"><col class="c-sig"></colgroup><thead><tr>' +
      '<th>Seq</th><th>Service Type</th><th>Order ID</th><th>Customer / Merchant</th><th>Address</th><th>Phone</th><th>Time</th>' +
      '<th class="num">Parcels</th><th>Instructions</th><th class="num">Pay</th><th class="sig">Signature</th></tr></thead><tbody>' +
      r.stops.map(function (s) {
        var o = s.order;
        var pay = '';
        if (s.showCost) {
          pay = o.cost == null ? '<span class="badge bad">no cost</span>' : '<b>' + gbp(o.total) + '</b>';
          if (o.costSource === 'card') pay += '<span class="sub noprint"><span class="badge warn" title="No Retool DP cost">card</span></span>';
          if (o.mismatch) pay += '<span class="sub noprint"><span class="badge warn" title="Retool DP cost differs from the Dodo card">card ' + gbp(o.cardFee) + '</span></span>';
        }
        return '<tr class="' + (s.type === 'PICKUP' ? 'pu' : 'de') + (o.cancelled ? ' cx' : '') + '">' +
          '<td class="seq" data-l="Seq">' + s.seq + '</td>' +
          '<td data-l="Type"><span class="stype ' + (s.type === 'PICKUP' ? 'p' : 'd') + '">' + esc(s.type) + '</span></td>' +
          '<td class="id" data-l="Order ID">' + esc(s.ref) + '</td>' +
          '<td data-l="Name">' + esc(s.name) + '</td>' +
          '<td data-l="Address">' + esc(s.address) + '</td>' +
          '<td data-l="Phone">' + (s.phone ? '<a class="tel" href="' + esc(telHref(s.phoneTel)) + '">' + esc(s.phone) + '</a>' : '') + '</td>' +
          '<td data-l="Time" class="nowrap">' + esc(s.time) + '</td>' +
          '<td class="num" data-l="Parcels">' + (s.parcels == null ? '' : s.parcels) + '</td>' +
          '<td class="instr" data-l="Instructions">' + esc(s.instructions) + '</td>' +
          '<td class="num" data-l="Pay">' + pay + '</td>' +
          '<td class="sig" data-l="Signature"></td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td colspan="7">' + r.stops.length + ' stops · ' + r.orderCount + ' orders</td><td class="num">' + r.parcels + '</td><td></td><td class="num">' + gbp(r.payable) + '</td><td class="sig"></td></tr></tfoot></table></div>';

    // Pay & reconciliation (screen only).
    var open = r.mismatches || r.cardFallbacks || r.unpriced;
    h += '<section class="noprint"><details class="payd"' + (open ? ' open' : '') + '><summary><span class="chev">▶</span><span class="sec-title">Pay &amp; reconciliation</span>' +
      (r.mismatches ? '<span class="badge warn">' + r.mismatches + ' differ from card</span>' : '') +
      (r.cardFallbacks ? '<span class="badge warn">' + r.cardFallbacks + ' card fallback</span>' : '') +
      '<span class="spacer"></span><span class="small muted">Retool ' + gbp(r.cost) + ' · card ' + gbp(r.cardTotal) + '</span></summary>' +
      '<div class="wrap"><table class="tbl"><thead><tr><th>Order</th><th>Merchant</th><th class="num">Miles</th><th class="num">Retool DP cost</th><th class="num">Card</th><th class="num">Diff</th>' +
      '<th class="num">Extra £</th><th>Remark</th><th class="num">Total</th></tr></thead><tbody>' +
      r.orders.map(function (o) {
        return '<tr data-key="' + esc(o.key) + '"><td class="id">' + esc(o.ref) + '</td><td class="small">' + esc(o.merchant) + '</td>' +
          '<td class="num">' + (o.miles == null ? '—' : o.miles.toFixed(2)) + '</td>' +
          '<td class="num">' + (o.dpCost == null ? '<span class="badge warn">missing</span>' : gbp(o.dpCost)) + '</td>' +
          '<td class="num small" title="' + esc(o.card ? o.card.breakdown : '') + '">' + (o.cardFee == null ? '—' : gbp(o.cardFee)) + '</td>' +
          '<td class="num">' + (o.mismatch ? '<span class="badge warn">' + gbp(o.diff) + '</span>' : '') + '</td>' +
          '<td class="num"><input class="money extra" type="number" step="0.01" value="' + esc(o.extraRaw) + '" placeholder="0.00" aria-label="Extra charge"></td>' +
          '<td><input class="remark" value="' + esc(o.remark) + '" placeholder="Remark" aria-label="Remark"></td>' +
          '<td class="num"><b>' + (o.total == null ? '—' : gbp(o.total)) + '</b></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="adj"><span class="small" style="font-weight:650">Route extra / deduction £</span>' +
      '<input class="money radj" type="number" step="0.01" data-route="' + esc(r.routeId) + '" value="' + esc(r.adjustmentRaw) + '" placeholder="0.00">' +
      '<input class="remark rremark" data-route="' + esc(r.routeId) + '" value="' + esc(r.adjustmentRemark) + '" placeholder="Reason, e.g. waiting time" style="flex:1;min-width:160px"></div>' +
      '<div class="adj small"><span class="muted">Retool DP cost ' + gbp(r.cost) + ' + extras ' + gbp(r.extras) + ' + route ' + gbp(r.adjustment) + '</span><span class="spacer"></span><b>= ' + gbp(r.payable) + '</b></div>' +
      '</details></section>';

    // Optional secondary summaries (screen only).
    h += '<section class="noprint"><details class="payd"><summary><span class="chev">▶</span><span class="sec-title">Pickup &amp; delivery summaries</span></summary>' +
      summaries(r) + '</details></section>';
    return h + '</article>';
  }

  function summaries(r) {
    var g = {}, list = [];
    r.stops.forEach(function (s) {
      if (s.type !== 'PICKUP') return;
      var k = s.name + '|' + s.address;
      if (!g[k]) { g[k] = { name: s.name, address: s.address, phone: s.phone, time: s.time, ids: [], parcels: 0 }; list.push(g[k]); }
      g[k].ids.push(s.ref);
      g[k].parcels += s.parcels || 0;
    });
    var dels = r.stops.filter(function (s) { return s.type === 'DELIVERY'; });
    return '<div class="sumgrid"><div><div class="wtitle">Collect from</div><table class="tbl"><thead><tr><th>Merchant</th><th>Orders</th><th class="num">Parcels</th></tr></thead><tbody>' +
      list.map(function (p) { return '<tr><td><b>' + esc(p.name) + '</b><span class="sub">' + esc(p.address) + '</span></td><td class="small">' + p.ids.map(esc).join(', ') + '</td><td class="num">' + p.parcels + '</td></tr>'; }).join('') +
      '</tbody></table></div><div><div class="wtitle">Deliver to</div><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Slot</th><th class="num">Parcels</th></tr></thead><tbody>' +
      dels.map(function (s) { return '<tr><td class="id">' + esc(s.ref) + '</td><td>' + esc(s.name) + '</td><td class="small">' + esc(s.order.deliverySlot || s.time) + '</td><td class="num">' + (s.parcels == null ? '' : s.parcels) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  function renderRoutes() {
    var open = {};
    $$('#routes details.payd').forEach(function (el, i) { open[el.closest('.sheet').dataset.route + ':' + i % 2] = el.open; });
    var list = result.routes.filter(function (r) { return !view.route || view.route === r.routeId; });
    $('#routes').innerHTML = list.length ? list.map(routeCard).join('') :
      '<div class="card muted" style="text-align:center;padding:32px">No route stops matched the Retool export for this date.</div>';
    $$('#routes details.payd').forEach(function (el, i) {
      var k = el.closest('.sheet').dataset.route + ':' + i % 2;
      if (open[k] !== undefined) el.open = open[k];
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
    var all = recalc();
    var m = P.money;
    var byDate = {};
    all.routes.forEach(function (r) { (byDate[r.ymd] = byDate[r.ymd] || []).push(r); });
    var warns = allWarnings();
    return Object.keys(byDate).sort().map(function (ymd) {
      var routes = byDate[ymd];
      var ids = routes.map(function (r) { return r.routeId; });
      var sum = function (rows, i) { return m(rows.reduce(function (s, x) { return s + (Number(x[i]) || 0); }, 0)); };
      var summary = routes.map(function (r) {
        return [r.routeId, r.agentId, r.agentName, r.stops.length, r.orderCount, r.parcels, r.estTimeText, r.estDistText,
          r.cost, r.cardTotal, m(r.cost - r.cardTotal), r.extras, r.adjustment, r.adjustmentRemark, r.payable];
      });
      var total = sum(summary, 14);
      var sections = [{
        title: 'ROUTE & DRIVER PAY SUMMARY (pay = Retool DP cost)',
        header: ['Route ID', 'Driver ID', 'Driver', 'Stops', 'Orders', 'Parcels', 'Est. time', 'Est. distance', 'Retool DP cost £', 'Card £', 'Retool − card £', 'Extras £', 'Route adj. £', 'Route remark', 'Final payable £'],
        rows: summary,
        totals: ['TOTAL', '', '', sum(summary, 3), sum(summary, 4), sum(summary, 5), '', '', sum(summary, 8), sum(summary, 9), sum(summary, 10), sum(summary, 11), sum(summary, 12), '', total],
        money: [8, 9, 10, 11, 12, 14]
      }];
      routes.forEach(function (r) {
        sections.push({
          driverHeading: 'Route ' + r.routeId + '  ·  ' + r.agentName + ' (' + r.agentId + ')  ·  ' + r.stops.length + ' stops  ·  ' + r.estTimeText + '  ·  ' + r.estDistText + '  ·  pay ' + gbp(r.payable),
          title: 'Route sequence (Tookan order)',
          header: ['Seq', 'Service Type', 'Order ID', 'Customer / Merchant', 'Address', 'Phone', 'Time', 'Parcels', 'Instructions', 'Pay £'],
          rows: r.stops.map(function (s) {
            return [s.seq, s.type, s.ref, s.name, s.address, s.phone ? "'" + s.phone : '', s.time, s.parcels == null ? '' : s.parcels, s.instructions, s.showCost && s.order.total != null ? s.order.total : ''];
          }),
          money: [9]
        });
      });
      var rec = [];
      routes.forEach(function (r) {
        r.orders.forEach(function (o) {
          rec.push([r.routeId, r.agentName, o.ref, o.merchant, o.dp, o.status, o.miles == null ? '' : o.miles, o.dpCost == null ? '' : o.dpCost,
            o.cardFee == null ? '' : o.cardFee, o.diff == null ? '' : o.diff, o.cost == null ? '' : o.cost, o.costSource, o.extra, o.remark,
            o.total == null ? '' : o.total, o.mismatch ? 'Retool ≠ card' : (o.costSource === 'card' ? 'Card fallback' : '')]);
        });
      });
      sections.push({
        title: 'PAY RECONCILIATION (per order)',
        header: ['Route ID', 'Driver', 'Order ref', 'Merchant', 'DP', 'Status', 'Miles', 'Retool DP cost £', 'Card £', 'Diff £', 'Cost used £', 'Source', 'Extra £', 'Remark', 'Order total £', 'Flag'],
        rows: rec, money: [7, 8, 9, 10, 12, 14]
      });
      var w = warns.filter(function (x) { return ids.indexOf(x.routeId) >= 0; });
      if (w.length) sections.push({ title: 'CHECKS FOR OPS', header: ['Issue', 'Route ID', 'Driver', 'Order', 'Detail'], rows: w.map(function (x) { return [WARN_TITLE[x.kind], x.routeId, x.agentName, x.orderId, x.text]; }) });
      return {
        tabName: tabLabel(ymd), count: routes.reduce(function (s, r) { return s + r.stops.length; }, 0), total: gbp(total),
        body: {
          meta: { formula: 'Driver pay = Retool DP cost per order (Dodo card used only when DP cost is missing: ' + P.describe(settings.pricing) + ')', generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }), sourceFile: S.tookan.fileName + ' + ' + S.retool.fileName, totalPayable: total },
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
    if (!result.routes.length) { toast('Nothing to upload yet.', 'bad'); return; }
    if (result.unmatched.length && !confirm(result.unmatched.length + ' Tookan orders aren\'t in the Retool export and are left out. Upload anyway?')) return;
    var payloads = buildPayloads();
    payloads.forEach(function (p) {
      queue = queue.filter(function (q) { return q.tabName !== p.tabName; });
      queue.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), tabName: p.tabName, count: p.count, total: p.total, body: p.body, createdAt: Date.now(), mode: null });
    });
    save(LS.queue, queue);
    renderQueuePill();
    if (!settings.scriptUrl || !settings.token) { toast('Saved. Connect Google Sheets in Settings to send it.', '', 7000); openSettings(); return; }
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
        toast('✓ Uploaded <b>' + esc(res.tabName) + '</b> (' + item.count + ' stops, ' + esc(item.total) + '). <a href="' + esc(res.url) + '" target="_blank" rel="noopener">Open tab ↗</a>', 'ok', 15000);
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
      return '<div class="row"><b>' + esc(q.tabName) + '</b><span class="muted small">' + q.count + ' stops · ' + esc(q.error ? 'Error: ' + q.error : (navigator.onLine ? 'ready' : 'offline')) + '</span><span class="spacer"></span><button class="btn quiet" data-dequeue="' + esc(q.id) + '" type="button">Remove</button></div>';
    }).join('') : '<span class="muted small">Nothing waiting.</span>');
    h += '<h4>Recent uploads</h4>' + (uploadHistory.length ? uploadHistory.slice(0, 15).map(function (x) {
      return '<div class="row small"><b>' + esc(x.tabName) + '</b><span class="muted">' + esc(x.mode) + ' · ' + esc(x.total || '') + ' · ' + esc(new Date(x.at).toLocaleString('en-GB')) + '</span><span class="spacer"></span>' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">Open ↗</a>' : '') + '</div>';
    }).join('') : '<span class="muted small">No uploads yet.</span>');
    $('#uploadsContent').innerHTML = h;
  }

  // ---------- settings ----------
  function openSettings() {
    $('#sUrl').value = settings.scriptUrl; $('#sToken').value = settings.token;
    $('#sBase').value = settings.pricing.base; $('#sPerMile').value = settings.pricing.perMile; $('#sFloor').value = settings.pricing.floor;
    $('#sBand').value = settings.pricing.bandMiles;
    $('#sTheme').value = settings.theme || '';
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
    settings.pricing = { base: num('#sBase', D.base), perMile: num('#sPerMile', D.perMile), floor: num('#sFloor', D.floor), bandMiles: num('#sBand', D.bandMiles), extraDropFee: 0 };
    settings.theme = $('#sTheme').value;
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

  // ---------- printing: one PDF, one route per page ----------
  function printRoutes(routeId) {
    $$('#routes .sheet').forEach(function (c) { c.classList.toggle('print-target', c.dataset.route === routeId); });
    document.body.classList.toggle('print-one', !!routeId);
    window.print();
  }
  window.addEventListener('afterprint', function () { document.body.classList.remove('print-one'); });

  // ---------- events ----------
  function bind() {
    var zones = $('#zones');
    zones.addEventListener('change', function (e) {
      if (e.target.type !== 'file') return;
      var z = e.target.closest('.drop').dataset.zone;
      if (e.target.files.length) readFiles(e.target.files, z);
    });
    zones.addEventListener('keydown', function (e) {
      var d = e.target.closest('.drop');
      if (d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d.querySelector('input').click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zones.addEventListener(ev, function (e) { var d = e.target.closest('.drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
    });
    zones.addEventListener('dragleave', function (e) { var d = e.target.closest('.drop'); if (d) d.classList.remove('over'); });
    zones.addEventListener('drop', function (e) {
      var d = e.target.closest('.drop');
      if (!d) return;
      e.preventDefault();
      d.classList.remove('over');
      if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files, d.dataset.zone);
    });

    $('#btnReplace').addEventListener('click', function () { view.replacing = true; $('#emptyView').classList.remove('hidden'); $('#emptyView').scrollIntoView({ behavior: 'smooth' }); });
    $('#btnClear').addEventListener('click', function () {
      if (!confirm('Clear both files and any extras/remarks you added?')) return;
      S = emptySession(); save(LS.session, S); render();
    });
    $('#btnSample').addEventListener('click', function () {
      loadText(window.DODO_SAMPLE_TOOKAN, 'sample-tookan-routes.csv', 'tookan');
      loadText(window.DODO_SAMPLE_RETOOL, 'sample-retool-export.csv', 'retool');
    });

    $('#mappingGrid').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-map'), kind = e.target.getAttribute('data-kind');
      if (!k || !kind) return;
      S[kind].mapping[k] = e.target.value;
      persist(); render();
    });
    $('#fDate').addEventListener('change', function (e) { S.date = e.target.value; persist(); render(); });

    $('#chips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      view.route = b.dataset.route;
      render();
    });

    $('#routes').addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.route) {
        var a = S.routeAdj[t.dataset.route] = S.routeAdj[t.dataset.route] || {};
        if (t.classList.contains('radj')) a.amount = t.value === '' ? '' : Number(t.value);
        else a.remark = t.value;
        persist(); render(); return;
      }
      var tr = t.closest('tr[data-key]');
      if (!tr) return;
      var ed = S.edits[tr.dataset.key] = S.edits[tr.dataset.key] || {};
      if (t.classList.contains('extra')) ed.extra = t.value === '' ? '' : Number(t.value);
      else if (t.classList.contains('remark')) ed.remark = t.value;
      else return;
      persist(); render();
    });
    $('#routes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-print]');
      if (b) printRoutes(b.dataset.print);
    });

    $('#btnUpload').addEventListener('click', startUpload);
    $('#btnPrintAll').addEventListener('click', function () { printRoutes(view.route); });
    $('#btnCsv').addEventListener('click', function () {
      var rows = [['Date', 'Route ID', 'Driver ID', 'Driver', 'Seq', 'Service Type', 'Order ID', 'Customer / Merchant', 'Address', 'Phone', 'Time', 'Parcels', 'Instructions', 'Merchant', 'Miles', 'Retool DP cost', 'Card fee', 'Extra', 'Remark', 'Order pay']];
      recalc().routes.forEach(function (r) {
        r.stops.forEach(function (s) {
          var o = s.order;
          rows.push([r.date, r.routeId, r.agentId, r.agentName, s.seq, s.type, s.ref, s.name, s.address, s.phone, s.time, s.parcels == null ? '' : s.parcels, s.instructions,
            o.merchant, o.miles == null ? '' : o.miles, s.showCost && o.dpCost != null ? o.dpCost : '', s.showCost && o.cardFee != null ? o.cardFee : '',
            s.showCost ? o.extra || '' : '', s.showCost ? o.remark : '', s.showCost && o.total != null ? o.total : '']);
        });
      });
      download('dodo-routes-' + tabLabel(S.date || (result.routes[0] && result.routes[0].ymd)) + '.csv', toCSV(rows));
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

    window.addEventListener('online', function () { renderNet(); processQueue(); });
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
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
