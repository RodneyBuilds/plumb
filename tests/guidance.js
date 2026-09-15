'use strict';
/**
 * The format contract, proved against fixtures.
 *
 * The application contract lets people maintain the manual in Google Docs, which means the
 * app depends on formatting a human controls. Every way that can go wrong is a
 * fixture here, and every one of them asserts the same thing twice: the broken
 * section is reported, and the good sections still parse. One bad heading is
 * never allowed to cost a site its guidance.
 */
var L = require('../app/Logic.gs');

var pass = 0, fail = 0, failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

/* ---------- the fixture organization ---------- */

var METRICS = [
  { metricId: 'm-followup', name: 'Follow-up within 30 days' },
  { metricId: 'm-screen', name: 'Clients screened for housing need' },
  { metricId: 'm-noshow', name: 'No-show rate' }
];
var UNITS = [
  { unitId: 'ORG-ROOT', unitType: 'organization', name: 'Organization' },
  { unitId: 'REG-CENTRAL', unitType: 'region', name: 'Central region' },
  { unitId: 'SITE-RIVERSIDE', unitType: 'site', name: 'Riverside', parentUnitId: 'REG-CENTRAL' },
  { unitId: 'SITE-EASTGATE', unitType: 'site', name: 'Eastgate', parentUnitId: 'REG-CENTRAL' },
  { unitId: 'DEPT-RIVERSIDE-INTAKE', unitType: 'department', name: 'Riverside intake', parentUnitId: 'SITE-RIVERSIDE' }
];
var INDEX = L.guidanceIndex(METRICS, UNITS, 'ORG-ROOT');

function h2(text) { return { kind: 'heading2', text: text }; }
function h3(text) { return { kind: 'heading3', text: text }; }
function body(text) { return { kind: 'body', text: text }; }

/* A clean manual: 2 metrics at the organization, 1 site override. */
function cleanDoc() {
  return [
    h2('Content'),
    h2('Metric: Follow-up within 30 days'),
    h3('On track, sustain'),
    body('Keep the weekly follow-up huddle on Monday.'),
    body('Every discharged client gets a follow-up task the day they leave.'),
    h3('At risk, recover'),
    body('Pull the 30-day follow-up list on Monday morning.'),
    body('Assign each un-contacted client to a named staff member.'),
    h3('Off track, urgent'),
    body('Treat follow-up as this week\'s priority.'),
    body('The site lead runs a daily 15-minute follow-up standup until the number recovers.'),
    h2('Metric: Follow-up within 30 days (Site: Riverside)'),
    h3('Off track, urgent'),
    body('Use the shared follow-up sheet Marcus keeps.'),
    body('The Tuesday and Thursday evening call windows reach the most clients.'),
    h2('Metric: No-show rate'),
    h3('On track, sustain'),
    body('Keep the reminder texts going 48 hours and 2 hours before each appointment.'),
    h3('Off track, urgent'),
    body('Move to confirmed booking: no appointment holds without a reply to the reminder.')
  ];
}
function parse(lines) { return L.parseGuidanceLines(lines, INDEX, 'doc-1'); }
function blockFor(result, metricId, situation, scopeUnitId) {
  return result.blocks.filter(function (block) {
    return block.metricId === metricId && block.situation === situation
      && (!scopeUnitId || block.scopeUnitId === scopeUnitId);
  })[0] || null;
}
function kinds(result) { return result.problems.map(function (problem) { return problem.kind; }); }

/* ============================ a clean manual ============================ */

console.log('\nA clean manual');
var clean = parse(cleanDoc());
check('every section parses', clean.blocks.length === 6, String(clean.blocks.length));
check('and nothing is flagged', clean.problems.length === 0, JSON.stringify(clean.problems));
check('a section with no scope suffix is organization guidance',
  blockFor(clean, 'm-followup', 'urgent', 'ORG-ROOT') !== null);
check('a scope suffix binds the block to that unit',
  blockFor(clean, 'm-followup', 'urgent', 'SITE-RIVERSIDE') !== null);
