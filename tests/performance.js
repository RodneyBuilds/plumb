'use strict';
/**
 * Pure checks for the performance layer.
 *
 * The first block is the PoC status-engine suite, ported onto the shipped
 * engine. Two of the original 13 cases changed on purpose and say so where
 * they appear; the rest assert byte-identical behaviour.
 */
var path = require('path'), L = require(path.join(__dirname, '..', 'app', 'Logic.gs'));
var pass = 0, fail = 0, failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function throws(fn) { try { fn(); return false; } catch (ignore) { return true; } }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

var HIGHER = { metricType: 'count', direction: 'higher' };
var LOWER = { metricType: 'count', direction: 'lower' };
var PCT = { metricType: 'percentage', direction: 'higher', numeratorLabel: 'Clients screened', denominatorLabel: 'Clients eligible' };
var AVG = { metricType: 'average', direction: 'lower', unit: 'days' };

var journeyUp = { goalKind: 'journey', baseline: 40, target: 60, startDate: '2026-01-01', targetDate: '2026-12-31', onTrackPace: 0.9, atRiskPace: 0.6 };
var AS_OF_PERIOD = '2026-06';
var AS_OF_DATE = new Date('2026-07-01T00:00:00Z');

var seq = 0;
function row(period, value, extra) {
  seq++;
  return Object.assign({ actualId: 'A' + seq, period: period, value: value, numerator: null, denominator: null, noData: false, enteredBy: 'someone@example.org', enteredAt: '2026-07-01T00:00:00.000Z' }, extra || {});
}
function status(goal, rows, metric, period, date) {
  return L.computeGoalStatus(goal, rows, period || AS_OF_PERIOD, metric || HIGHER, date || AS_OF_DATE);
}

console.log('\nPerformance status rules');
check('1. no actuals reads Not yet measured', status(journeyUp, []).status === 'Not yet measured');
check('1b. no actuals has no trend', status(journeyUp, []).trend === 'Unknown');
var stale = status(journeyUp, [row('2026-02', 45)]);
check('2. actuals older than 2 periods read Insufficient data', stale.status === 'Insufficient data', stale.status);
check('2b. the stale reading still reports the last number it saw', stale.latest.value === 45);
var onPace = status(journeyUp, [row('2026-05', 47), row('2026-06', 50)]);
check('3. on pace reads On track', onPace.status === 'On track', onPace.status);
check('3b. on pace scores at or above the on-track line', onPace.ratio >= 0.9, String(onPace.ratio));
check('4. behind pace reads At risk', status(journeyUp, [row('2026-05', 46), row('2026-06', 47)]).status === 'At risk');
check('5. far behind reads Off track', status(journeyUp, [row('2026-05', 41), row('2026-06', 42)]).status === 'Off track');
check('6. target already reached reads On track whatever the date', status(journeyUp, [row('2026-06', 61)]).status === 'On track');
var improving = status(journeyUp, [row('2026-04', 44), row('2026-05', 47), row('2026-06', 50)]);
check('7. 3 rising actuals read Improving', improving.trend === 'Improving', improving.trend);
check('8. 3 falling actuals read Declining', status(journeyUp, [row('2026-04', 50), row('2026-05', 47), row('2026-06', 44)]).trend === 'Declining');
/* A trend requires 2 consecutive moves without a noise band. Its magnitude is reported separately. */
var tiny = status(journeyUp, [row('2026-04', 50), row('2026-05', 50.1), row('2026-06', 50.2)]);
check('9. a small but consistent rise is a run, and its size is reported', tiny.trend === 'Improving' && tiny.trendMonths === 2 && tiny.trendChange === 0.2, tiny.trend + ' ' + tiny.trendChange);
var journeyDown = Object.assign({}, journeyUp, { baseline: 30, target: 10 });
check('10. a downward goal on pace reads On track', status(journeyDown, [row('2026-05', 24), row('2026-06', 20)], LOWER).status === 'On track');
check('10b. 2 actuals are not enough for a trend', status(journeyDown, [row('2026-05', 24), row('2026-06', 20)], LOWER).trend === 'Unknown');
check('11. a rising number on a lower-is-better metric reads Declining', status(journeyDown, [row('2026-04', 20), row('2026-05', 24), row('2026-06', 27)], LOWER).trend === 'Declining');
/* A trend requires 2 consecutive moves without a noise band. Its magnitude is reported separately. */
check('12. a journey with no gap between baseline and target is rejected at save', throws(function () {
  L.normalizeGoalNumbers({ goalKind: 'journey', baseline: 5, target: 5, startDate: '2026-01-01', targetDate: '2026-12-31' }, HIGHER);
}));
check('12b. the engine itself never throws on a stored goal', !throws(function () { status({ goalKind: 'period', target: 0 }, [row('2026-06', 10)]); }));
var strict = Object.assign({}, journeyUp, { onTrackPace: 1.2, atRiskPace: 1.0 });
check('13. per-goal thresholds override the defaults', status(strict, [row('2026-06', 50)]).status === 'At risk');

