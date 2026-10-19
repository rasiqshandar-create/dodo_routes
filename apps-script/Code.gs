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
 */

// "Dodo Routes" spreadsheet. A Script property SPREADSHEET_ID overrides this.
var DEFAULT_SPREADSHEET_ID = '1qvQiAPmlhssIxpGLTEWQhyGm78kYOgcUFHeZ_3BlwXk';

var HEADER_BG = '#1f3a5f';
var SECTION_BG = '#e8eef6';

// Where the tool is hosted (GitHub Pages). The connect link opens this with the settings attached.
var APP_URL = 'https://rasiqshandar-create.github.io/dodo_routes/';

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
  var url = ScriptApp.getService().getUrl();
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
  var meta = req.meta || {};
  var row = 1;
  var widest = Math.max(
    (req.deliveries && req.deliveries.header || []).length,
    (req.routes && req.routes.header || []).length,
    (req.drivers && req.drivers.header || []).length, 4);

  sheet.getRange(row, 1).setValue('Dodo driver payments — ' + tabName)
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

  row = writeTable_(sheet, row, 'DRIVER PAYMENT SUMMARY', req.drivers, widest);
  row = writeTable_(sheet, row, 'ROUTE TOTALS (driver × day)', req.routes, widest);
  row = writeTable_(sheet, row, 'DELIVERIES', req.deliveries, widest);

  sheet.setFrozenRows(0);
  sheet.autoResizeColumns(1, widest);
}

function writeTable_(sheet, row, title, table, widest) {
  if (!table || !table.header) return row;
  var header = table.header;
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
