'use strict';
/**
 * Regression for the "(undefined of undefined)" defect found in the live gate.
 *
 * The goal-detail history and the correction dialog append a "(x of y)" suffix
 * to a reported number. Only a percentage carries a numerator and denominator;
 * a count, a journey and an average are a single value. The old guard was
 * `entry.numerator !== null`, but on a count those parts read back as
 * `undefined`, and `undefined !== null` is true, so the screen printed
 * "38 (undefined of undefined)". The suffix must key off the metric type.
 *
 * This lifts perfHasParts_ straight out of PerformanceUi.html so the rule is
 * pinned where it lives, and asserts the fragile guard has not crept back.
 */
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
var source = fs.readFileSync(path.join(ROOT, 'app', 'PerformanceUi.html'), 'utf8');

var pass = 0, fail = 0, failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

console.log('\nGoal history number parts');

var match = source.match(/function perfHasParts_[\s\S]*?\n}/);
check('perfHasParts_ is defined in PerformanceUi.html', !!match);
if (!match) { console.log('\nFAILURES:\n  - perfHasParts_ could not be found'); process.exit(1); }

var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(match[0] + '\nthis.perfHasParts_ = perfHasParts_;', sandbox, { filename: 'perfHasParts.js' });
var perfHasParts_ = sandbox.perfHasParts_;

/* The kinds that broke: a single value with no parts must never show "(x of y)". */
check('count with undefined parts shows no parts', perfHasParts_({ metricType: 'count' }, { value: 38 }) === false);
check('count with empty-string parts shows no parts', perfHasParts_({ metricType: 'count' }, { value: 38, numerator: '', denominator: '' }) === false);
check('count with null parts shows no parts', perfHasParts_({ metricType: 'count' }, { value: 25, numerator: null, denominator: null }) === false);
check('average shows no parts', perfHasParts_({ metricType: 'average' }, { value: 9.8 }) === false);
check('journey value shows no parts', perfHasParts_({ metricType: 'count', direction: 'lower' }, { value: 11.4 }) === false);

/* A percentage with real parts still shows them; a percentage missing its parts
   must not print "undefined of undefined" either. */
check('percentage with parts shows them', perfHasParts_({ metricType: 'percentage' }, { value: 66.7, numerator: 34, denominator: 51 }) === true);
check('percentage with a zero numerator still shows parts', perfHasParts_({ metricType: 'percentage' }, { value: 0, numerator: 0, denominator: 51 }) === true);
check('percentage without parts shows nothing', perfHasParts_({ metricType: 'percentage' }, { value: 66.7 }) === false);

/* The fragile guard that shipped the bug must be gone from the file entirely. */
check('the "entry.numerator !== null" guard is gone', source.indexOf('entry.numerator !== null') === -1);

console.log('\n----------------------------------------');
console.log('PASSED ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('Number parts only render for percentages.');
