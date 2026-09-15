/**
 * Local emulator: serves the REAL production front-end (Index/Styles/ClientJs)
 * and runs the REAL server code (app/*.gs) in a simulated Apps Script runtime
 * with an in-memory Sheets datastore. google.script.run is bridged to the
 * actual server functions over HTTP.
 *
 * This lets a browser click through the true app (not the prototype), so any
 * unwired endpoint or field mismatch shows up as a real failure.
 *
 * Run: node tests/emulator.js [port]   (default 8790)
 * Switch user: GET /setuser?email=...   (sets a cookie; role comes from Access)
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var APP = path.join(__dirname, '..', 'app');
var PORT = Number(process.argv[2] || 8790);

/* ---------- in-memory Google fakes ---------- */
function Sheet(name) { this.name = name; this._v = []; }
Sheet.prototype.getName = function () { return this.name; };
Sheet.prototype.getLastRow = function () { return this._v.length; };
Sheet.prototype.getLastColumn = function () { return this._v.reduce(function (m, r) { return Math.max(m, r.length); }, 0); };
Sheet.prototype.getDataRange = function () {
  var v = this._v.length ? this._v : [['']];
  var cols = v.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
  return new Range(this, 1, 1, v.length, cols);
};
Sheet.prototype.getRange = function (r, c, nr, nc) { return new Range(this, r, c, nr, nc); };
Sheet.prototype.appendRow = function (line) { this._v.push(line.slice()); };
Sheet.prototype.setFrozenRows = function () {};
Sheet.prototype.deleteRow = function (row) { this._v.splice(row - 1, 1); };
Sheet.prototype.getMaxRows = function () { return Math.max(1000,this._v.length); };
function Range(s, r, c, nr, nc) { this.s = s; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
Range.prototype.setNumberFormat = function (format) { if (format !== '@') { throw new Error('unexpected number format'); } return this; };
Range.prototype.getValues = function () {
  var out = [];
  for (var i = 0; i < this.nr; i++) {
    var row = [], src = this.s._v[this.r - 1 + i] || [];
    for (var j = 0; j < this.nc; j++) { var v = src[this.c - 1 + j]; row.push(v === undefined ? '' : v); }
    out.push(row);
  }
  return out;
};
Range.prototype.setValues = function (vals) {
  for (var i = 0; i < vals.length; i++) {
    var ri = this.r - 1 + i;
    while (this.s._v.length <= ri) { this.s._v.push([]); }
    for (var j = 0; j < vals[i].length; j++) { this.s._v[ri][this.c - 1 + j] = vals[i][j]; }
  }
  return this;
};
function Book() { this.sheets = {}; this.order = []; }
Book.prototype.getId = function () { return 'bound-sheet-id'; };
Book.prototype.getName = function () { return 'Operations Workspace TEST'; };
Book.prototype.getOwner = function () { return { getEmail: function () { return 'admin@example.org'; } }; };
Book.prototype.getSheetByName = function (n) { return this.sheets[n] || null; };
Book.prototype.insertSheet = function (n) { var s = new Sheet(n); this.sheets[n] = s; this.order.push(n); return s; };
Book.prototype.getSheets = function () { var self = this; return this.order.map(function (n) { return self.sheets[n]; }); };
Book.prototype.deleteSheet = function (s) { delete this.sheets[s.name]; this.order = this.order.filter(function (n) { return n !== s.name; }); };

var BOOK = new Book();
var CURRENT_EMAIL = 'admin@example.org';
var scriptProps = { ENVIRONMENT: 'TEST', DEMO_MODE: 'true', WORKSPACE_DOMAIN: 'example.org', DEPLOYMENT_ACCOUNT_EMAIL: 'admin@example.org', CUSTOMER_NAME: 'Harbor Community Network', CUSTOMER_SHORT_NAME: 'Harbor Community', CUSTOMER_DESCRIPTOR: 'Multi-site programs', CUSTOMER_MARK: 'HC', CUSTOMER_ACCENT: '#19713F' }; // no SPREADSHEET_ID -> uses bound (getActiveSpreadsheet)
var userProps = {};
function propStore(store) { return { getProperty: function (k) { return store[k] || null; }, setProperty: function (k, v) { store[k] = v; return this; } }; }

/* Guidance reads a Google Doc and makes decisions from its heading structure, so
   the Doc fake has to be able to hold a heading. Shared with the offline suite
   so the clickable emulator and tests/integration.js cannot drift apart. */
var GAS = require('./gas-doc-fakes.js').build({ ownerEmail: 'admin@example.org' });
var DRIVE_FOLDERS = {}, DRIVE_FILES = {};
function driveIterator(items) { var i = 0; return { hasNext: function () { return i < items.length; }, next: function () { return items[i++]; } }; }
function folder(id, name, parentId) { var f = { id: id, name: name, parentId: parentId || '', getId: function () { return id; }, getName: function () { return name; }, getFoldersByName: function (wanted) { return driveIterator(Object.keys(DRIVE_FOLDERS).map(function (key) { return DRIVE_FOLDERS[key]; }).filter(function (child) { return child.parentId === id && child.name === wanted; })); }, createFolder: function (childName) { return folder('folder_' + Object.keys(DRIVE_FOLDERS).length, childName, id); }, createFile: function () { return { getUrl: function () { return 'https://drive.google.com/file/d/FAKE_PDF_ID/view'; }, getName: function () { return 'Sample Report.pdf'; } }; } }; DRIVE_FOLDERS[id] = f; return f; }
var DRIVE_ROOT = folder('root', 'My Drive', '');
function driveFile(id, name, parentId) { var file = { id: id, name: name, parentId: parentId || 'root', getId: function () { return id; }, getName: function () { return name; }, getUrl: function () { return 'https://docs.google.com/document/d/' + id + '/edit'; }, getParents: function () { return driveIterator([DRIVE_FOLDERS[file.parentId]]); }, moveTo: function (target) { file.parentId = target.getId(); return file; }, getAs: function () { return { setName: function () { return {}; } }; }, makeCopy: function (copyName, target) { return driveFile('copy_' + Date.now(), copyName || name, target ? target.getId() : 'root'); }, setTrashed: function () {} }; DRIVE_FILES[id] = file; return file; }
driveFile('bound-sheet-id', 'Operations Workspace TEST', 'root');

var sentMail = [];
var sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean, isFinite: isFinite, Set: Set,
  encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
  SpreadsheetApp: { openById: function () { return BOOK; }, getActiveSpreadsheet: function () { return BOOK; } },
  Utilities: { getUuid: require('crypto').randomUUID, DigestAlgorithm:{SHA_256:'sha256'}, Charset:{UTF_8:'utf8'}, computeDigest:function(algorithm,text){return Array.from(require('crypto').createHash(algorithm).update(text).digest());} },
  Session: { getEffectiveUser: function () { return { getEmail: function () { return 'admin@example.org'; } }; }, getActiveUser: function () { return { getEmail: function () { return CURRENT_EMAIL; } }; } },
  PropertiesService: { getScriptProperties: function () { return propStore(scriptProps); }, getUserProperties: function () { return propStore(userProps); } },
  CacheService: { getScriptCache: function () { var store = {}; return { get: function (k) { return store[k] || null; }, put: function (k, v) { store[k] = v; } }; } },
  LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
  MailApp: { sendEmail: function (to, s, b) { sentMail.push({ to: to }); } },
  ScriptApp: (function () {
    var triggers = [];
    function trigger(handler) { return { getHandlerFunction: function () { return handler; } }; }
    return {
      getService: function () { return { getUrl: function () { return 'https://script.google.com/a/example.org/exec'; } }; },
      getProjectTriggers: function () { return triggers.slice(); },
      deleteTrigger: function (target) { triggers = triggers.filter(function (item) { return item !== target; }); },
      getOAuthToken: function () { return 'fake-oauth-token'; },
      newTrigger: function (handler) {
        var builder = {
          timeBased: function () { return builder; }, atHour: function () { return builder; },
          everyDays: function () { return builder; }, everyHours: function () { return builder; },
          create: function () { triggers.push(trigger(handler)); }
        };
        return builder;
      }
    };
  }()),
  DocumentApp: GAS.DocumentApp,
  UrlFetchApp: GAS.UrlFetchApp,
  DriveApp: {
    getFileById: function (id) {
      try { return GAS.DriveApp.getFileById(id); } catch (notADoc) {}
      return DRIVE_FILES[id] || driveFile(id, id, 'root');
    },
    getFolderById: function (id) { return DRIVE_FOLDERS[id]; },
    getRootFolder: function () { return DRIVE_ROOT; }
  }
};
vm.createContext(sandbox);