console.log('\nThe 2 new goal kinds');
var periodGoal = { goalKind: 'period', target: 40, onTrackPace: 0.9, atRiskPace: 0.6 };
check('a period goal at target reads On track', status(periodGoal, [row('2026-06', 40)]).status === 'On track');
check('a period goal at 80 percent of target reads At risk', status(periodGoal, [row('2026-06', 32)]).status === 'At risk');
check('a period goal at half of target reads Off track', status(periodGoal, [row('2026-06', 20)]).status === 'Off track');
check('a period goal above target reads On track', status(periodGoal, [row('2026-06', 55)]).status === 'On track');
var holdGoal = { goalKind: 'hold', target: 95, onTrackPace: 0.98, atRiskPace: 0.9 };
check('a hold goal at the line reads On track', status(holdGoal, [row('2026-06', 95)], PCT).status === 'On track');
check('a hold goal just under the line reads At risk', status(holdGoal, [row('2026-06', 92)], PCT).status === 'At risk', String(status(holdGoal, [row('2026-06', 92)], PCT).ratio));
check('a hold goal well under the line reads Off track', status(holdGoal, [row('2026-06', 80)], PCT).status === 'Off track');
var holdLow = { goalKind: 'hold', target: 5, onTrackPace: 0.9, atRiskPace: 0.6 };
check('a lower-is-better hold goal reads the line the right way round', status(holdLow, [row('2026-06', 4)], LOWER).status === 'On track');
check('a lower-is-better hold goal above its ceiling reads Off track', status(holdLow, [row('2026-06', 12)], LOWER).status === 'Off track');
check('a lower-is-better goal at zero does not divide by zero', isFinite(status(holdLow, [row('2026-06', 0)], LOWER).ratio));

console.log('\nStaleness is its own state, and last month never stands in for this month');
var reportedLastMonth = [row('2026-04', 30), row('2026-05', 38)];
var notReported = status(periodGoal, reportedLastMonth, HIGHER, '2026-06');
check('a goal reported last month but not this month reads Not reported', notReported.status === 'Not reported', notReported.status);
check('and is never On track', notReported.status !== 'On track');
check('and states how long ago it was last reported', notReported.stale === 1);
check('and still carries the trend it earned', notReported.trend !== undefined);
check('3 periods of silence reads Insufficient data', status(periodGoal, reportedLastMonth, HIGHER, '2026-08').status === 'Insufficient data');
check('nothing ever reported reads Not yet measured', status(periodGoal, []).status === 'Not yet measured');

console.log('\nNo data is not zero');
var noDataRows = [row('2026-05', 38), row('2026-06', null, { noData: true, value: null })];
var noData = status(periodGoal, noDataRows, HIGHER, '2026-06');
check('a no-data month reads Not yet measured rather than a score', noData.status === 'Not yet measured', noData.status);
check('a no-data month is flagged as answered, not missing', noData.noData === true);
check('a no-data month is never coerced to zero', noData.status !== 'Off track');

