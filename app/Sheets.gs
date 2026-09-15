/**
 * Sheets.gs - the ONLY layer that reads or writes Google Sheets.
 * All Intake records go through this boundary.
 */

/**
 * The datastore spreadsheet.
 * Default (bound install): the spreadsheet the script is attached to, so there
 * is nothing to configure. Optional (standalone install): if a SPREADSHEET_ID
 * Script Property is set, use that instead.
 */
function ss_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) { return SpreadsheetApp.openById(id); }
  // Container contexts (menu, onOpen, editor) can see the bound spreadsheet.
  // Record its id so the web app, which cannot see it, can open it by id.
  var bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) {
    try { props.setProperty('SPREADSHEET_ID', bound.getId()); } catch (e) {}
    return bound;
  }
  throw new Error('E_CONFIG: no bound spreadsheet found and SPREADSHEET_ID is not set. Open the app from its Google Sheet once so it can record the id.');
}

function sheetByName_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) { throw new Error('E_CONFIG: sheet "' + name + '" is missing. Run setupWorkspace_().'); }
  return sh;
}

/** True if a tab exists (used to tolerate a not-yet-set-up workspace). */
function hasSheet_(name) {
  return !!ss_().getSheetByName(name);
}

/** Read a whole tab as an array of row objects keyed by the header row. */
function readTable_(name) {
  var sh = sheetByName_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) { return []; }
  var headers = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') { continue; }
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
    }
    obj._row = r + 1; // 1-based sheet row, for in-place updates
    out.push(obj);
  }
  return out;
}

function headersOf_(name) {
  var sh = sheetByName_(name), lastCol = sh.getLastColumn();
  if (lastCol < 1) { return []; }
  return sh.getRange(1, 1, 1, lastCol).getValues()[0];
}

/** Append an object as a new row, mapping keys to the header order. */
function appendRow_(name, obj) {
  var sh = sheetByName_(name);
  var headers = headersOf_(name);
  var line = headers.map(function (h) { return obj.hasOwnProperty(h) ? sheetValue_(obj[h]) : ''; });
  sh.getRange(sh.getLastRow() + 1, 1, 1, line.length).setValues([line]);
}

/**
 * Append many objects as one write.
 * The application contract saves a whole month in a single go, and this is the call that
 * makes that literal: N rows leave the script as 1 setValues, so the lock is
 * held once and the write queue drains once rather than N times.
 */
function appendRows_(name, objects) {
  objects = objects || [];
  if (!objects.length) { return 0; }
  var sh = sheetByName_(name), headers = headersOf_(name);
  var lines = objects.map(function (obj) {
    return headers.map(function (header) { return obj.hasOwnProperty(header) ? sheetValue_(obj[header]) : ''; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, lines.length, headers.length).setValues(lines);
  return lines.length;
}

/** Find the first row object matching a key column value, or null. */
function findRow_(name, keyCol, keyVal) {
  var rows = readTable_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) === String(keyVal)) { return rows[i]; }
  }
  return null;
}

/** Overwrite a specific sheet row (1-based) from an object, by header order. */
function writeRowAt_(name, rowIndex, obj) {
  var sh = sheetByName_(name);
  var headers = headersOf_(name);
  var line = headers.map(function (h) { return obj.hasOwnProperty(h) ? sheetValue_(obj[h]) : ''; });
  sh.getRange(rowIndex, 1, 1, headers.length).setValues([line]);
}

/** Prevent user-entered text from becoming a spreadsheet formula. */
function sheetValue_(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) { return "'" + value; }
  return value;
}

function deleteRowAt_(name, rowIndex) { sheetByName_(name).deleteRow(rowIndex); }

/**
 * Insert or update by a key column. If a row with obj[keyCol] exists, merge
 * and rewrite it; otherwise append. Returns the stored object.
 */
function upsertByKey_(name, keyCol, obj) {
  var existing = findRow_(name, keyCol, obj[keyCol]);
  if (existing) {
    var merged = {};
    var headers = headersOf_(name);
    headers.forEach(function (h) {
      merged[h] = obj.hasOwnProperty(h) ? obj[h] : existing[h];
    });
    writeRowAt_(name, existing._row, merged);
    return merged;
  }
  appendRow_(name, obj);
  return obj;
}

/**
 * Upsert many rows with one read and one write.
 */
function bulkUpsertByKey_(name, keyCol, objects) {
  objects = objects || [];
  if (!objects.length) { return []; }
  var sh = sheetByName_(name), values = sh.getDataRange().getValues(), headers = values[0];
  var keyIndex = headers.indexOf(keyCol);
  if (keyIndex === -1) { throw new Error('E_CONFIG: key column "' + keyCol + '" is missing from ' + name + '.'); }
  var rows = values.slice(1), index = {};
  rows.forEach(function (row, rowIndex) { index[String(row[keyIndex])] = rowIndex; });
  objects.forEach(function (obj) {
    var line = headers.map(function (header) { return obj.hasOwnProperty(header) ? sheetValue_(obj[header]) : ''; });
    var key = String(obj[keyCol]);
    if (index.hasOwnProperty(key)) { rows[index[key]] = line; }
    else { index[key] = rows.length; rows.push(line); }
  });
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return objects;
}

/** Seed helper: insert a missing row or fill only blank cells on an existing row. */
function mergeMissingByKey_(name, keyCol, obj) {
  var existing = findRow_(name, keyCol, obj[keyCol]);
  if (!existing) { appendRow_(name, obj); return obj; }
  var merged = {}, changed = false;
  headersOf_(name).forEach(function (header) {
    var oldValue = existing[header];
    if ((oldValue === '' || oldValue == null) && obj.hasOwnProperty(header) && obj[header] !== '') { merged[header] = obj[header]; changed = true; }
    else { merged[header] = oldValue; }
  });
  if (changed) { writeRowAt_(name, existing._row, merged); }
  return merged;
}

/** Stable identifiers do not depend on user input. */
function newId_(prefix) {
  return (prefix || 'id') + '_' + Utilities.getUuid();
}

function nowIso_() {
  return new Date().toISOString();
}

function audit_(entity, recordId, action, before, after, actor) {
  appendRow_('AuditLog', { id: newId_('audit'), entity: entity, recordId: recordId, action: action, beforeJson: before ? JSON.stringify(cleanRow_(before)) : '', afterJson: after ? JSON.stringify(cleanRow_(after)) : '', actor: actor, at: nowIso_() });
}

/**
 * Run a mutation under a script lock so concurrent writes do not collide.
 * Writes are serialized on purpose; the lock is the correctness boundary.
 * If the wait is exhausted under heavy concurrency we surface a friendly,
 * retryable E_BUSY instead of a raw internal error so the client can retry.
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockTimeout) {
    throw new Error('E_BUSY: the hub is saving other changes right now. Please try again in a moment.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