['Logic', 'Operations', 'Outbox', 'Backup', 'GuidanceSnapshots', 'RecoveryAdmin', 'Sheets', 'Rbac', 'AccessModel', 'Auth', 'Performance', 'Playbook', 'Reminders', 'Setup', 'Intake', 'Menu', 'Code'].forEach(function (n) {
  vm.runInContext(fs.readFileSync(path.join(APP, n + '.gs'), 'utf8'), sandbox, { filename: n + '.gs' });
});

/* seed content so the app has something to show */
CURRENT_EMAIL = 'admin@example.org';
sandbox.setupWorkspace_();
sandbox.seedTestData_();
seedPlaybook();

/**
 * A manual with something written in it, so the emulator shows the real thing
 * rather than an empty state. The steps are fixture text, not advice the app
 * generated: this is the same thing a person would have typed in Google Docs.
 */
function seedPlaybook() {
  var made = sandbox.api({ action: 'playbook.ensureDoc', payload: {} });
  if (!made || !made.ok) { console.log('playbook seed skipped: ' + (made && made.error)); return; }
  var docId = sandbox.playbookDocId_();
  var write = [
    ['On track, sustain', ['Keep the housing screen on the intake checklist.']],
    ['At risk, recover', ['Spot-check 5 intakes a week for a completed screen.', 'Add the housing screen to the intake checklist so it cannot be skipped.']],
    ['Off track, urgent', ['The site lead reviews every incomplete screen daily until the number recovers.', 'Make the housing screen a required field before an intake can be closed.']]
  ];
  write.forEach(function (entry) {
    entry[1].forEach(function (step) { GAS.insertAfter(docId, entry[0], { kind: 'body', text: step }); });
  });
  /* A site override on the situation Harbor North is actually in, so the
     layering the prototype shows is visible in the emulator rather than
     theoretical. */
  GAS.append(docId, { kind: 'heading2', text: 'Metric: Clients screened for housing need (Site: Harbor North)' });
  GAS.append(docId, { kind: 'heading3', text: 'At risk, recover' });
  GAS.append(docId, { kind: 'body', text: 'Use the shared screening list the site lead keeps.' });
  GAS.append(docId, { kind: 'heading2', text: 'Metric: Clients served' });
  GAS.append(docId, { kind: 'heading3', text: 'On track, sustain' });
  GAS.append(docId, { kind: 'body', text: 'Hold the current intake cadence and staffing.' });
  sandbox.api({ action: 'playbook.recheck', payload: {} });
  seedOffTrackGoal();
}

