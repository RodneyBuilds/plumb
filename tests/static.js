'use strict';
/**
 * The deployment gate. Nothing ships that this cannot account for.
 *
 * The allowlist count is pinned on purpose. A new deployable file has to be
 * added here in the same commit that adds it to .claspignore, so a file can
 * never quietly start or stop being deployed.
 */
var fs = require('fs'), path = require('path'), ROOT = path.join(__dirname, '..'), APP = path.join(ROOT, 'app');
var pass = 0, fail = 0, failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

var allow = fs.readFileSync(path.join(APP, '.claspignore'), 'utf8').split(/\r?\n/)
  .filter(function (line) { return /^![^*]/.test(line); })
  .map(function (line) { return line.slice(1); });

var textFiles = allow.filter(function (file) { return /\.(gs|html)$/.test(file); });
var byFile = {};
textFiles.forEach(function (file) { byFile[file] = fs.readFileSync(path.join(APP, file), 'utf8'); });
var activeText = textFiles.map(function (file) { return byFile[file]; }).join('\n');

/* Every file that carries client-side markup or handlers. Performance added a
   second one, so the parity checks below read all of them, not just ClientJs. */
var CLIENT_FILES = ['Index.html', 'ClientJs.html', 'PerformanceUi.html', 'ImproveUi.html'];
var clientText = CLIENT_FILES.map(function (file) { return byFile[file] || ''; }).join('\n');
var serverText = byFile['Code.gs'];