check('steps keep the order they were written in',
  blockFor(clean, 'm-followup', 'sustain').steps[0] === 'Keep the weekly follow-up huddle on Monday.');
check('steps are the exact maintained text, unchanged',
  blockFor(clean, 'm-followup', 'urgent', 'ORG-ROOT').steps[1]
  === 'The site lead runs a daily 15-minute follow-up standup until the number recovers.');
check('the source heading is recorded so an alert can name it',
  /Follow-up within 30 days \/ Off track, urgent/.test(blockFor(clean, 'm-followup', 'urgent', 'ORG-ROOT').sourceHeading));
check('the block id is deterministic, so a re-parse updates rather than duplicates',
  blockFor(clean, 'm-followup', 'urgent', 'ORG-ROOT').blockId
  === L.guidanceBlockId('ORG-ROOT', 'm-followup', 'urgent'));
check('re-parsing the same manual gives byte-identical blocks',
  JSON.stringify(parse(cleanDoc()).blocks) === JSON.stringify(clean.blocks));

/* ============================ heading tolerance ============================ */

console.log('\nSituation headings, matched through the fixed table and nothing else');
check('the full label matches', L.matchSituationHeading('Off track, urgent') === 'urgent');
check('the short label matches', L.matchSituationHeading('Off track') === 'urgent');
check('the bare word matches', L.matchSituationHeading('urgent') === 'urgent');
check('case does not matter', L.matchSituationHeading('AT RISK, RECOVER') === 'recover');
check('extra whitespace does not matter', L.matchSituationHeading('  On   track,  sustain  ') === 'sustain');
check('a trailing colon does not matter', L.matchSituationHeading('Sustain:') === 'sustain');
check('a label outside the table is not silently accepted', L.matchSituationHeading('When it is going badly') === null);
check('a near miss is not accepted either', L.matchSituationHeading('Off the track') === null);

/* ============================ each way a manual breaks ============================ */

console.log('\nA renamed metric heading');
var renamed = cleanDoc();
renamed[1] = h2('Metric: Follow-up in 30 days');
var renamedResult = parse(renamed);
check('the renamed section is flagged by name', kinds(renamedResult).indexOf('unknown-metric') !== -1, JSON.stringify(renamedResult.problems));
check('the problem names what was written, so it can be fixed',
  renamedResult.problems[0].detail === 'Follow-up in 30 days');
check('its 3 blocks are not served', blockFor(renamedResult, 'm-followup', 'urgent', 'ORG-ROOT') === null);
check('every other section still parses', renamedResult.blocks.length === 3, String(renamedResult.blocks.length));
check('including the site override for the same metric',
  blockFor(renamedResult, 'm-followup', 'urgent', 'SITE-RIVERSIDE') !== null);

console.log('\nA removed situation heading');
var removed = cleanDoc().filter(function (line, i) { return i !== 8; });   // drops "Off track, urgent"
var removedResult = parse(removed);
check('the surviving sections still parse', removedResult.blocks.length === 5, String(removedResult.blocks.length));
check('the removed one is simply absent rather than served empty',
  blockFor(removedResult, 'm-followup', 'urgent', 'ORG-ROOT') === null);
/* Deleting a heading leaves its steps behind, and they fall under the heading
   above it. Nothing in the Doc marks that, so the parse cannot see it. What
   stops it reaching a site is playbookStoreBlocks_, which refuses to half-update
   a section that reported a problem: the whole section keeps its last good
   content until somebody fixes the Doc. */
check('the orphaned steps do land under the heading above, which is why a broken section is never half-updated',
  blockFor(removedResult, 'm-followup', 'recover').steps.length === 4);
/* What the GuidanceBlocks tab holds after a clean parse, shaped the way the
   sheet actually stores it. */