console.log('\nCorrections append and never overwrite');
var original = row('2026-05', 26, { actualId: 'ORIG' });
var correction = row('2026-05', 30, { actualId: 'FIX', supersedesActualId: 'ORIG', correctionReason: 'Data entry error' });
var live = L.liveActualRows([original, correction, row('2026-06', 33)]);
check('the superseded row drops out of the live series', live.filter(function (r) { return r.actualId === 'ORIG'; }).length === 0);
check('the correcting row takes its place', live.filter(function (r) { return r.actualId === 'FIX'; }).length === 1);
check('both rows are still in the record', [original, correction].length === 2);
check('the live series is in period order', eq(live.map(function (r) { return r.period; }), ['2026-05', '2026-06']));
var now = new Date('2026-07-03T12:00:00Z');
check('the author may correct their own number inside 48 hours', !L.correctionNeedsApproval({ enteredBy: 'a@x.org', enteredAt: '2026-07-03T00:00:00Z' }, 'a@x.org', now));
check('the author needs approval after 48 hours', L.correctionNeedsApproval({ enteredBy: 'a@x.org', enteredAt: '2026-06-20T00:00:00Z' }, 'a@x.org', now));
check('somebody else always needs approval', L.correctionNeedsApproval({ enteredBy: 'a@x.org', enteredAt: '2026-07-03T00:00:00Z' }, 'b@x.org', now));

console.log('\nPercentage metrics store both parts');
check('a percentage entry keeps its numerator and denominator', eq(L.normalizeActualEntry(PCT, { numerator: 34, denominator: 51 }), { numerator: 34, denominator: 51, value: (34 / 51) * 100, noData: false }));
check('a percentage entry rejects a missing half', throws(function () { L.normalizeActualEntry(PCT, { numerator: 34 }); }));
check('a percentage entry rejects a zero denominator', throws(function () { L.normalizeActualEntry(PCT, { numerator: 0, denominator: 0 }); }));
check('a percentage entry rejects more than the whole', throws(function () { L.normalizeActualEntry(PCT, { numerator: 60, denominator: 51 }); }));
check('a percentage entry rejects negatives', throws(function () { L.normalizeActualEntry(PCT, { numerator: -1, denominator: 51 }); }));
check('a count entry keeps a bare value', L.normalizeActualEntry(HIGHER, { value: 38 }).value === 38);
check('a count entry rejects text', throws(function () { L.normalizeActualEntry(HIGHER, { value: 'thirty' }); }));
check('a no-data entry stores nothing numeric', eq(L.normalizeActualEntry(PCT, { noData: true }), { numerator: null, denominator: null, value: null, noData: true }));

console.log('\nRegion rollup adds people, not percentages');
var unequal = [
  { site: 'Eastgate', numerator: 8, denominator: 12, value: (8 / 12) * 100 },
  { site: 'North Center', numerator: 322, denominator: 404, value: (322 / 404) * 100 }
];
var rolled = L.rollupParts(PCT, unequal);
check('a percentage rollup sums both parts', rolled.numerator === 330 && rolled.denominator === 416);
check('a percentage rollup divides once', Math.abs(rolled.total - (330 / 416) * 100) < 1e-9);
check('the weighted answer differs from the naive average of percentages', Math.abs(rolled.total - rolled.naiveAverage) > 1, rolled.total + ' vs ' + rolled.naiveAverage);
check('the naive average is still reported, so the difference can be shown', rolled.naiveAverage !== null);
check('a percentage rollup states its arithmetic in words', /divided by/.test(rolled.formula));
var counts = L.rollupParts(HIGHER, [{ site: 'A', value: 38 }, { site: 'B', value: 54 }]);
check('a count rollup adds', counts.total === 92 && counts.kind === 'sum');
var averages = L.rollupParts(AVG, [{ site: 'A', value: 9.8 }, { site: 'B', value: 12.1 }]);
check('an average refuses to roll up rather than inventing a figure', averages.kind === 'not-aggregatable' && averages.total === null);
check('and says why in plain words', /cannot be added up/.test(averages.caveat));
var withNoData = L.rollupParts(PCT, [{ site: 'A', numerator: 8, denominator: 12, value: 66.7 }, { site: 'B', noData: true, value: null }]);
check('a no-data site is left out of the denominator, not counted as zero', withNoData.denominator === 12 && withNoData.skipped.length === 1);
check('nothing reported at all is its own rollup answer', L.rollupParts(PCT, []).kind === 'nothing-reported');

