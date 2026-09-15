'use strict';
var path = require('path'), L = require(path.join(__dirname, '..', 'app', 'Logic.gs'));
var pass = 0, fail = 0, failures = [];
function check(name, condition) { if (condition) { pass++; console.log('  PASS  ' + name); } else { fail++; failures.push(name); console.log('  FAIL  ' + name); } }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
console.log('\nProduct scope');
check('10 navigation surfaces, in cycle order', eq(L.NAV.map(function (x) { return x.id; }), ['home', 'performance', 'entry', 'rollup', 'intake', 'goals', 'metrics', 'playbook', 'access', 'admin']));
check('23 managed tables', L.SHEETS.length === 23, String(L.SHEETS.length));
check('the 4 performance tables are declared', ['Metrics','Goals','Actuals','NotificationLog'].every(function (name) { return L.SHEETS.map(function (s) { return s.name; }).indexOf(name) !== -1; }));
check('no unsupported module tables', ['Diagnostics','Pipeline','Playbook','Projects','Reports','SourceSections','StatusSnapshot'].every(function (name) { return L.SHEETS.map(function (s) { return s.name; }).indexOf(name) === -1; }));
check('performance statuses remain calculated while guidance snapshots are versioned', L.SHEETS.every(function (s) { return !/status.*snapshot/i.test(s.name); }) && L.SHEETS.some(function (s) { return s.name === 'GuidanceSnapshots'; }));
check('Intake schema carries submissionKey and version', ['submissionKey','version'].every(function (h) { return L.SHEETS.filter(function (s) { return s.name === 'Intake'; })[0].headers.indexOf(h) !== -1; }));
check('headers and table names are unique', new Set(L.SHEETS.map(function (s) { return s.name; })).size === L.SHEETS.length && L.SHEETS.every(function (s) { return new Set(s.headers).size === s.headers.length; }));

console.log('\nRole journeys');
check('admin reaches every surface', eq(L.navForRole('admin').map(function (x) { return x.id; }), ['home','performance','entry','rollup','intake','goals','metrics','playbook','access','admin']));
check('regional reaches everything but the metric library and Admin', eq(L.navForRole('regional').map(function (x) { return x.id; }), ['home','performance','entry','rollup','intake','goals','playbook','access']));
check('site staff enter numbers but do not set up', eq(L.navForRole('site').map(function (x) { return x.id; }), ['home','performance','entry','intake','playbook','access']));
check('viewer sees Home and My access', eq(L.navForRole('viewer').map(function (x) { return x.id; }), ['home','access']));
check('site lacks manage permission', !L.roleHasPermission('site','intake.manage',L.DEFAULT_ROLE_PERMISSIONS));
check('regional has manage permission', L.roleHasPermission('regional','intake.manage',L.DEFAULT_ROLE_PERMISSIONS));

console.log('\nScope and concurrency rules');
var regionOf = function (site) { return { NorthSite: 'North', SouthSite: 'South' }[site]; };
check('regional scope includes its region', L.rowInScope('regional',{region:'North'},{site:'NorthSite'},regionOf));
check('regional scope excludes another region', !L.rowInScope('regional',{region:'North'},{site:'SouthSite'},regionOf));
check('site scope includes own site', L.rowInScope('site',{site:'NorthSite'},{site:'NorthSite'},regionOf));
check('viewer has no Intake row access', !L.rowInScope('viewer',{}, {site:'NorthSite'},regionOf));
check('matching version is accepted', L.versionMatches(4,4));
check('stale version is rejected', !L.versionMatches(5,4));
check('version increments by 1', L.nextVersion(5) === 6);
check('allowed transition works', L.transitionAllowed('New','Triaged'));
check('skipped transition is rejected', !L.transitionAllowed('New','In Progress'));

console.log('\n----------------------------------------');
console.log('PASSED ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('All Intake pure-logic checks passed.');