var served = clean.blocks.map(function (block) {
  return { blockId: block.blockId, metricId: block.metricId, scopeUnitId: block.scopeUnitId, situation: block.situation, sourceHeading: block.sourceHeading };
});
var missing = L.missingGuidanceBlocks(served, removedResult.blocks);
check('and the diff against what was being served names it',
  missing.length === 1 && missing[0].blockId === L.guidanceBlockId('ORG-ROOT', 'm-followup', 'urgent'),
  JSON.stringify(missing));

console.log('\nA situation heading renamed to something the app does not know');
var relabelled = cleanDoc();
relabelled[5] = h3('When it starts slipping');
var relabelledResult = parse(relabelled);
check('it is reported as not naming a situation, not as a formatting problem',
  kinds(relabelledResult).indexOf('unknown-situation') !== -1 && kinds(relabelledResult).indexOf('not-a-heading') === -1,
  JSON.stringify(relabelledResult.problems));
check('the problem quotes what was written', relabelledResult.problems[0].heading === 'When it starts slipping');
check('and names the section it is in', relabelledResult.problems[0].detail === 'Metric: Follow-up within 30 days');
check('the steps under it are not served under the heading above',
  blockFor(relabelledResult, 'm-followup', 'sustain').steps.length === 2);
check('every other section still parses', relabelledResult.blocks.length === 5);
check('one human error is reported once, not once per block it cost',
  L.guidanceMissingProblems(served, relabelledResult).length === 0, JSON.stringify(L.guidanceMissingProblems(served, relabelledResult)));

console.log('\nOne mistake is reported once');
check('a section that lost a situation cleanly is reported',
  L.guidanceMissingProblems(served, removedResult).length === 1);
check('and it is named as a missing situation',
  L.guidanceMissingProblems(served, removedResult)[0].kind === 'missing-situation');
check('a whole section that stopped parsing is not reported block by block',
  L.guidanceMissingProblems(served, renamedResult).length === 0, JSON.stringify(L.guidanceMissingProblems(served, renamedResult)));
check('so a renamed metric heading is 1 problem, not 4',
  renamedResult.problems.length + L.guidanceMissingProblems(served, renamedResult).length === 1);

console.log('\nA heading demoted to ordinary text');
var demoted = cleanDoc();
demoted[8] = body('Off track, urgent');
var demotedResult = parse(demoted);
check('it is called out as not a heading', kinds(demotedResult).indexOf('not-a-heading') !== -1, JSON.stringify(demotedResult.problems));
check('the steps under it are not served as part of the section above',
  blockFor(demotedResult, 'm-followup', 'recover').steps.length === 2);
check('every other section still parses', demotedResult.blocks.length === 5, String(demotedResult.blocks.length));

console.log('\nA duplicate section');
var duplicated = cleanDoc().concat([
  h2('Metric: No-show rate'),
  h3('On track, sustain'),
  body('A second copy somebody pasted in.')
]);
var duplicatedResult = parse(duplicated);
check('the duplicate is flagged', kinds(duplicatedResult).indexOf('duplicate') !== -1, JSON.stringify(duplicatedResult.problems));
check('the first one wins', blockFor(duplicatedResult, 'm-noshow', 'sustain').steps[0]
  === 'Keep the reminder texts going 48 hours and 2 hours before each appointment.');
check('and nothing is dropped because of it', duplicatedResult.blocks.length === 6);

console.log('\nSteps written above any situation heading');
var orphan = cleanDoc();
orphan.splice(2, 0, body('This is general advice somebody typed under the metric.'));
var orphanResult = parse(orphan);
check('the orphan steps are flagged', kinds(orphanResult).indexOf('orphan-steps') !== -1, JSON.stringify(orphanResult.problems));
check('they are not served as guidance', orphanResult.blocks.every(function (block) {
  return block.steps.indexOf('This is general advice somebody typed under the metric.') === -1;
}));
check('the sections themselves still parse', orphanResult.blocks.length === 6);
check('and it is reported once, not once per line', kinds(orphanResult).filter(function (kind) { return kind === 'orphan-steps'; }).length === 1);

