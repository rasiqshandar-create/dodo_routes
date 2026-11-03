/**
 * Dodo Driver Pay → Google Sheets connector.
 *
 * Install (once):
 *   1. Open the "Dodo Routes" spreadsheet (ID below) that receives the daily tabs.
 *   2. Extensions → Apps Script. Replace Code.gs with this file and save.
 *   3. Deploy → New deployment → type "Web app":
 *        Execute as: Me      Who has access: Anyone      → Deploy → Authorise.
 *   4. In the editor choose the function "setup" → Run. Open the
 *      "one-click connect link" from the Execution log — the tool is now connected.
 *
 * The tool sends JSON as text/plain (no CORS preflight). Actions:
 *   ping   → { ok, spreadsheetName, spreadsheetUrl }
 *   check  → { ok, exists, url, nextVersionName }
 *   upload → { ok, tabName, url, mode }   mode: "create" | "update" | "version"
 *
 * Live shared workspace (2–3 people working on the same day at once):
 *   live.get     { since, filesSince, name, clientId } → changes since that version + who is online
 *   live.patch   { ops: [{ type: 'edit'|'adj'|'map', key|kind, field, value }], name }
 *   live.setFile { kind: 'tookan'|'retool', file: { fileName, headers, rows, mapping }, name }
 *   live.clear   { name }
 * State lives in a hidden "_live" tab of the spreadsheet; the version number is cached
 * so the frequent "anything new?" polls don't touch the sheet.
 */

// "Dodo Routes" spreadsheet. A Script property SPREADSHEET_ID overrides this.
var DEFAULT_SPREADSHEET_ID = '1qvQiAPmlhssIxpGLTEWQhyGm78kYOgcUFHeZ_3BlwXk';

var HEADER_BG = '#1f3a5f';
var SECTION_BG = '#e8eef6';

// Where the tool is hosted (Netlify). The connect link opens this with the settings attached.
var APP_URL = 'https://dodo-routes-3vpx20tnea.netlify.app/';

