/* Dodo Routes — Tookan route + Retool export → one branded route sheet (and pay) per driver.
   Vanilla JS, works offline, and shares one live workspace with the team via the Apps Script. */
(function () {
  'use strict';

  var P = window.DodoPricing;
  var M = window.DodoMerge;
  var LS = {
    settings: 'dodoPay.settings', session: 'dodoRoutes.session.v2', queue: 'dodoPay.queue',
    history: 'dodoPay.history', pending: 'dodoRoutes.pendingOps', client: 'dodoRoutes.clientId'
  };

  // ---------- storage ----------
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  var settings = Object.assign({ scriptUrl: '', token: '', pricing: {}, theme: '', name: '', live: true }, load(LS.settings, {}));
  settings.pricing = Object.assign({}, P.DEFAULT_CONFIG, settings.pricing || {});
  var queue = load(LS.queue, []);
  var uploadHistory = load(LS.history, []);
  var clientId = load(LS.client, '') || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  save(LS.client, clientId);

  function emptyFile() { return { fileName: '', headers: [], rows: [], mapping: {} }; }
  function emptySession() {
    return { tookan: emptyFile(), retool: emptyFile(), date: '', edits: {}, routeAdj: {}, editMeta: {}, adjMeta: {}, liveVersion: -1, liveFilesVersion: -1, lastActivityAt: 0 };
  }
  var S = Object.assign(emptySession(), load(LS.session, {}));
  var view = { route: null, all: false };
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
  var FACE_COLORS = ['#4b3bff', '#1a8fe0', '#0c1832', '#157a46', '#b36b00', '#b3261e', '#6b4fd8'];
  function colorFor(name) {
    var h = 0;
    String(name).split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    return FACE_COLORS[h % FACE_COLORS.length];
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?';
  }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }

  // Workspace "/a/<domain>/macros/" URLs can redirect to a Google login, which the browser can't read.
  function cleanScriptUrl(u) { return String(u || '').trim().replace(/\/a\/[^\/]+\/macros\//, '/macros/').replace(/\/dev(\?.*)?$/, '/exec'); }
  settings.scriptUrl = cleanScriptUrl(settings.scriptUrl);
  // Connection built into the site (config.js) always wins, so a stale saved value can't break anyone.
  var CFG = window.DODO_CONFIG || {};
  var managed = !!(CFG.scriptUrl && CFG.token);
  if (managed) { settings.scriptUrl = cleanScriptUrl(CFG.scriptUrl); settings.token = String(CFG.token).trim(); }

  // ---------- dates ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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
  function longDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return 'Routes';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DAYS[d.getUTCDay()] + ' ' + Number(m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
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

  function loadText(text, name, zone, fromSample) {
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
    if (kind === 'tookan') { S.edits = {}; S.routeAdj = {}; S.editMeta = {}; S.adjMeta = {}; S.date = ''; view.route = null; }
    persist();
    pushFile(kind, S[kind]);
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

  // ---------- checks ----------
  var WARN_TITLE = {
    unmatched: 'Not in the Retool export — left off the driver sheet', driver: 'Different driver in Tookan and Retool',
    cancelled: 'Cancelled in Retool', unpriced: 'No price and no miles', nocost: 'No DP cost in Retool (card rate used)',
    single: 'Only a pickup or only a delivery in Tookan', mismatch: 'Retool price differs from the Dodo card'
  };
  var SERIOUS = ['unmatched', 'driver', 'cancelled', 'unpriced'];
  function allWarnings() {
    var w = result.unmatched.map(function (u) {
      return { kind: 'unmatched', routeId: u.routeId, agentName: u.agentName, orderId: u.orderId, text: 'Tookan ' + u.types.join(' + ').toLowerCase() + ' task has no matching Retool order' };
    }).concat(result.warnings);
    result.routes.forEach(function (r) {
      r.orders.forEach(function (o) {
        if (o.mismatch) w.push({ kind: 'mismatch', routeId: r.routeId, agentName: r.agentName, orderId: o.ref, text: 'Retool ' + gbp(o.dpCost) + ' vs card ' + gbp(o.cardFee) + ' (' + o.miles + ' mi)' });
      });
    });
    return w;
  }
  function routeIssues(r, w) {
    var mine = w.filter(function (x) { return x.routeId === r.routeId; });
    return { serious: mine.filter(function (x) { return SERIOUS.indexOf(x.kind) >= 0; }).length, info: mine.length };
  }

  // ---------- rendering ----------
  function render() {
    var focus = rememberFocus();
    var has = ready();
    renderZones();
    renderLive();
    renderQueueBadge();
    $('#stepUpload').classList.toggle('hidden', !!has);
    $('#stepCheck').classList.toggle('hidden', !has);
    $('#actionbar').classList.toggle('hidden', !has);
    renderSteps(has);
    if (has) {
      recalc();
      var w = allWarnings();
      renderSummary();
      renderChecks(w);
      renderDrivers(w);
      renderRoutes();
      $('#abTotal').textContent = gbp(result.totals.payable);
    }
    restoreFocus(focus);
  }

  function renderSteps(has) {
    var sent = has && uploadHistory.some(function (h) { return h.tabName === tabLabel(S.date || (result && result.routes[0] && result.routes[0].ymd)); });
    $$('.steps li').forEach(function (li) {
      var n = +li.dataset.step;
      li.classList.toggle('done', n === 1 ? !!has : (n === 2 ? !!has && !!view.checked : !!sent));
      li.classList.toggle('current', n === (has ? 2 : 1));
    });
  }

  // The upload boxes are built once and then updated in place: rebuilding them would throw away
  // a file input that is in use (e.g. a teammate's change arriving while a file is being picked).
  var ZONE_INFO = {
    tookan: { n: '1', what: 'Gives the <b>stop order</b> for each driver (Route ID, Service Type, Agent Name, Order ID…)' },
    retool: { n: '2', what: 'Gives <b>parcels, instructions and driver pay</b> (Order ref, DP cost, Parcel count…)' }
  };
  function zoneShell(kind) {
    return '<label class="drop" data-zone="' + kind + '" tabindex="0">' +
      '<span class="top"><span class="icon"></span><strong>' + KIND_LABEL[kind] + '</strong></span>' +
      '<span class="what">' + ZONE_INFO[kind].what + '</span><span class="small meta"></span><span class="cta"></span>' +
      '<input type="file" accept=".csv,.tsv,.txt,text/csv" class="hidden" multiple aria-label="' + KIND_LABEL[kind] + '"></label>';
  }
  function renderZones() {
    $$('[data-zones]').forEach(function (z) {
      if (!z.children.length) z.innerHTML = zoneShell('tookan') + zoneShell('retool');
      $$('.drop', z).forEach(function (d) {
        var kind = d.dataset.zone, f = S[kind], done = f.rows.length > 0;
        d.classList.toggle('done', done);
        $('.icon', d).textContent = done ? '✓' : ZONE_INFO[kind].n;
        $('.meta', d).innerHTML = done ? '<b>' + esc(f.fileName) + '</b> · ' + f.rows.length + ' rows' + (f.by ? ' · by ' + esc(f.by) : '') : '';
        $('.cta', d).textContent = done ? 'Drop again to replace' : 'Drop the CSV here, or click to choose';
      });
    });
    $('#liveHint').innerHTML = liveOn() ? '👥 Files you upload here are shared with your team automatically.' :
      (settings.scriptUrl ? '' : 'Working on your own. Connect Google Sheets (⋯ → Settings) to share live with your team.');
  }

  function renderSummary() {
    var t = result.totals;
    var keys = Object.keys(result.dates).sort();
    var ymd = S.date || (result.routes[0] && result.routes[0].ymd);
    $('#sumWhen').textContent = longDate(ymd);
    $('#sumFacts').innerHTML = '<b>' + t.routes + '</b> drivers · <b>' + t.stops + '</b> stops · <b>' + t.parcels + '</b> parcels · <b>' + gbp(t.payable) + '</b> driver pay';
    $('#fileChips').innerHTML = ['tookan', 'retool'].map(function (k) {
      return '<span class="filechip"><b>' + (k === 'tookan' ? 'Tookan' : 'Retool') + '</b> ' + esc(S[k].fileName) + ' <span class="muted">· ' + S[k].rows.length + ' rows' + (S[k].by ? ' · ' + esc(S[k].by) : '') + '</span></span>';
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
      return '<div class="small" style="font-weight:700;margin:10px 0 2px">' + KIND_LABEL[kind] + '</div><div class="mapgrid">' +
        fieldsFor(kind).map(function (fd) {
          return '<label class="field">' + esc(fd.label) + (fd.req ? ' *' : '') + '<select data-kind="' + kind + '" data-map="' + fd.key + '">' + opts(f.mapping[fd.key]) + '</select></label>';
        }).join('') + '</div>';
    };
    $('#mappingGrid').innerHTML = grid('tookan') + grid('retool');
    var missing = ['tookan', 'retool'].some(function (k) { return fieldsFor(k).some(function (fd) { return fd.req && !S[k].mapping[fd.key]; }); });
    if (missing) $('#colsDetails').open = true;
    $('#notices').innerHTML = missing ? '<div class="notice bad">Some required columns weren\'t found. Pick them under <b>Column matching</b>.</div>' : '';
  }

  function renderChecks(w) {
    var serious = w.filter(function (x) { return SERIOUS.indexOf(x.kind) >= 0; });
    var info = w.filter(function (x) { return SERIOUS.indexOf(x.kind) < 0; });
    var groups = function (list) {
      var g = {};
      list.forEach(function (x) { (g[x.kind] = g[x.kind] || []).push(x); });
      return Object.keys(g).map(function (k) {
        return '<details' + (SERIOUS.indexOf(k) >= 0 ? ' open' : '') + '><summary>' + g[k].length + ' × ' + esc(WARN_TITLE[k]) + '</summary><table class="wtable"><tbody>' +
          g[k].map(function (x) { return '<tr><td><b>' + esc(x.orderId) + '</b></td><td>' + esc(x.agentName) + ' · route ' + esc(x.routeId) + '</td><td>' + esc(x.text) + '</td></tr>'; }).join('') +
          '</tbody></table></details>';
      }).join('');
    };
    var html;
    if (!serious.length) {
      html = '<div class="callout good"><div class="ttl">✓ Every order matched. Ready to print.</div>' +
        (info.length ? '<details><summary>' + info.length + ' notes for Ops (pay differences etc.)</summary>' + groups(info) + '</details>' : '') + '</div>';
    } else {
      html = '<div class="callout ' + (serious.some(function (x) { return x.kind === 'unmatched'; }) ? 'bad' : 'warn') + '"><div class="ttl">⚠ ' + serious.length + ' thing' + (serious.length > 1 ? 's' : '') + ' to check before printing</div>' +
        groups(serious) + (info.length ? '<details><summary>' + info.length + ' more notes for Ops</summary>' + groups(info) + '</details>' : '') + '</div>';
    }
    $('#checks').innerHTML = html;
  }

  function lastEditor(r) {
    var best = null;
    Object.keys(S.editMeta || {}).forEach(function (k) {
      if (k.indexOf(r.routeId + '|') === 0 && (!best || S.editMeta[k].at > best.at)) best = S.editMeta[k];
    });
    var a = (S.adjMeta || {})[r.routeId + '.amount'] || (S.adjMeta || {})[r.routeId + '.remark'];
    if (a && (!best || a.at > best.at)) best = a;
    return best;
  }

  function renderDrivers(w) {
    if (view.route === null || !result.routes.some(function (r) { return r.routeId === view.route; })) view.route = result.routes[0] ? result.routes[0].routeId : '';
    $('#driverGrid').innerHTML = result.routes.map(function (r) {
      var is = routeIssues(r, w), ed = lastEditor(r);
      var st = is.serious ? '<span class="status bad">⚠ ' + is.serious + ' to check</span>' : '<span class="status ok">✓ Ready</span>';
      return '<button class="dcard" role="listitem" type="button" data-route="' + esc(r.routeId) + '" aria-pressed="' + (!view.all && view.route === r.routeId) + '">' +
        '<span class="who"><span class="avatar" style="background:' + colorFor(r.agentName) + '">' + esc(initials(r.agentName)) + '</span>' +
        '<span><span class="nm">' + esc(r.agentName) + '</span><span class="sub" style="display:block">Route ' + esc(r.routeId) + ' · ' + r.stops.length + ' stops · ' + r.parcels + ' parcels</span></span></span>' +
        '<span class="payrow"><span class="pay">' + gbp(r.payable) + '</span>' + st + '</span>' +
        (ed ? '<span class="by">Edited by ' + esc(ed.by) + ' · ' + ago(ed.at) + '</span>' : '') + '</button>';
    }).join('');
    $('#btnViewAll').textContent = view.all ? 'Show one driver at a time' : 'Show all ' + result.routes.length + ' route sheets';
  }

  function brandHead() {
    return '<div class="sh-brand"><span class="plate"><img class="dodo" src="brand/dodo.png" alt="Dodo"></span>' +
      '<div class="ttl"><div class="a">Dodo Delivery</div><div class="b">Driver route sheet</div></div>' +
      '<div class="pw"><span>Delivered with</span><span class="plate"><img class="ever" src="brand/evermile.png" alt="Evermile"></span></div></div>';
  }

  function metaTitle(meta) { return meta ? ' title="Last changed by ' + esc(meta.by) + ', ' + esc(ago(meta.at)) + '"' : ''; }

  function routeCard(r) {
    var shown = view.all || view.route === r.routeId;
    var h = '<article class="card sheet' + (shown ? '' : ' offscreen') + '" data-route="' + esc(r.routeId) + '">';
    h += '<header class="sheet-head">' + brandHead() +
      '<div class="sh-line"><span>Date : <b>' + esc(r.date) + '</b></span><span>Driver ID : <b>' + esc(r.agentId || '—') + '</b></span><span>Driver Name : <b>' + esc(r.agentName) + '</b></span>' +
      '<span class="sh-pay"><span class="k">Driver pay</span><span class="v">' + gbp(r.payable) + '</span><span class="k2">' + r.orderCount + ' orders · ' + r.parcels + ' parcels' + (r.vehicles.length ? ' · ' + esc(r.vehicles.join(', ')) : '') + '</span></span></div>' +
      '<div class="sh-line"><span class="route-badge">Route ID ' + esc(r.routeId) + '</span><span>Estimated Time : <b>' + esc(r.estTimeText || '—') + '</b></span>' +
      '<span>Estimated Distance : <b>' + esc(r.estDistText || '—') + '</b></span><span class="spacer"></span>' +
      '<button class="btn small noprint" data-print="' + esc(r.routeId) + '" type="button">Print this driver</button></div></header>';

    h += '<div class="wrap"><table class="tbl route stack"><colgroup><col class="c-seq"><col class="c-type"><col class="c-id"><col class="c-name"><col class="c-addr"><col class="c-phone"><col class="c-time"><col class="c-parcels"><col class="c-instr"><col class="c-pay"><col class="c-sig"></colgroup><thead><tr>' +
      '<th>Seq</th><th>Service Type</th><th>Order ID</th><th>Customer / Merchant</th><th>Address</th><th>Phone</th><th>Time</th>' +
      '<th class="num">Parcels</th><th>Instructions</th><th class="num">Pay</th><th class="sig">Signature</th></tr></thead><tbody>' +
      r.stops.map(function (s) {
        var o = s.order, pay = '';
        if (s.showCost) {
          pay = o.cost == null ? '<span class="badge bad">no cost</span>' : '<b>' + gbp(o.total) + '</b>';
          if (o.costSource === 'card') pay += '<span class="sub noprint"><span class="badge warn">card rate</span></span>';
          if (o.mismatch) pay += '<span class="sub noprint"><span class="badge warn">card ' + gbp(o.cardFee) + '</span></span>';
        }
        return '<tr class="' + (s.type === 'PICKUP' ? 'pu' : 'de') + (o.cancelled ? ' cx' : '') + '">' +
          '<td class="seq" data-l="Seq">' + s.seq + '</td>' +
          '<td data-l="Type"><span class="stype ' + (s.type === 'PICKUP' ? 'p' : 'd') + '">' + esc(s.type) + '</span></td>' +
          '<td class="id" data-l="Order ID">' + esc(s.ref) + '</td>' +
          '<td data-l="Name">' + esc(s.name) + '</td>' +
          '<td data-l="Address">' + esc(s.address) + '</td>' +
          '<td data-l="Phone">' + (s.phone ? '<a class="tel" href="tel:' + esc(s.phoneTel) + '">' + esc(s.phone) + '</a>' : '') + '</td>' +
          '<td data-l="Time" class="nowrap">' + esc(s.time) + '</td>' +
          '<td class="num" data-l="Parcels">' + (s.parcels == null ? '' : s.parcels) + '</td>' +
          '<td data-l="Instructions">' + esc(s.instructions) + '</td>' +
          '<td class="num" data-l="Pay">' + pay + '</td>' +
          '<td class="sig" data-l="Signature"></td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td colspan="7">' + r.stops.length + ' stops · ' + r.orderCount + ' orders</td><td class="num">' + r.parcels + '</td><td></td><td class="num">' + gbp(r.payable) + '</td><td class="sig"></td></tr></tfoot></table></div>' +
      '<div class="sh-foot"><span><b>' + r.stops.length + ' stops · ' + r.orderCount + ' orders · ' + r.parcels + ' parcels · Pay ' + gbp(r.payable) + '</b></span><span>Dodo Delivery × Evermile · Route ' + esc(r.routeId) + ' · ' + esc(r.agentName) + '</span><span>Printed ' + esc(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })) + '</span></div>';

    // Pay & reconciliation (screen only; shared live with the team).
    var open = r.mismatches || r.cardFallbacks || r.unpriced;
    var am = (S.adjMeta || {})[r.routeId + '.amount'], rm = (S.adjMeta || {})[r.routeId + '.remark'];
    h += '<section class="noprint"><details class="payd" data-pd="pay"' + (open ? ' open' : '') + '><summary><span class="chev">▶</span><span class="sec-title">Adjust pay</span>' +
      '<span class="small muted">extras, remarks, route deduction</span>' +
      (r.mismatches ? '<span class="badge warn">' + r.mismatches + ' differ from card</span>' : '') +
      '<span class="spacer"></span><span class="small muted">Retool ' + gbp(r.cost) + ' · card ' + gbp(r.cardTotal) + '</span></summary>' +
      '<div class="wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>Order</th><th>Merchant</th><th class="num">Miles</th><th class="num">Retool pay</th><th class="num">Card</th>' +
      '<th class="num">Extra £</th><th>Remark</th><th class="num">Total</th></tr></thead><tbody>' +
      r.orders.map(function (o) {
        var em = (S.editMeta || {})[o.key + '.extra'], rmk = (S.editMeta || {})[o.key + '.remark'];
        return '<tr data-key="' + esc(o.key) + '"><td class="id">' + esc(o.ref) + '</td><td class="small">' + esc(o.merchant) + '</td>' +
          '<td class="num">' + (o.miles == null ? '—' : o.miles.toFixed(2)) + '</td>' +
          '<td class="num">' + (o.dpCost == null ? '<span class="badge warn">missing</span>' : gbp(o.dpCost)) + '</td>' +
          '<td class="num small">' + (o.cardFee == null ? '—' : gbp(o.cardFee)) + (o.mismatch ? ' <span class="badge warn">' + gbp(o.diff) + '</span>' : '') + '</td>' +
          '<td class="num"><input class="money extra' + (em ? ' edited' : '') + '"' + metaTitle(em) + ' data-fid="x|' + esc(o.key) + '" type="number" step="0.01" value="' + esc(o.extraRaw) + '" placeholder="0.00" aria-label="Extra charge for ' + esc(o.ref) + '"></td>' +
          '<td><input class="remark' + (rmk ? ' edited' : '') + '"' + metaTitle(rmk) + ' data-fid="r|' + esc(o.key) + '" value="' + esc(o.remark) + '" placeholder="Reason, e.g. waited 15 min" aria-label="Remark for ' + esc(o.ref) + '"></td>' +
          '<td class="num"><b>' + (o.total == null ? '—' : gbp(o.total)) + '</b></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="adj"><span class="small" style="font-weight:700">Route extra / deduction £</span>' +
      '<input class="money radj' + (am ? ' edited' : '') + '"' + metaTitle(am) + ' data-fid="ra|' + esc(r.routeId) + '" type="number" step="0.01" data-route="' + esc(r.routeId) + '" value="' + esc(r.adjustmentRaw) + '" placeholder="0.00" aria-label="Route extra or deduction">' +
      '<input class="remark rremark' + (rm ? ' edited' : '') + '"' + metaTitle(rm) + ' data-fid="rr|' + esc(r.routeId) + '" data-route="' + esc(r.routeId) + '" value="' + esc(r.adjustmentRemark) + '" placeholder="Reason (use a minus amount for a deduction)" style="flex:1;min-width:180px" aria-label="Route adjustment reason"></div>' +
      '<div class="adj small"><span class="muted">Retool pay ' + gbp(r.cost) + ' + extras ' + gbp(r.extras) + ' + route ' + gbp(r.adjustment) + '</span><span class="spacer"></span><b>= ' + gbp(r.payable) + '</b></div>' +
      '</details></section>';

    h += '<section class="noprint"><details class="payd" data-pd="sum"><summary><span class="chev">▶</span><span class="sec-title">Pickup &amp; delivery summary</span></summary>' + summaries(r) + '</details></section>';
    return h + '</article>';
  }

  function summaries(r) {
    var g = {}, list = [];
    r.stops.forEach(function (s) {
      if (s.type !== 'PICKUP') return;
      var k = s.name + '|' + s.address;
      if (!g[k]) { g[k] = { name: s.name, address: s.address, ids: [], parcels: 0 }; list.push(g[k]); }
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
    $$('#routes details.payd').forEach(function (el) { open[el.closest('.sheet').dataset.route + ':' + el.dataset.pd] = el.open; });
    $('#routes').innerHTML = result.routes.length ? result.routes.map(routeCard).join('') :
      '<div class="card muted" style="text-align:center;padding:32px">No route stops matched the Retool export for this date.</div>';
    $$('#routes details.payd').forEach(function (el) {
      var k = el.closest('.sheet').dataset.route + ':' + el.dataset.pd;
      if (open[k] !== undefined) el.open = open[k];
    });
  }

  // Keep the cursor where it was when a teammate's change re-renders the page.
  function rememberFocus() {
    var a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.fid) return null;
    return { fid: a.dataset.fid, value: a.value, dirty: a.value !== a.defaultValue, start: a.selectionStart, end: a.selectionEnd };
  }
  function restoreFocus(f) {
    if (!f) return;
    var el = $$('[data-fid]').filter(function (x) { return x.dataset.fid === f.fid; })[0];
    if (!el) return;
    if (f.dirty) el.value = f.value;
    el.focus();
    try { if (f.start != null) el.setSelectionRange(f.start, f.end); } catch (e) { /* number inputs */ }
  }

  // ---------- live team workspace (via the Apps Script) ----------
  var live = { state: 'local', presence: [], polling: false, sending: false, failures: 0, epoch: 0, pending: load(LS.pending, []) };
  function liveOn() { return !!(settings.live !== false && settings.scriptUrl && settings.token); }

  function renderLive() {
    var chip = $('#liveChip');
    var others = live.presence.filter(function (p) { return p.id !== clientId; });
    var names = [settings.name || 'You'].concat(others.map(function (p) { return p.name; }));
    chip.className = 'live ' + (!liveOn() ? '' : (!navigator.onLine || live.state === 'error' ? 'off' : (live.pending.length || live.state === 'connecting' ? 'wait' : 'on')));
    $('#faces').innerHTML = liveOn() ? names.slice(0, 4).map(function (n) { return '<span class="face" style="background:' + colorFor(n) + '" title="' + esc(n) + '">' + esc(initials(n)) + '</span>'; }).join('') : '';
    var lbl;
    if (!liveOn()) lbl = navigator.onLine ? 'Just you' : 'Offline';
    else if (!navigator.onLine) lbl = 'Offline · ' + (live.pending.length ? live.pending.length + ' to sync' : 'saved here');
    else if (live.state === 'error') lbl = 'Can\'t reach team';
    else if (live.pending.length) lbl = 'Syncing…';
    else lbl = others.length ? 'Live · ' + (others.length + 1) + ' here' : 'Live';
    $('#liveLbl').textContent = lbl;
    chip.title = liveOn() ? 'Shared live with: ' + names.join(', ') : 'Not shared. Connect Google Sheets in Settings to work together.';
  }

  function queueLive(item) {
    if (!liveOn()) return;
    live.epoch++; // any poll already in flight is now stale
    live.pending.push(item);
    save(LS.pending, live.pending);
    renderLive();
    flushLive();
  }
  function pushFile(kind, file) {
    queueLive({ t: 'file', kind: kind, file: { fileName: file.fileName, headers: file.headers, rows: file.rows, mapping: file.mapping } });
  }
  function pushOp(op, activity) { queueLive({ t: 'op', op: op, activity: activity }); }

  function flushLive() {
    if (!liveOn() || live.sending || !live.pending.length || !navigator.onLine) return;
    live.sending = true;
    var item = live.pending[0], batch, req;
    if (item.t === 'op') {
      batch = [];
      while (batch.length < 50 && live.pending[batch.length] && live.pending[batch.length].t === 'op') batch.push(live.pending[batch.length]);
      var acts = batch.map(function (b) { return b.activity; }).filter(Boolean);
      req = { action: 'live.patch', ops: batch.map(function (b) { return b.op; }), activity: acts.length > 1 ? acts.length + ' changes: ' + acts.slice(-1)[0] : acts[0] };
    } else if (item.t === 'file') {
      batch = [item]; req = { action: 'live.setFile', kind: item.kind, file: item.file };
    } else {
      batch = [item]; req = { action: 'live.clear' };
    }
    req.name = settings.name || 'Someone';
    api(req).then(function (res) {
      if (!res.ok) throw Object.assign(new Error(res.error || 'Sync failed'), { fatal: true });
      live.pending = live.pending.slice(batch.length);
      save(LS.pending, live.pending);
      live.state = 'on';
      live.failures = 0;
    }).catch(function (e) {
      live.failures++;
      live.state = 'error';
      if (e.fatal) {
        toast('Team sync stopped: ' + esc(e.message), 'bad', 8000);
        live.pending = live.pending.slice(batch.length);
        save(LS.pending, live.pending);
      }
    }).finally(function () {
      live.sending = false;
      renderLive();
      if (live.pending.length && live.failures < 3) setTimeout(flushLive, live.failures ? 2000 * live.failures : 0);
      else pollLive(true);
    });
  }

  function applyRemote(res) {
    var st = res.state || {};
    var changed = false;
    if (res.files) {
      ['tookan', 'retool'].forEach(function (k) {
        var f = res.files[k];
        var next = f ? { fileName: f.fileName, headers: f.headers || [], rows: f.rows || [], mapping: {}, by: f.by, at: f.at } : emptyFile();
        if (next.fileName !== S[k].fileName || next.rows.length !== S[k].rows.length || next.at !== S[k].at) changed = true;
        S[k] = next;
      });
      S.liveFilesVersion = res.filesVersion;
    }
    ['tookan', 'retool'].forEach(function (k) {
      var mp = (st.mapping || {})[k];
      if (S[k].headers.length) S[k].mapping = Object.assign(M.autoMap(S[k].headers, fieldsFor(k)), mp && Object.keys(mp).length ? mp : {});
    });
    S.edits = st.edits || {};
    S.routeAdj = st.routeAdj || {};
    S.editMeta = st.editMeta || {};
    S.adjMeta = st.adjMeta || {};
    // Re-apply my own changes that haven't reached the server yet.
    live.pending.forEach(function (p) { if (p.t === 'op') applyOpLocally(p.op); });
    S.liveVersion = res.version;
    (st.activity || []).slice().reverse().forEach(function (a) {
      if (a.at > (S.lastActivityAt || 0)) {
        if (a.by !== settings.name && S.lastActivityAt) toast('<b>' + esc(a.by) + '</b> ' + esc(a.text), 'team', 6000);
        S.lastActivityAt = a.at;
      }
    });
    persist();
    return changed;
  }

  var pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!liveOn()) return;
    pollTimer = setTimeout(function () { pollLive(false); }, document.hidden ? 20000 : 4000);
  }
  function pollLive(force) {
    if (!liveOn() || !navigator.onLine) { renderLive(); schedulePoll(); return; }
    if (live.polling || (live.pending.length && !force)) { schedulePoll(); return; }
    live.polling = true;
    if (live.state === 'local') live.state = 'connecting';
    var epoch = live.epoch;
    api({ action: 'live.get', since: S.liveVersion, filesSince: S.liveFilesVersion, name: settings.name || 'Someone', clientId: clientId })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Sync failed');
        live.presence = res.presence || [];
        live.state = 'on';
        // Ignore answers that started before my latest local change, or that are older than what I have.
        var fresh = epoch === live.epoch && !live.pending.length && res.version >= S.liveVersion;
        if (!res.unchanged && fresh) {
          applyRemote(res);
          render();
        } else renderLive();
      })
      .catch(function () { live.state = 'error'; renderLive(); })
      .finally(function () {
        live.polling = false;
        if (epoch !== live.epoch && !live.pending.length) pollLive(true); else schedulePoll();
      });
  }

  function applyOpLocally(op) {
    var bag = op.type === 'edit' ? S.edits : (op.type === 'adj' ? S.routeAdj : null);
    if (bag) {
      bag[op.key] = bag[op.key] || {};
      if (op.value === '' || op.value == null) delete bag[op.key][op.field]; else bag[op.key][op.field] = op.value;
      var metas = op.type === 'edit' ? (S.editMeta = S.editMeta || {}) : (S.adjMeta = S.adjMeta || {});
      metas[op.key + '.' + op.field] = { by: settings.name || 'You', at: Date.now() };
    } else if (op.type === 'map') {
      S[op.kind].mapping[op.field] = op.value;
    }
  }
  function change(op, activity) {
    applyOpLocally(op);
    persist();
    pushOp(op, activity);
  }

  function askName() {
    if (!liveOn() || settings.name) return;
    var d = $('#dlgName');
    d.addEventListener('close', function () {
      var n = $('#nameInput').value.trim();
      settings.name = n || 'Someone';
      save(LS.settings, settings);
      render();
    }, { once: true });
    d.showModal();
  }

  // ---------- Google Sheets (weekly-sheet format) ----------
  function buildPayloads() {
    var all = recalc();
    var byDate = {};
    all.routes.forEach(function (r) { (byDate[r.ymd] = byDate[r.ymd] || []).push(r); });
    return Object.keys(byDate).sort().map(function (ymd) {
      var rows = M.sheetRows(byDate[ymd]);
      var total = P.money(rows.reduce(function (s, r) { return s + (Number(r[11]) || 0); }, 0));
      return {
        tabName: tabLabel(ymd), count: rows.length, total: gbp(total),
        body: { meta: { sourceFile: S.tookan.fileName + ' + ' + S.retool.fileName, totalPayable: total }, table: { header: M.SHEET_HEADER, rows: rows, money: [9, 11], text: [1] } }
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
    if (result.unmatched.length && !confirm(result.unmatched.length + ' Tookan orders aren\'t in the Retool export and are left out. Send anyway?')) return;
    buildPayloads().forEach(function (p) {
      queue = queue.filter(function (q) { return q.tabName !== p.tabName; });
      queue.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), tabName: p.tabName, count: p.count, total: p.total, body: p.body, createdAt: Date.now(), mode: null });
    });
    save(LS.queue, queue);
    renderQueueBadge();
    if (!settings.scriptUrl || !settings.token) { toast('Saved. Connect Google Sheets in Settings to send it.', '', 7000); openSettings(); return; }
    if (!navigator.onLine) { toast('You\'re offline. It will send automatically when you\'re back online.', '', 7000); return; }
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
          else toast('Couldn\'t reach Google. Still waiting to send — it will retry automatically.', '', 6000);
          return true;
        });
      });
    }, Promise.resolve(false)).finally(function () { syncing = false; renderQueueBadge(); render(); if ($('#dlgUploads').open) renderUploads(); });
  }
  function syncItem(item) {
    var mode = item.mode ? Promise.resolve(item.mode) : api({ action: 'check', tabName: item.tabName }).then(function (c) {
      if (!c.ok) { var e = new Error(c.error || 'Check failed'); e.fatal = true; throw e; }
      return c.exists ? askConflict(item.tabName, c.url, c.nextVersionName) : 'create';
    });
    return mode.then(function (md) {
      if (md === 'cancel') { dequeue(item.id); toast('Sending ' + esc(item.tabName) + ' cancelled.'); return; }
      item.mode = md;
      save(LS.queue, queue);
      return api(Object.assign({ action: 'upload', tabName: item.tabName, mode: md }, item.body)).then(function (res) {
        if (res.conflict) { item.mode = null; return syncItem(item); }
        if (!res.ok) { var e = new Error(res.error || 'Upload failed'); e.fatal = true; throw e; }
        dequeue(item.id);
        uploadHistory.unshift({ tabName: res.tabName, url: res.url, mode: md === 'update' ? 'Updated' : (md === 'version' ? 'New version' : 'Created'), count: item.count, total: item.total, at: Date.now() });
        uploadHistory = uploadHistory.slice(0, 100);
        save(LS.history, uploadHistory);
        if (liveOn()) pushOp({ type: 'noop' }, 'sent ' + res.tabName + ' to Google Sheets');
        toast('✓ Sent <b>' + esc(res.tabName) + '</b> to Google Sheets (' + item.count + ' orders, ' + esc(item.total) + '). <a href="' + esc(res.url) + '" target="_blank" rel="noopener">Open tab ↗</a>', 'ok', 15000);
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
  function renderQueueBadge() {
    var b = $('#btnUpload');
    if (b) b.textContent = queue.length ? 'Send to Google Sheets (' + queue.length + ' waiting)' : 'Send to Google Sheets';
  }
  function renderUploads() {
    var ok = settings.scriptUrl && settings.token;
    var h = ok ? '' : '<div class="notice warn" style="margin:0">Google Sheets isn\'t connected yet. Open <b>Settings</b>, or use the connect link from the Apps Script setup.</div>';
    h += '<h4>Waiting to send</h4>' + (queue.length ? queue.map(function (q) {
      return '<div class="row"><b>' + esc(q.tabName) + '</b><span class="muted small">' + q.count + ' orders · ' + esc(q.error ? 'Error: ' + q.error : (navigator.onLine ? 'ready' : 'offline')) + '</span><span class="spacer"></span><button class="btn quiet small" data-dequeue="' + esc(q.id) + '" type="button">Remove</button></div>';
    }).join('') : '<span class="muted small">Nothing waiting.</span>');
    h += '<h4>Sent</h4>' + (uploadHistory.length ? uploadHistory.slice(0, 15).map(function (x) {
      return '<div class="row small"><b>' + esc(x.tabName) + '</b><span class="muted">' + esc(x.mode) + ' · ' + esc(x.total || '') + ' · ' + esc(new Date(x.at).toLocaleString('en-GB')) + '</span><span class="spacer"></span>' + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">Open ↗</a>' : '') + '</div>';
    }).join('') : '<span class="muted small">Nothing sent yet.</span>');
    $('#uploadsContent').innerHTML = h;
  }

  // ---------- settings ----------
  function openSettings() {
    $('#sName').value = settings.name || ''; $('#sLive').checked = settings.live !== false;
    $('#sUrl').value = settings.scriptUrl; $('#sToken').value = settings.token;
    $('#connFields').classList.toggle('hidden', managed);
    $('#connManaged').classList.toggle('hidden', !managed);
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
    settings.name = $('#sName').value.trim(); settings.live = $('#sLive').checked;
    if (!managed) { settings.scriptUrl = cleanScriptUrl($('#sUrl').value); settings.token = $('#sToken').value.trim(); }
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
    // The site's built-in connection always wins: an old link must not replace it with a stale token.
    if (managed) {
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    try {
      var cfg = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (cfg.u && cfg.t) {
        settings.scriptUrl = cleanScriptUrl(cfg.u); settings.token = cfg.t; settings.live = true;
        save(LS.settings, settings);
        setTimeout(function () { toast('✓ Connected to Google Sheets and your team. Bookmark this page.', 'ok', 6000); }, 50);
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
    document.addEventListener('change', function (e) {
      if (e.target.type !== 'file' || !e.target.closest('.drop')) return;
      var z = e.target.closest('.drop').dataset.zone;
      if (e.target.files.length) readFiles(e.target.files, z);
      e.target.value = '';
    });
    document.addEventListener('keydown', function (e) {
      var d = e.target.closest && e.target.closest('.drop');
      if (d && e.target === d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d.querySelector('input').click(); }
      if (e.key === 'Escape') $('#menu').classList.add('hidden');
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { var d = e.target.closest && e.target.closest('.drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
    });
    document.addEventListener('dragleave', function (e) { var d = e.target.closest && e.target.closest('.drop'); if (d) d.classList.remove('over'); });
    document.addEventListener('drop', function (e) {
      var d = e.target.closest && e.target.closest('.drop');
      if (!d) return;
      e.preventDefault();
      d.classList.remove('over');
      if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files, d.dataset.zone);
    });
    $$('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });

    // Menu
    $('#btnMenu').addEventListener('click', function (e) { e.stopPropagation(); $('#menu').classList.toggle('hidden'); });
    document.addEventListener('click', function (e) { if (!e.target.closest('#menu')) $('#menu').classList.add('hidden'); });
    $('#menu').addEventListener('click', function (e) {
      var k = e.target.dataset.menu;
      if (!k) return;
      $('#menu').classList.add('hidden');
      if (k === 'files') $('#dlgFiles').showModal();
      if (k === 'uploads') { renderUploads(); $('#dlgUploads').showModal(); }
      if (k === 'settings') openSettings();
      if (k === 'clear') {
        if (!confirm(liveOn() ? 'Clear the files, extras and remarks for EVERYONE on the team?' : 'Clear both files and any extras/remarks?')) return;
        var keep = { liveVersion: S.liveVersion, liveFilesVersion: S.liveFilesVersion, lastActivityAt: S.lastActivityAt };
        S = Object.assign(emptySession(), keep);
        save(LS.session, S);
        queueLive({ t: 'clear' });
        render();
      }
    });
    $('#liveChip').addEventListener('click', function () {
      if (!settings.scriptUrl) { openSettings(); return; }
      var others = live.presence.filter(function (p) { return p.id !== clientId; });
      toast(liveOn() ? (others.length ? 'Working live with ' + esc(others.map(function (p) { return p.name; }).join(', ')) + '.' : 'Live. Nobody else is here right now; changes are saved for the team.') : 'Live sharing is off (Settings).', 'team', 4000);
    });

    $('#btnReplace').addEventListener('click', function () { $('#dlgFiles').showModal(); });
    $('#btnSample').addEventListener('click', function () {
      loadText(window.DODO_SAMPLE_TOOKAN, 'sample-tookan-routes.csv', 'tookan');
      loadText(window.DODO_SAMPLE_RETOOL, 'sample-retool-export.csv', 'retool');
    });
    $('#mappingGrid').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-map'), kind = e.target.getAttribute('data-kind');
      if (!k || !kind) return;
      change({ type: 'map', kind: kind, field: k, value: e.target.value }, 'changed column matching');
      render();
    });
    $('#fDate').addEventListener('change', function (e) { S.date = e.target.value; persist(); render(); });

    $('#driverGrid').addEventListener('click', function (e) {
      var b = e.target.closest('.dcard');
      if (!b) return;
      view.route = b.dataset.route; view.all = false; view.checked = true;
      render();
      var sheet = $('#routes .sheet[data-route="' + b.dataset.route + '"]');
      if (sheet) sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#btnViewAll').addEventListener('click', function () { view.all = !view.all; view.checked = true; render(); });

    $('#routes').addEventListener('change', function (e) {
      var t = e.target, r;
      var routeOf = function (id) { return result.routes.filter(function (x) { return x.routeId === id; })[0] || {}; };
      if (t.dataset.route) {
        r = routeOf(t.dataset.route);
        var isAmt = t.classList.contains('radj');
        change({ type: 'adj', key: t.dataset.route, field: isAmt ? 'amount' : 'remark', value: isAmt ? (t.value === '' ? '' : Number(t.value)) : t.value },
          isAmt ? 'set a route ' + (Number(t.value) < 0 ? 'deduction' : 'extra') + ' of ' + gbp(Number(t.value) || 0) + ' for ' + r.agentName : 'updated the route remark for ' + r.agentName);
        render(); return;
      }
      var tr = t.closest('tr[data-key]');
      if (!tr) return;
      var key = tr.dataset.key, ref = tr.querySelector('.id').textContent;
      r = routeOf(key.split('|')[0]);
      if (t.classList.contains('extra')) change({ type: 'edit', key: key, field: 'extra', value: t.value === '' ? '' : Number(t.value) }, 'set extra ' + gbp(Number(t.value) || 0) + ' on ' + ref + ' (' + r.agentName + ')');
      else if (t.classList.contains('remark')) change({ type: 'edit', key: key, field: 'remark', value: t.value }, 'added a remark on ' + ref + ' (' + r.agentName + ')');
      else return;
      render();
    });
    $('#routes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-print]');
      if (b) printRoutes(b.dataset.print);
    });

    $('#btnUpload').addEventListener('click', startUpload);
    $('#btnPrintAll').addEventListener('click', function () { printRoutes(''); });
    $('#btnCsv').addEventListener('click', function () {
      var rows = [M.SHEET_HEADER].concat(M.sheetRows(recalc().routes));
      download('dodo-deliveries-' + tabLabel(S.date || (result.routes[0] && result.routes[0].ymd)) + '.csv', toCSV(rows));
    });

    $('#btnSyncNow').addEventListener('click', function () {
      queue.forEach(function (q) { delete q.error; }); save(LS.queue, queue);
      if (!navigator.onLine) toast('Still offline. It will send when the connection returns.');
      processQueue();
    });
    $('#uploadsContent').addEventListener('click', function (e) {
      var id = e.target.getAttribute('data-dequeue');
      if (id) { dequeue(id); renderUploads(); renderQueueBadge(); }
    });

    $('#sUnlock').addEventListener('change', function (e) { lockPricing(!e.target.checked); });
    $('#btnTest').addEventListener('click', function () {
      readSettings();
      var out = $('#testResult');
      if (!settings.scriptUrl) { out.textContent = 'Enter the Web App URL.'; return; }
      out.textContent = 'Testing…';
      api({ action: 'ping' }).then(function (r) {
        out.innerHTML = r.ok ? '<span style="color:var(--ok)">✓ Connected to “' + esc(r.spreadsheetName) + '”</span>' : '<span style="color:var(--bad)">' + esc(r.error) + '</span>';
      }).catch(function (e) {
        var msg = /fetch|network/i.test(e.message || '') ? 'Couldn\'t reach the script. In Apps Script, set Deploy → Manage deployments → Who has access to "Anyone", and use the /exec URL.' : (e.message || 'Could not connect');
        out.innerHTML = '<span style="color:var(--bad)">' + esc(msg) + '</span>';
      });
    });
    $('#dlgSettings').addEventListener('close', function () {
      if ($('#dlgSettings').returnValue !== 'save') return;
      var wasLive = liveOn();
      readSettings(); save(LS.settings, settings); applyTheme();
      if (!wasLive && liveOn()) { S.liveVersion = -1; S.liveFilesVersion = -1; startLive(); }
      render(); processQueue();
      toast('Settings saved.', 'ok', 2000);
    });

    window.addEventListener('online', function () { render(); processQueue(); flushLive(); pollLive(true); });
    window.addEventListener('offline', function () { render(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) save(LS.session, S); else { processQueue(); pollLive(true); }
    });
    window.addEventListener('pagehide', function () { save(LS.session, S); });
    setInterval(processQueue, 60000);
  }

  function startLive() {
    if (!liveOn()) return;
    askName();
    // First join: if the team workspace is empty but I already have files, share them.
    if (S.liveVersion < 0 && ready()) {
      api({ action: 'live.get', since: -1, filesSince: -1, name: settings.name || 'Someone', clientId: clientId }).then(function (res) {
        if (res.ok && !(res.files && res.files.tookan) && !live.pending.length) { pushFile('tookan', S.tookan); pushFile('retool', S.retool); }
        else if (res.ok) { applyRemote(res); render(); }
      }).catch(function () {}).finally(function () { schedulePoll(); });
    } else {
      flushLive();
      pollLive(true);
    }
  }

  // ---------- boot ----------
  consumeConnectLink();
  applyTheme();
  bind();
  render();
  processQueue();
  startLive();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});
  window.__dodoRoutes = { state: function () { return S; }, live: live, clientId: clientId };
})();