console.log('\nA scope suffix naming a place that does not exist');
var badScope = cleanDoc();
badScope[11] = h2('Metric: Follow-up within 30 days (Site: Rivervside)');
var badScopeResult = parse(badScope);
check('the unknown place is flagged', kinds(badScopeResult).indexOf('unknown-scope') !== -1, JSON.stringify(badScopeResult.problems));
check('and names what was written', badScopeResult.problems[0].detail === 'Site: Rivervside');
check('the organization guidance for that metric is untouched',
  blockFor(badScopeResult, 'm-followup', 'urgent', 'ORG-ROOT').steps.length === 2);

console.log('\nA situation heading with every step deleted');
var emptied = cleanDoc().filter(function (line, i) { return i !== 9 && i !== 10; });  // the 2 urgent steps
var emptiedResult = parse(emptied);
check('no block is served for it', blockFor(emptiedResult, 'm-followup', 'urgent', 'ORG-ROOT') === null);
check('so the app never shows an empty list of steps', emptiedResult.blocks.every(function (block) { return block.steps.length > 0; }));
check('and the diff reports it exactly like a removed heading',
  L.missingGuidanceBlocks(served, emptiedResult.blocks).length === 1);

console.log('\nA metric name that contains brackets of its own');
var bracketIndex = L.guidanceIndex(METRICS.concat([{ metricId: 'm-days', name: 'Days to first appointment (mean)' }]), UNITS, 'ORG-ROOT');
var bracket = L.parseGuidanceLines([
  h2('Metric: Days to first appointment (mean)'),
  h3('At risk, recover'),
  body('Review the booking queue every Monday.')
], bracketIndex, 'doc-1');
check('the brackets are read as part of the name, not as a scope', bracket.blocks.length === 1 && bracket.problems.length === 0, JSON.stringify(bracket.problems));
check('and it lands at the organization', bracket.blocks[0].scopeUnitId === 'ORG-ROOT');

/* ============================ resolution ============================ */

console.log('\nResolution, most specific wins and the organization still shows');

var ROWS = clean.blocks.map(function (block) {
  return { blockId: block.blockId, scopeUnitId: block.scopeUnitId, scopeType: block.scopeType, metricId: block.metricId, situation: block.situation, steps: block.steps };
});
var RIVERSIDE = [
  { unitId: 'SITE-RIVERSIDE', unitType: 'site', name: 'Riverside' },
  { unitId: 'REG-CENTRAL', unitType: 'region', name: 'Central region' },
  { unitId: 'ORG-ROOT', unitType: 'organization', name: 'Organization' }
];
var EASTGATE = [
  { unitId: 'SITE-EASTGATE', unitType: 'site', name: 'Eastgate' },
  { unitId: 'REG-CENTRAL', unitType: 'region', name: 'Central region' },
  { unitId: 'ORG-ROOT', unitType: 'organization', name: 'Organization' }
];

var atRiverside = L.resolveGuidanceBlocks(ROWS, RIVERSIDE, 'm-followup', 'urgent');
check('the site override and the organization block both show', atRiverside.blocks.length === 2, String(atRiverside.blocks.length));
check('the organization block is read first', atRiverside.blocks[0].unitType === 'organization');
check('the local block is read second, labelled with its place', atRiverside.blocks[1].unitName === 'Riverside');
check('the most specific block is the winner', atRiverside.winner.row.scopeUnitId === 'SITE-RIVERSIDE');

var atEastgate = L.resolveGuidanceBlocks(ROWS, EASTGATE, 'm-followup', 'urgent');
check('a site with no override sees only the organization block', atEastgate.blocks.length === 1);
check('and it is the organization one', atEastgate.blocks[0].row.scopeUnitId === 'ORG-ROOT');
check('the winner there is the organization block', atEastgate.winner.row.scopeUnitId === 'ORG-ROOT');