/**
 * Run once from the Apps Script editor AFTER deploying the web app (select "setup" → Run).
 * Creates the upload token if needed and logs a one-click connect link for the tool.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('UPLOAD_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('UPLOAD_TOKEN', token);
  }
  var ss = getSpreadsheet_();
  // Workspace accounts get a /a/<domain>/ URL, which can force a Google login and block the tool.
  var url = String(ScriptApp.getService().getUrl() || '').replace(/\/a\/[^\/]+\/macros\//, '/macros/');
  if (!url) {
    Logger.log('Deploy the web app first (Deploy → New deployment → Web app), then run setup again.');
    return;
  }
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify({ u: url, t: token }));
  Logger.log('Spreadsheet: ' + ss.getName());
  Logger.log('Web app URL: ' + url);
  Logger.log('Upload token: ' + token);
  Logger.log('ONE-CLICK CONNECT LINK (open it, bookmark it, share it with your team):');
  Logger.log(APP_URL + '#connect=' + payload);
}

function doGet() {
  return json_({ ok: true, service: 'dodo-driver-pay', hint: 'POST JSON to this URL' });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('UPLOAD_TOKEN');
    if (!token) return json_({ ok: false, error: 'UPLOAD_TOKEN is not set in Script properties' });
    if (req.token !== token) return json_({ ok: false, error: 'Invalid upload token' });

    var ss = getSpreadsheet_();
    if (String(req.action).indexOf('live.') === 0) return json_(live_(ss, req));
    if (req.action === 'ping') {
      return json_({ ok: true, spreadsheetName: ss.getName(), spreadsheetUrl: ss.getUrl() });
    }

    var tabName = sanitizeTabName_(req.tabName);
    if (!tabName) return json_({ ok: false, error: 'Missing tabName' });

    if (req.action === 'check') {
      var existing = ss.getSheetByName(tabName);
      return json_({
        ok: true,
        exists: !!existing,
        url: existing ? sheetUrl_(ss, existing) : null,
        nextVersionName: nextVersionName_(ss, tabName)
      });
    }

    if (req.action === 'upload') {
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        return json_(upload_(ss, tabName, req));
      } finally {
        lock.releaseLock();
      }
    }

    return json_({ ok: false, error: 'Unknown action: ' + req.action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------- live shared workspace ----------
var LIVE_TAB = '_live';
var LIVE_CHUNK = 40000;          // characters per cell (Sheets allows 50,000)
var PRESENCE_SECONDS = 30;

function liveSheet_(ss) {
  var sh = ss.getSheetByName(LIVE_TAB);
  if (!sh) { sh = ss.insertSheet(LIVE_TAB); sh.hideSheet(); }
  return sh;
}
// Column 1 = files JSON, column 2 = state JSON, split across rows. A leading apostrophe
// keeps every chunk stored as plain text (never parsed as a number or formula).
function readCol_(sh, col) {
  var n = sh.getLastRow();
  if (!n) return null;
  var text = sh.getRange(1, col, n, 1).getValues().map(function (r) { return String(r[0]); }).join('');
  return text ? JSON.parse(text) : null;
}
function writeCol_(sh, col, obj) {
  var text = JSON.stringify(obj), chunks = [];
  for (var i = 0; i < text.length; i += LIVE_CHUNK) chunks.push(["'" + text.slice(i, i + LIVE_CHUNK)]);
  var old = sh.getLastRow();
  if (old) sh.getRange(1, col, old, 1).clearContent();
  if (chunks.length) sh.getRange(1, col, chunks.length, 1).setValues(chunks);
}
function emptyState_() {
  return { version: 0, filesVersion: 0, edits: {}, editMeta: {}, routeAdj: {}, adjMeta: {}, mapping: { tookan: {}, retool: {} }, activity: [] };
}
function readState_(sh) { return Object.assign(emptyState_(), readCol_(sh, 2) || {}); }
function cacheVersions_(st) {
  CacheService.getScriptCache().put('live:ver', st.version + '|' + st.filesVersion, 21600);
}
function touchPresence_(name, clientId) {
  var cache = CacheService.getScriptCache();
  var p = {};
  try { p = JSON.parse(cache.get('live:presence') || '{}'); } catch (e) { p = {}; }
  var now = Date.now();
  if (clientId) p[clientId] = { name: String(name || 'Someone').slice(0, 40), at: now };
  Object.keys(p).forEach(function (k) { if (now - p[k].at > PRESENCE_SECONDS * 1000) delete p[k]; });
  cache.put('live:presence', JSON.stringify(p), 600);
  return Object.keys(p).map(function (k) { return { id: k, name: p[k].name }; });
}
function logActivity_(st, name, text) {
  st.activity.unshift({ by: String(name || 'Someone').slice(0, 40), at: Date.now(), text: text });
  st.activity = st.activity.slice(0, 30);
}

function live_(ss, req) {
  var sh = liveSheet_(ss);
  var name = req.name || 'Someone';
  if (req.action === 'live.get') {
    var presence = touchPresence_(name, req.clientId);
    var ver = CacheService.getScriptCache().get('live:ver');
    if (ver && ver === req.since + '|' + req.filesSince) {
      return { ok: true, unchanged: true, version: Number(req.since), filesVersion: Number(req.filesSince), presence: presence };
    }
    var st = readState_(sh);
    cacheVersions_(st);
    var out = { ok: true, version: st.version, filesVersion: st.filesVersion, state: st, presence: presence };
    if (String(st.filesVersion) !== String(req.filesSince)) out.files = readCol_(sh, 1) || {};
    return out;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var st2 = readState_(sh);
    var now = Date.now();
    if (req.action === 'live.patch') {
      (req.ops || []).forEach(function (op) {
        var meta = { by: name, at: now };
        if (op.type === 'edit' || op.type === 'adj') {
          var bag = op.type === 'edit' ? st2.edits : st2.routeAdj;
          var metas = op.type === 'edit' ? st2.editMeta : st2.adjMeta;
          bag[op.key] = bag[op.key] || {};
          if (op.value === null || op.value === '') delete bag[op.key][op.field]; else bag[op.key][op.field] = op.value;
          metas[op.key + '.' + op.field] = meta;
        } else if (op.type === 'map' && (op.kind === 'tookan' || op.kind === 'retool')) {
          st2.mapping[op.kind][op.field] = op.value;
        }
      });
      if (req.activity) logActivity_(st2, name, String(req.activity).slice(0, 140));
    } else if (req.action === 'live.setFile') {
      if (req.kind !== 'tookan' && req.kind !== 'retool') return { ok: false, error: 'Unknown file kind' };
      var files = readCol_(sh, 1) || {};
      var f = req.file || {};
      files[req.kind] = { fileName: f.fileName, headers: f.headers || [], rows: f.rows || [], by: name, at: now };
      st2.mapping[req.kind] = f.mapping || {};
      if (req.kind === 'tookan') { st2.edits = {}; st2.editMeta = {}; st2.routeAdj = {}; st2.adjMeta = {}; }
      writeCol_(sh, 1, files);
      st2.filesVersion++;
      logActivity_(st2, name, 'uploaded the ' + (req.kind === 'tookan' ? 'Tookan route' : 'Retool order') + ' export (' + f.fileName + ')');
    } else if (req.action === 'live.clear') {
      writeCol_(sh, 1, {});
      var keep = st2;
      st2 = emptyState_();
      st2.version = keep.version;
      st2.filesVersion = keep.filesVersion + 1;
      logActivity_(st2, name, 'cleared the workspace');
    } else {
      return { ok: false, error: 'Unknown action: ' + req.action };
    }
    st2.version++;
    writeCol_(sh, 2, st2);
    SpreadsheetApp.flush();
    cacheVersions_(st2);
    return { ok: true, version: st2.version, filesVersion: st2.filesVersion };
  } finally {
    lock.releaseLock();
  }
}

function upload_(ss, tabName, req) {
  var mode = req.mode || 'create';
  var sheet = ss.getSheetByName(tabName);
  var finalName = tabName;

  if (sheet && mode === 'create') {
    return { ok: false, conflict: true, exists: true, url: sheetUrl_(ss, sheet),
             nextVersionName: nextVersionName_(ss, tabName),
             error: 'Tab "' + tabName + '" already exists' };
  }
  if (mode === 'version') {
    finalName = nextVersionName_(ss, tabName);
    sheet = ss.insertSheet(finalName, ss.getNumSheets());
  } else if (sheet && mode === 'update') {
    sheet.clear();
    sheet.clearConditionalFormatRules();
    sheet.getBandings().forEach(function (b) { b.remove(); });
  } else {
    sheet = ss.insertSheet(finalName, ss.getNumSheets());
  }

  writeReport_(sheet, finalName, req);
  SpreadsheetApp.flush();
  return { ok: true, tabName: finalName, url: sheetUrl_(ss, sheet), mode: mode };
}

function writeReport_(sheet, tabName, req) {
  if (req.table) return writeTableOnly_(sheet, req.table);
  var meta = req.meta || {};
  // New format: req.sections = [{ title, header, rows, totals, money, driverHeading }]
  var sections = req.sections || [
    Object.assign({ title: 'DRIVER PAYMENT SUMMARY' }, req.drivers || {}),
    Object.assign({ title: 'ROUTE TOTALS (driver × day)' }, req.routes || {}),
    Object.assign({ title: 'DELIVERIES' }, req.deliveries || {})
  ];
  var widest = sections.reduce(function (w, t) { return Math.max(w, (t.header || []).length); }, 4);
  var row = 1;

  sheet.getRange(row, 1).setValue('Dodo routes & driver pay — ' + tabName)
    .setFontSize(14).setFontWeight('bold');
  row++;
  var info = [
    ['Formula', meta.formula || ''],
    ['Generated', meta.generatedAt || new Date().toISOString()],
    ['Source file', meta.sourceFile || ''],
    ['Total payable', meta.totalPayable != null ? meta.totalPayable : '']
  ];
  sheet.getRange(row, 1, info.length, 2).setValues(info);
  sheet.getRange(row, 1, info.length, 1).setFontWeight('bold');
  if (meta.totalPayable != null) sheet.getRange(row + 3, 2).setNumberFormat('£#,##0.00');
  row += info.length + 1;

  sections.forEach(function (t) {
    if (t.driverHeading) {
      sheet.getRange(row, 1, 1, widest).setBackground(HEADER_BG);
      sheet.getRange(row, 1).setValue(t.driverHeading).setFontWeight('bold').setFontSize(12).setFontColor('#ffffff');
      row += 1;
    }
    row = writeTable_(sheet, row, t.title, t, widest);
  });

  sheet.autoResizeColumns(1, widest);
}

// Weekly-sheet layout: header in row 1, one row per order, nothing else on the tab.
function writeTableOnly_(sheet, table) {
  var header = table.header, rows = table.rows || [], w = header.length;
  (table.text || []).forEach(function (c) { sheet.getRange(1, c + 1, rows.length + 1, 1).setNumberFormat('@'); });
  sheet.getRange(1, 1, 1, w).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    var padded = rows.map(function (r) { var o = r.slice(0, w); while (o.length < w) o.push(''); return o; });
    sheet.getRange(2, 1, padded.length, w).setValues(padded);
    (table.money || []).forEach(function (c) { sheet.getRange(2, c + 1, padded.length, 1).setNumberFormat('0.00'); });
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, w);
}

function writeTable_(sheet, row, title, table, widest) {
  if (!table || !table.header) return row;
  var header = table.header;
  if (!(table.rows || []).length && table.skipIfEmpty) return row;
  var rows = table.rows || [];
  sheet.getRange(row, 1, 1, widest).setBackground(SECTION_BG);
  sheet.getRange(row, 1).setValue(title).setFontWeight('bold');
  row++;
  sheet.getRange(row, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(HEADER_BG);
  row++;
  if (rows.length) {
    var padded = rows.map(function (r) {
      var out = r.slice(0, header.length);
      while (out.length < header.length) out.push('');
      return out;
    });
    sheet.getRange(row, 1, padded.length, header.length).setValues(padded);
    (table.money || []).forEach(function (colIdx) {
      sheet.getRange(row, colIdx + 1, padded.length, 1).setNumberFormat('£#,##0.00');
    });
    row += padded.length;
  }
  if (table.totals) {
    var t = table.totals.slice(0, header.length);
    while (t.length < header.length) t.push('');
    sheet.getRange(row, 1, 1, header.length).setValues([t]).setFontWeight('bold')
      .setBorder(true, null, null, null, null, null);
    (table.money || []).forEach(function (colIdx) {
      sheet.getRange(row, colIdx + 1).setNumberFormat('£#,##0.00');
    });
    row++;
  }
  return row + 1;
}

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

function sanitizeTabName_(name) {
  return String(name || '').replace(/[\[\]\*\?\/\\:]/g, '-').trim().slice(0, 95);
}

function nextVersionName_(ss, base) {
  for (var v = 2; v < 1000; v++) {
    var candidate = base + ' (v' + v + ')';
    if (!ss.getSheetByName(candidate)) return candidate;
  }
  return base + ' (' + new Date().getTime() + ')';
}

function sheetUrl_(ss, sheet) {
  return ss.getUrl() + '#gid=' + sheet.getSheetId();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
