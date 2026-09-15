'use strict';
/**
 * The browser repeats exactly one piece of the status engine: the final
 * comparison that turns a number into On track, At risk or Off track while
 * somebody is still typing. Anything repeated in 2 places drifts, so this test
 * lifts that function straight out of PerformanceUi.html and asserts it agrees
 * with the real engine on every goal kind and both metric directions.
 *
 * If somebody changes the engine and forgets the browser, this fails.
 */
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
var L = require(path.join(ROOT, 'app', 'Logic.gs'));

var source = fs.readFileSync(path.join(ROOT, 'app', 'PerformanceUi.html'), 'utf8');
var START = '/* ---8<--- PREVIEW-PARITY-START ---8<---';
var END = '/* ---8<--- PREVIEW-PARITY-END ---8<--- */';
var startIndex = source.indexOf(START), endIndex = source.indexOf(END);

var pass = 0, fail = 0, failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

console.log('\nBrowser preview against the real engine');
check('the marked block is present in PerformanceUi.html', startIndex !== -1 && endIndex > startIndex);
if (startIndex === -1 || endIndex <= startIndex) {
  console.log('\nFAILURES:\n  - the parity block markers are missing, so nothing could be compared');
  process.exit(1);
}

var block = source.slice(startIndex, endIndex);
var sandbox = { Math: Math, Number: Number, isFinite: isFinite };
vm.createContext(sandbox);
vm.runInContext(block, sandbox, { filename: 'PerformanceUi.preview.js' });
check('the extracted block defines the preview function', typeof sandbox.perfPreviewStatus === 'function');

/* Every case runs through the real engine as a freshly reported open period, so
   the engine reaches its scoring branch and the two answers are comparable. */
var PERIOD = '2026-07';
var AS_OF = new Date('2026-08-03T00:00:00Z');
var HIGHER = { metricType: 'count', direction: 'higher' };
var LOWER = { metricType: 'count', direction: 'lower' };

var CASES = [];
[
  { name: 'period, higher is better', goal: { goalKind: 'period', target: 40, onTrackPace: 0.9, atRiskPace: 0.6 }, metric: HIGHER, values: [0, 10, 24, 25, 36, 40, 55, 120] },
  { name: 'period, lower is better', goal: { goalKind: 'period', target: 12, onTrackPace: 0.9, atRiskPace: 0.6 }, metric: LOWER, values: [0, 1, 11, 12, 13, 20, 40] },
  { name: 'hold, higher is better', goal: { goalKind: 'hold', target: 95, onTrackPace: 0.98, atRiskPace: 0.9 }, metric: HIGHER, values: [70, 85, 86, 92, 93.1, 95, 99] },
  { name: 'hold, lower is better', goal: { goalKind: 'hold', target: 5, onTrackPace: 0.9, atRiskPace: 0.6 }, metric: LOWER, values: [0, 2, 5, 6, 9, 15] },
  { name: 'journey upward', goal: { goalKind: 'journey', baseline: 40, target: 60, startDate: '2026-01-01', targetDate: '2026-12-31', onTrackPace: 0.9, atRiskPace: 0.6 }, metric: HIGHER, values: [38, 40, 44, 47, 50, 55, 61, 80] },
  { name: 'journey downward', goal: { goalKind: 'journey', baseline: 22, target: 12, startDate: '2026-01-01', targetDate: '2027-06-30', onTrackPace: 0.9, atRiskPace: 0.6 }, metric: LOWER, values: [24, 22, 20, 18.5, 16, 12, 9] },
  { name: 'strict thresholds', goal: { goalKind: 'period', target: 50, onTrackPace: 1.2, atRiskPace: 1.0 }, metric: HIGHER, values: [40, 50, 55, 60, 61] },
  { name: 'a target of zero does not divide by zero', goal: { goalKind: 'period', target: 0, onTrackPace: 0.9, atRiskPace: 0.6 }, metric: HIGHER, values: [0, 5] }
].forEach(function (group) {
  group.values.forEach(function (value) { CASES.push({ group: group, value: value }); });
});

var mismatches = [];
CASES.forEach(function (testCase) {
  var goal = testCase.group.goal, metric = testCase.group.metric, value = testCase.value;
  var row = { actualId: 'A1', period: PERIOD, value: value, numerator: null, denominator: null, noData: false };
  var engine = L.computeGoalStatus(goal, [row], PERIOD, metric, AS_OF);
  var preview = sandbox.perfPreviewStatus({
    goalKind: goal.goalKind,
    target: goal.target,
    baseline: goal.baseline,
    direction: metric.direction,
    onTrackPace: goal.onTrackPace,
    atRiskPace: goal.atRiskPace,
    elapsed: goal.goalKind === 'journey' ? L.journeyElapsed(goal, AS_OF) : 1
  }, value);
  if (engine.status !== preview) {
    mismatches.push(testCase.group.name + ' at ' + value + ': engine says ' + engine.status + ', browser says ' + preview);
  }
});

check('the browser and the engine agree on all ' + CASES.length + ' cases', mismatches.length === 0, mismatches.join(' | '));

/* The browser must not have quietly grown a second copy of the whole engine. */
['Not reported', 'Insufficient data', 'Not yet measured', 'trendOf', 'liveActual'].forEach(function (forbidden) {
  check('the preview block does not reimplement "' + forbidden + '"', block.indexOf(forbidden) === -1);
});

console.log('\n----------------------------------------');
console.log('PASSED ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('The browser preview matches the engine.');