console.log('\nDepartment is designed in and behaves');
var DEPT_ROWS = ROWS.concat([{
  blockId: L.guidanceBlockId('DEPT-RIVERSIDE-INTAKE', 'm-followup', 'urgent'),
  scopeUnitId: 'DEPT-RIVERSIDE-INTAKE', scopeType: 'department', metricId: 'm-followup', situation: 'urgent',
  steps: ['The intake team checks phone numbers at the door.']
}]);
var INTAKE_DEPT = [{ unitId: 'DEPT-RIVERSIDE-INTAKE', unitType: 'department', name: 'Riverside intake' }].concat(RIVERSIDE);
var atDept = L.resolveGuidanceBlocks(DEPT_ROWS, INTAKE_DEPT, 'm-followup', 'urgent');
check('a department block wins over the site block', atDept.winner.row.scopeUnitId === 'DEPT-RIVERSIDE-INTAKE');
check('and every level above it still layers underneath', atDept.blocks.length === 3);
check('read from the organization down to the department',
  atDept.blocks.map(function (entry) { return entry.unitType; }).join(',') === 'organization,site,department');
var deptIgnored = L.resolveGuidanceBlocks(DEPT_ROWS, RIVERSIDE, 'm-followup', 'urgent');
check('a department block is ignored where no department is set', deptIgnored.blocks.length === 2);

console.log('\nThe honest empty state');
var noBlock = L.resolveGuidanceBlocks(ROWS, RIVERSIDE, 'm-screen', 'recover');
check('a metric with no block for its situation resolves to nothing', noBlock.missing === true && noBlock.blocks.length === 0);
check('and offers no winner to pre-fill an action from', noBlock.winner === null);
var noSituation = L.resolveGuidanceBlocks(ROWS, RIVERSIDE, 'm-followup', null);
check('a goal the engine cannot judge gets no guidance at all', noSituation.missing === true && noSituation.situation === null);

console.log('\nSituations are the bands the engine already computes');
check('On track is sustain', L.situationOfStatus('On track') === 'sustain');
check('At risk is recover', L.situationOfStatus('At risk') === 'recover');
check('Off track is urgent', L.situationOfStatus('Off track') === 'urgent');
['Not reported', 'Insufficient data', 'Not yet measured', ''].forEach(function (status) {
  check('"' + (status || 'blank') + '" gets no situation', L.situationOfStatus(status) === null);
});

/* ============================ the alert signature ============================ */

console.log('\nThe alert fires once per distinct break');
var brokenOnce = parse(renamed).problems;
check('a clean manual has no signature', L.guidanceAlertSignature([]) === '');
check('the same break gives the same signature',
  L.guidanceAlertSignature(brokenOnce) === L.guidanceAlertSignature(parse(renamed).problems));
check('a different break gives a different signature',
  L.guidanceAlertSignature(brokenOnce) !== L.guidanceAlertSignature(parse(demoted).problems));
check('the order problems were found in does not change it',
  L.guidanceAlertSignature([{ kind: 'duplicate', heading: 'B' }, { kind: 'unknown-metric', heading: 'A' }])
  === L.guidanceAlertSignature([{ kind: 'unknown-metric', heading: 'A' }, { kind: 'duplicate', heading: 'B' }]));
check('every problem kind the parser emits is explained in words',
  Object.keys(L.GUIDANCE_PROBLEM_KINDS).length === 7
  && ['unknown-metric', 'unknown-scope', 'unknown-situation', 'not-a-heading', 'orphan-steps', 'duplicate', 'missing-situation']
    .every(function (kind) { return !!L.GUIDANCE_PROBLEM_KINDS[kind]; }));
var everyKind = {};
[renamedResult, relabelledResult, demotedResult, duplicatedResult, orphanResult, badScopeResult].forEach(function (result) {
  kinds(result).forEach(function (kind) { everyKind[kind] = true; });
});
check('and every kind a fixture produced is one of them',
  Object.keys(everyKind).every(function (kind) { return !!L.GUIDANCE_PROBLEM_KINDS[kind]; }), Object.keys(everyKind).join(', '));

console.log('\n----------------------------------------');
console.log('PASSED ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('The format contract holds.');