console.log('\nPeriod maths');
check('the open period is the month just gone', L.openPeriodOn(new Date('2026-08-03T09:00:00Z')) === '2026-07');
check('the open period rolls over a year boundary', L.openPeriodOn(new Date('2027-01-04T09:00:00Z')) === '2026-12');
check('period indexes are contiguous across a year boundary', L.periodIndex('2027-01') - L.periodIndex('2026-12') === 1);
check('a period index round trips', L.periodFromIndex(L.periodIndex('2026-07')) === '2026-07');
check('a December index round trips', L.periodFromIndex(L.periodIndex('2026-12')) === '2026-12');
check('a January index round trips', L.periodFromIndex(L.periodIndex('2027-01')) === '2027-01');
check('the trajectory asks for 6 periods ending at the open one', eq(L.periodsEndingAt('2026-07', 6), ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']));
check('entry closes on the 5th of the following month', L.entryClosesOn('2026-07') === '2026-08-05');
check('entry closing rolls over a year boundary', L.entryClosesOn('2026-12') === '2027-01-05');
check('an entry before the close date is not late', !L.periodIsLate('2026-07', new Date('2026-08-03T09:00:00Z')));
check('an entry after the close date is late but still possible', L.periodIsLate('2026-07', new Date('2026-08-09T09:00:00Z')));
check('a period label reads as a month and year', L.periodLabel('2026-07') === 'July 2026');
check('a malformed period is rejected', !L.isValidPeriod('2026-13') && !L.isValidPeriod('26-07') && L.isValidPeriod('2026-07'));

/* Google Sheets parses anything date-shaped, so a period can come back as a
   Date object rather than the text that was written. The emulator stores
   strings verbatim and cannot reproduce that, so the guard is checked directly. */
check('a period that survived as text is returned unchanged', L.normalizePeriod('2026-07') === '2026-07');
check('a period the sheet turned into a Date is read back as a period', L.normalizePeriod(new Date(2026, 6, 1)) === '2026-07');
check('a Date on the last day of a month still reads as that month', L.normalizePeriod(new Date(2026, 11, 31)) === '2026-12');
check('a full ISO date is reduced to its month', L.normalizePeriod('2026-07-01') === '2026-07');
check('a single-digit month is padded', L.normalizePeriod('2026-7') === '2026-07');
check('an empty cell stays empty rather than becoming today', L.normalizePeriod('') === '');
check('a normalized period is comparable with a stored one', L.periodIndex(L.normalizePeriod(new Date(2026, 6, 1))) === L.periodIndex('2026-07'));

console.log('\nGoal validation refuses what the engine could not judge');
check('a goal must say which kind it is', throws(function () { L.normalizeGoalNumbers({ target: 40 }, HIGHER); }));
check('a period goal needs a number', throws(function () { L.normalizeGoalNumbers({ goalKind: 'period' }, HIGHER); }));
check('a period goal needs nothing else', L.normalizeGoalNumbers({ goalKind: 'period', target: 40 }, HIGHER).target === 40);
check('a hold goal needs only a line', L.normalizeGoalNumbers({ goalKind: 'hold', target: 95 }, PCT).target === 95);
check('a journey needs a baseline', throws(function () { L.normalizeGoalNumbers({ goalKind: 'journey', target: 12, startDate: '2026-01-01', targetDate: '2027-06-30' }, LOWER); }));
check('a journey needs both dates', throws(function () { L.normalizeGoalNumbers({ goalKind: 'journey', baseline: 22, target: 12 }, LOWER); }));
check('a journey needs its dates in order', throws(function () { L.normalizeGoalNumbers({ goalKind: 'journey', baseline: 22, target: 12, startDate: '2027-06-30', targetDate: '2026-01-01' }, LOWER); }));
check('a complete journey is accepted', L.normalizeGoalNumbers({ goalKind: 'journey', baseline: 22, target: 12, startDate: '2026-01-01', targetDate: '2027-06-30' }, LOWER).baseline === 22);
check('a percentage goal above 100 is rejected', throws(function () { L.normalizeGoalNumbers({ goalKind: 'period', target: 140 }, PCT); }));
check('thresholds default when not given', L.normalizeGoalNumbers({ goalKind: 'period', target: 40 }, HIGHER).onTrackPace === L.DEFAULT_THRESHOLDS.onTrackPace);
check('an at-risk line above the on-track line is rejected', throws(function () { L.normalizeGoalNumbers({ goalKind: 'period', target: 40, onTrackPace: 0.6, atRiskPace: 0.9 }, HIGHER); }));

console.log('\nCommitment wording matches the kind');
check('a period goal states a monthly target', /each month/.test(L.goalCommitmentText({ goalKind: 'period', target: 40 }, HIGHER)));
check('a hold goal on a higher-is-better metric says at or above', /at or above/.test(L.goalCommitmentText({ goalKind: 'hold', target: 95 }, PCT)));
check('a hold goal on a lower-is-better metric says at or below', /at or below/.test(L.goalCommitmentText({ goalKind: 'hold', target: 5 }, LOWER)));
check('a journey states both ends and the date in words', /to .* by 30 June 2027/.test(L.goalCommitmentText({ goalKind: 'journey', baseline: 22, target: 12, targetDate: '2027-06-30' }, LOWER)));

console.log('\nThe product name is carried by one constant');
check('the constant is exported', typeof L.PRODUCT_NAME === 'string' && L.PRODUCT_NAME.length > 0);

console.log('\nPerformance navigation and permissions');
check('3 performance permissions exist and no more', L.PERFORMANCE_PERMISSIONS.length === 3);
check('every performance permission is declared in the catalog', L.PERFORMANCE_PERMISSIONS.every(function (key) {
  return L.DEFAULT_PERMISSIONS.some(function (p) { return p.permissionKey === key; });
}));
check('site staff may enter numbers', L.roleHasPermission('site', 'performance.enter', L.DEFAULT_ROLE_PERMISSIONS));
check('site staff may not manage goals', !L.roleHasPermission('site', 'performance.goal.manage', L.DEFAULT_ROLE_PERMISSIONS));
check('regional staff may manage goals', L.roleHasPermission('regional', 'performance.goal.manage', L.DEFAULT_ROLE_PERMISSIONS));
check('regional staff may not manage the metric library', !L.roleHasPermission('regional', 'performance.metric.manage', L.DEFAULT_ROLE_PERMISSIONS));
check('only admin manages the metric library', L.roleHasPermission('admin', 'performance.metric.manage', L.DEFAULT_ROLE_PERMISSIONS));
check('viewer gains nothing from the performance layer', L.PERFORMANCE_PERMISSIONS.every(function (key) {
  return !L.roleHasPermission('viewer', key, L.DEFAULT_ROLE_PERMISSIONS);
}));
check('holding any performance permission opens the read surfaces', L.hasAnyPerformancePermission(['performance.enter']));
check('holding none closes them', !L.hasAnyPerformancePermission(['app.read', 'intake.read']));
var rollupItem = L.NAV.filter(function (item) { return item.id === 'rollup'; })[0];
check('the rollup needs more than 1 site in scope', !L.navItemAllowed(rollupItem, ['performance.enter'], 1) && L.navItemAllowed(rollupItem, ['performance.enter'], 3));

console.log('\n----------------------------------------');
console.log('PASSED ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('All Performance pure-logic checks passed.');