var functionNames = new Set();
activeText.replace(/function\s+([A-Za-z0-9_]+)\s*\(/g, function (whole, name) { functionNames.add(name); return whole; });

/* Handlers are written both as plain markup and inside single-quoted
   JavaScript strings, so the attribute quoting varies. Match the call itself. */
var handlerNames = new Set();
clientText.replace(/on(?:click|submit|keydown|input|change)=\\?["']\s*([A-Za-z0-9_]+)\s*\(/g, function (whole, name) { handlerNames.add(name); return whole; });
var missingHandlers = Array.from(handlerNames).filter(function (name) { return !functionNames.has(name); });

var clientActions = new Set();
clientText.replace(/run\(['"]([^'"]+)['"]/g, function (whole, action) { clientActions.add(action); return whole; });
var serverActions = new Set(['bootstrap']);
serverText.replace(/['"]([^'"]+)['"]\s*:\s*function/g, function (whole, action) { serverActions.add(action); return whole; });
var missingActions = Array.from(clientActions).filter(function (action) { return !serverActions.has(action); });

/**
 * Every route the server exposes should be reachable, or it is dead weight that
 * still widens the surface an attacker can reach.
 *
 * The access.scope.save compatibility route has no direct browser caller.
 */
var KNOWN_UNREACHABLE = {
  'access.scope.save': 'Compatibility route with no direct browser caller; access.save covers this operation.'
};
var unusedActions = Array.from(serverActions).filter(function (action) {
  return action !== 'bootstrap' && !clientActions.has(action) && !KNOWN_UNREACHABLE[action];
});

console.log('\nStatic deployment gate');
var publicFunctions = [];
textFiles.filter(function (file) { return /\.gs$/.test(file); }).forEach(function (file) {
  var source = byFile[file];
  source.replace(/^function\s+([A-Za-z0-9_]+)\s*\(/gm, function (_, name) { if (!/_$/.test(name)) { publicFunctions.push(name); } });
});
check('public entry points are exactly doGet, api and onOpen', JSON.stringify(publicFunctions.sort()) === JSON.stringify(['api','doGet','onOpen']));
var manifest = JSON.parse(fs.readFileSync(path.join(APP, 'appsscript.json'), 'utf8'));
check('deployment is restricted to the Workspace domain under the deployer', manifest.webapp.access === 'DOMAIN' && manifest.webapp.executeAs === 'USER_DEPLOYING');
check('OAuth scopes are explicit and contain no cloud-platform blanket scope', Array.isArray(manifest.oauthScopes) && manifest.oauthScopes.length === 8 && !manifest.oauthScopes.some(function (scope) { return /cloud-platform/.test(scope); }));

check('clasp allowlist has 23 runtime files', allow.length === 23, JSON.stringify(allow));
check('every allowlisted file exists', allow.every(function (file) { return fs.existsSync(path.join(APP, file)); }));
check('every inline handler resolves to a real function', missingHandlers.length === 0, missingHandlers.join(', '));
check('every client API action is allowlisted on the server', missingActions.length === 0, missingActions.join(', '));
check('every server route is reachable from a client', unusedActions.length === 0, unusedActions.join(', '));
check('no empty inline handlers', !/on(?:click|submit|keydown|input|change)=\\?["']\s*\\?["']/.test(clientText));
check('no placeholder links', !/href=["']#["']/.test(activeText));
/* Playbook is an implemented navigation surface. */
check('no deferred module labels in deployable text', !/(OD Diagnostic|Site Pipeline|Source Library|Work Records|Promoted to pipeline|linkedPipeline)/i.test(activeText));
check('single public client API function', Array.from(functionNames).filter(function (name) { return name === 'api'; }).length === 1);
check('the client is included before it is called', byFile['Index.html'].indexOf("include_('PerformanceUi')") < byFile['Index.html'].indexOf("include_('ClientJs')"));

/* ---------------- the product name is carried by exactly 1 constant ---------------- */
var nameMatch = byFile['Logic.gs'].match(/var PRODUCT_NAME = '([^']+)'/);
check('Logic.gs declares the product name once', !!nameMatch, 'no PRODUCT_NAME declaration found');
var productName = nameMatch ? nameMatch[1] : '__none__';
var literalHits = [];
textFiles.forEach(function (file) {
  var lines = byFile[file].split(/\r?\n/);
  lines.forEach(function (line, index) {
    if (line.indexOf(productName) === -1) { return; }
    if (file === 'Logic.gs' && /var PRODUCT_NAME =/.test(line)) { return; }
    literalHits.push(file + ':' + (index + 1));
  });
});
check('the product name literal appears nowhere else in the deployable app', literalHits.length === 0, literalHits.join(', '));

/* A rename must never require touching customer data, so the constant must not
   reach any call that writes a row. */
var WRITERS = ['appendRow_', 'appendRows_', 'writeRowAt_', 'upsertByKey_', 'bulkUpsertByKey_', 'mergeMissingByKey_', 'setValues'];
var writeHits = [];
textFiles.forEach(function (file) {
  byFile[file].split(/\r?\n/).forEach(function (line, index) {
    if (line.indexOf('PRODUCT_NAME') === -1) { return; }
    if (WRITERS.some(function (writer) { return line.indexOf(writer) !== -1; })) { writeHits.push(file + ':' + (index + 1)); }
  });
});
check('the product name is never on a line that writes a row', writeHits.length === 0, writeHits.join(', '));

/* ---------------- Performance shape ---------------- */
check('the 3 new deployable files are present', ['Performance.gs', 'Reminders.gs', 'PerformanceUi.html'].every(function (file) { return allow.indexOf(file) !== -1; }));
check('reminders cannot email anyone until they are switched on', /REMINDERS_ENABLED/.test(byFile['Reminders.gs']) && /function remindersEnabled_/.test(byFile['Reminders.gs']));
check('no mail is sent outside the guarded round', (byFile['Reminders.gs'].match(/MailApp\.sendEmail/g) || []).length === 1);
check('reduced motion is honoured', /prefers-reduced-motion/.test(byFile['Styles.html']));
check('the entry worksheet persists a recoverable complete command', /performanceRun_\(user, payload, 'actual.saveMonth'/.test(byFile['Performance.gs']) && /operationStep_\('Actuals'/.test(byFile['Performance.gs']));
check('every performance write uses the locked operation runner', (byFile['Performance.gs'].match(/return performanceRun_\(/g) || []).length === 6 && /operationRunLocked_/.test(byFile['Performance.gs']));

/* ---------------- Guidance shape ---------------- */
check('the 2 new deployable files are present', ['Playbook.gs', 'ImproveUi.html'].every(function (file) { return allow.indexOf(file) !== -1; }));
check('playbook alerts cannot email anyone until they are switched on',
  /PLAYBOOK_ALERTS_ENABLED/.test(byFile['Playbook.gs']) && /function playbookAlertsEnabled_/.test(byFile['Playbook.gs']));
check('playbook email uses the shared durable outbox', !/MailApp\.sendEmail/.test(byFile['Playbook.gs']) && /outboxEnqueue_/.test(byFile['Playbook.gs']));
check('the Doc structural headings use the defined green',
  /PLAYBOOK_HEADING_GREEN_ = '#19713F'/.test(byFile['Playbook.gs']));

/**
 * The deterministic-guidance rule, enforced rather than trusted.
 *
 * The application contract says the app shows the maintained block or nothing. The risk is
 * not that somebody wires an AI call in; it is that a helpful default creeps
 * into a renderer, one fallback string at a time, until the panel is quietly
 * saying something no human wrote. So the client file that renders guidance may
 * not contain a step-shaped literal.
 */
var guidanceUi = byFile['ImproveUi.html'];
var inventedSteps = (guidanceUi.match(/<li>(?!' \+ esc)/g) || []);
check('the guidance panel renders no step it was not given', inventedSteps.length === 0, String(inventedSteps.length) + ' hardcoded list items');
check('the provenance line is present and exact', /shown exactly as written, nothing generated/.test(guidanceUi));
check('the honest empty state is present and exact',
  /The manual has nothing for <b>this metric in this situation<\/b> yet\./.test(guidanceUi));
check('the empty state offers a different next step to a manager and to site staff',
  /Add a section for it so this never comes up blank again\./.test(guidanceUi)
  && /Ask a manager to add a section for it\./.test(guidanceUi));
check('the product name still reaches the panel from the server constant, never a literal',
  /BOOT\.branding\.productName/.test(guidanceUi));

console.log('\n----------------------------------------');
console.log('PASSED ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('Static deployment gate passed.');