/**
 * One genuinely off-track goal.
 *
 * The Performance seed deliberately covers on track, at risk, not reported, no data
 * and stale, but nothing lands below the at-risk line, so the urgent branch of
 * the guidance panel had no way to render. That is the headline case of the
 * whole feature, which makes it the last thing that should go unexercised.
 */
function seedOffTrackGoal() {
  var period = sandbox.openPeriod_();
  var made = sandbox.api({
    action: 'goal.save',
    payload: { submissionKey: 'demo-central-goal', metricId: 'metric-housing-screen', site: 'Harbor Central', goalKind: 'period', target: 80, owner: 'Sample Central Manager', ownerEmail: 'regional@example.org' }
  });
  if (!made || !made.ok) { console.log('off-track seed skipped: ' + (made && made.error)); return; }

  /* A full 6 periods, declining. An off-track goal sorts to the front of the
     board, so a goal with one lonely number would become the first card every
     other browser suite opens, and they would start asserting against a shape
     no real goal has. It gets the same history everything else has. */
  var periods = sandbox.periodsEndingAt_(period, sandbox.TRAJECTORY_PERIODS);
  var series = [[41, 52], [38, 53], [30, 50], [24, 51], [14, 50], [4, 50]];
  sandbox.appendRows_('Actuals', series.map(function (entry, index) {
    return {
      actualId: 'seed-offtrack-' + periods[index],
      goalId: made.item.goalId, site: 'Harbor Central', period: periods[index],
      numerator: entry[0], denominator: entry[1], value: (entry[0] / entry[1]) * 100,
      noData: false, note: '', submissionKey: 'seed-offtrack-' + periods[index],
      supersedesActualId: '', correctionReason: '', approvedBy: '',
      enteredBy: 'regional@example.org',
      enteredAt: sandbox.periodFromIndex_(sandbox.periodIndex_(periods[index]) + 1) + '-02T09:00:00.000Z'
    };
  }));
}

/* Break a heading on demand, so the broken banner can be seen and tested
   without anybody hand-editing a real Google Doc. */
function breakPlaybookHeading() {
  var docId = sandbox.playbookDocId_();
  GAS.rename(docId, 'Off track, urgent', 'When it is really bad');
  return sandbox.api({ action: 'playbook.recheck', payload: {} });
}
function repairPlaybookHeading() {
  var docId = sandbox.playbookDocId_();
  try { GAS.rename(docId, 'When it is really bad', 'Off track, urgent'); } catch (alreadyFine) {}
  return sandbox.api({ action: 'playbook.recheck', payload: {} });
}

/* ---------- assemble the front-end ---------- */
var SHIM = [
  '<script>',
  '(function(){',
  '  function chain(state){',
  '    return new Proxy(function(){}, { get:function(_,prop){',
  '      if(prop==="withSuccessHandler") return function(f){ return chain(Object.assign({},state,{success:f})); };',
  '      if(prop==="withFailureHandler") return function(f){ return chain(Object.assign({},state,{failure:f})); };',
  '      if(typeof prop!=="string") return undefined;',
  '      return function(){ var args=[].slice.call(arguments);',
  '        fetch("/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fn:prop,args:args})})',
  '          .then(function(r){return r.json();})',
  '          .then(function(j){ if(j&&j.__error){ if(state.failure) state.failure(new Error(j.__error)); } else { if(state.success) state.success(j.result); } })',
  '          .catch(function(e){ if(state.failure) state.failure(e); }); };',
  '    }});',
  '  }',
  '  window.google = { script: { run: chain({}), host:{close:function(){}}, url:{} } };',
  '})();',
  '</script>'
].join('\n');

function renderIndex() {
  var idx = fs.readFileSync(path.join(APP, 'Index.html'), 'utf8');
  var styles = fs.readFileSync(path.join(APP, 'Styles.html'), 'utf8');
  var client = fs.readFileSync(path.join(APP, 'ClientJs.html'), 'utf8');
  var performance = fs.readFileSync(path.join(APP, 'PerformanceUi.html'), 'utf8');
  var improve = fs.readFileSync(path.join(APP, 'ImproveUi.html'), 'utf8');
  idx = idx.replace(/<\?!=\s*include_\('Styles'\);\s*\?>/, styles);
  idx = idx.replace(/<\?!=\s*include_\('PerformanceUi'\);\s*\?>/, performance);
  idx = idx.replace(/<\?!=\s*include_\('ImproveUi'\);\s*\?>/, improve);
  idx = idx.replace(/<\?!=\s*include_\('ClientJs'\);\s*\?>/, client);
  idx = idx.replace('</head>', SHIM + '\n</head>'); // shim before client runs
  return idx;
}

function parseCookie(h) { var o = {}; (h || '').split(';').forEach(function (p) { var i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }

http.createServer(function (req, res) {
  var cookies = parseCookie(req.headers.cookie);
  if (cookies.email) { CURRENT_EMAIL = cookies.email; }

  if (req.method === 'GET' && req.url.indexOf('/setuser') === 0) {
    var email = decodeURIComponent((req.url.split('email=')[1] || '').split('&')[0]) || 'admin@example.org';
    res.writeHead(302, { 'Set-Cookie': 'email=' + encodeURIComponent(email) + '; Path=/', 'Location': '/' });
    return res.end();
  }
  /* Break and repair the manual from the outside, the way a person editing the
     Doc would, so the broken banner is reachable by a browser test. */
  if (req.method === 'GET' && req.url.indexOf('/playbook/') === 0) {
    var outcome = req.url.indexOf('/playbook/break') === 0 ? breakPlaybookHeading() : repairPlaybookHeading();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: outcome && outcome.health ? outcome.health.status : 'unknown' }));
  }
  if (req.method === 'POST' && req.url === '/run') {
    var body = '';
    req.on('data', function (d) { body += d; });
    req.on('end', function () {
      var out;
      try {
        var p = JSON.parse(body || '{}');
        if (cookies.email) { CURRENT_EMAIL = cookies.email; }
        if (p.fn !== 'api') { throw new Error('E_FORBIDDEN: only the public request handler is callable.'); }
        var fn = sandbox[p.fn];
        if (typeof fn !== 'function') { throw new Error('E_NO_ENDPOINT: server has no function "' + p.fn + '"'); }
        var result = fn.apply(null, p.args || []);
        out = { result: result };
      } catch (e) { out = { __error: (e && e.message) || String(e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  // default: serve the app
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderIndex());
}).listen(PORT, '127.0.0.1', function () {
  console.log('Local workspace emulator on http://127.0.0.1:' + PORT + '  (real client + real server + fake Sheets)');
  console.log('Users: admin@example.org (admin), regional@example.org (regional North), site@example.org (site Harbor North), viewer@example.org (viewer)');
});
