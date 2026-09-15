'use strict';
const assert=require('node:assert/strict'), harness=require('./recovery-harness');
let passed=0;
function test(name,fn) { fn();passed++;console.log('PASS '+name); }
const doc='doc-1';
function block(id,value) { return {blockId:id,scopeUnitId:'ORG-ROOT',scopeType:'organization',metricId:id,situation:'recover',stepsJson:JSON.stringify([value]),sourceDocId:doc,sourceHeading:id,parsedAt:'2026-09-11T10:00:00.000Z',ok:true}; }
function health(mark) { return {docId:doc,status:'healthy',lastCheckedAt:mark,lastGoodAt:mark,problemsJson:'[]',alertSignature:''}; }
function setup() {
  const h=harness();h.load(['GuidanceSnapshots','Playbook']);Object.entries(h.c.GUIDANCE_SNAPSHOT_SCHEMA_).forEach(([n,cols])=>h.table(n,cols));
  h.table('OrganizationUnits',['unitId']);h.c.cleanRow_=h.c.operationPlain_;h.c.playbookDocId_=()=>doc;
  return h;
}
for(const after of [false,true])for(let boundary=1;boundary<=4;boundary++)test(`publication ${after?'lost acknowledgment':'failure before'} boundary ${boundary} keeps coherent content`,()=>{
  const h=setup();const old=h.c.playbookSnapshotPublish_(doc,'',[block('a','old-a'),block('b','old-b')],health('old'));
  h.state.failAt=h.state.writes+boundary;h.state.failAfter=after;
  assert.throws(()=>h.c.playbookSnapshotPublish_(doc,old.generationId,[block('a','new-a'),block('b','new-b')],health('new')));
  const current=h.c.playbookSnapshotRead_(doc,true),newVisible=after&&boundary===4;
  assert.equal(current.health.lastCheckedAt,newVisible?'new':'old');assert.equal(JSON.parse(current.blocks[0].stepsJson)[0],newVisible?'new-a':'old-a');
  h.state.failAt=0;h.c.playbookSnapshotPublish_(doc,old.generationId,[block('a','new-a'),block('b','new-b')],health('new'));
  assert.equal(h.c.playbookSnapshotRead_(doc,true).health.lastCheckedAt,'new');assert.equal(h.rows('GuidanceSnapshots').length,4);
});
test('read pins one generation even when publication changes the active pointer',()=>{
  const h=setup(),first=h.c.playbookSnapshotPublish_(doc,'',[block('a','old')],health('old'));const pinned=h.c.playbookSnapshotRead_(doc);
  h.c.playbookSnapshotPublish_(doc,first.generationId,[block('a','new')],health('new'));assert.equal(h.c.playbookSnapshotRead_(doc).generationId,pinned.generationId);assert.equal(h.c.playbookSnapshotRead_(doc,true).health.lastCheckedAt,'new');
});
test('stale refresh cannot overwrite a newer publication',()=>{
  const h=setup(),old=h.c.playbookSnapshotPublish_(doc,'',[block('a','old')],health('old'));h.c.playbookSnapshotPublish_(doc,old.generationId,[block('a','new')],health('new'));const writes=h.state.writes;
  assert.throws(()=>h.c.playbookSnapshotPublish_(doc,old.generationId,[block('a','stale')],health('stale')),/E_CONFLICT/);assert.equal(h.state.writes,writes);
});
test('corrupted active generation is rejected instead of mixed or silently trusted',()=>{
  const h=setup();h.c.playbookSnapshotPublish_(doc,'',[block('a','old')],health('old'));const row=h.rows('GuidanceSnapshots')[0];row.contentJson=JSON.stringify(block('a','tampered'));h.c.writeRowAt_('GuidanceSnapshots',row._row,row);
  assert.throws(()=>h.c.playbookSnapshotRead_(doc,true),/integrity/);
});
test('routine freshness, health and content reads never contact Google Docs or Drive or write',()=>{
  const h=setup();h.c.playbookSnapshotPublish_(doc,'',[block('a','old')],health('old'));const writes=h.state.writes;let remote=0;
  h.c.DriveApp={getFileById:()=>{remote++;throw Error('forbidden read');}};h.c.playbookDocToLines_=()=>{remote++;throw Error('forbidden parse');};
  assert.equal(h.c.playbookEnsureFresh_().checked,false);assert.equal(h.c.playbookHealthRow_(doc).lastCheckedAt,'old');assert.equal(h.c.guidanceRows_()[0].steps[0],'old');assert.equal(remote,0);assert.equal(h.state.writes,writes);
});
test('uninitialized guidance is explicitly empty and never migrates on reads',()=>{const h=setup();const before=h.state.writes;assert.equal(h.c.guidanceRows_().length,0);assert.equal(h.c.playbookHealthRow_(doc),null);assert.equal(h.state.writes,before);});
function checker(h,parsed) {
  Object.assign(h.c,{playbookDocMeta_:()=>({name:'Manual',url:'https://example.test',modifiedAt:'stable',editor:'',editorEmail:'',editorSource:'unknown',editedAt:''}),metricRows_:()=>[],guidanceIndex_:()=>({}),ACCESS_ROOT_UNIT_ID_:'ORG-ROOT',playbookDocToLines_:()=>[],parseGuidanceLines_:()=>parsed,guidanceMissingProblems_:()=>[],guidanceAlertSignature_:problems=>problems.length?'broken':'',playbookAlert_:()=>({sent:0})});
}
test('document read failure publishes broken health with complete previous guidance',()=>{
  const h=setup();h.c.playbookSnapshotPublish_(doc,'',[block('a','old')],health('old'));checker(h,{});h.c.playbookDocToLines_=()=>{throw Error('unreachable');};
  assert.equal(h.c.playbookCheck_({}).status,'broken');const current=h.c.playbookSnapshotRead_(doc,true);assert.equal(current.health.lastGoodAt,'old');assert.equal(current.health.problemCount,1);assert.equal(JSON.parse(current.blocks[0].stepsJson)[0],'old');
});
test('partial parse retains whole broken section and publishes healthy sections together',()=>{
  const h=setup();h.c.playbookSnapshotPublish_(doc,'',[block('a','old-a'),block('b','old-b')],health('old'));
  const parsed={blocks:[{...block('a','unused'),sectionKey:'a|ORG-ROOT',steps:['bad-half']},{...block('b','unused'),sectionKey:'b|ORG-ROOT',steps:['new-b']}],problems:[{kind:'missing',sectionKey:'a|ORG-ROOT'}]};
  checker(h,parsed);h.c.playbookCheck_({});const current=h.c.playbookSnapshotRead_(doc,true);assert.equal(current.health.status,'broken');assert.equal(JSON.parse(current.blocks[0].stepsJson)[0],'old-a');assert.equal(JSON.parse(current.blocks[1].stepsJson)[0],'new-b');
});
test('document modification during parse abandons candidate before storage',()=>{
  const h=setup();checker(h,{blocks:[],problems:[]});let meta=0;h.c.playbookDocMeta_=()=>({modifiedAt:++meta===1?'before':'after',name:'Manual'});const writes=h.state.writes;
  assert.throws(()=>h.c.playbookCheck_({}),/changed while/);assert.equal(h.state.writes,writes);
});
test('competing refresh during parse prevents older checker publication',()=>{
  const h=setup();checker(h,{blocks:[],problems:[]});h.c.playbookDocToLines_=()=>{h.c.playbookSnapshotPublish_(doc,'',[block('a','new')],health('new'));return [];};
  assert.throws(()=>h.c.playbookCheck_({}),/newer guidance/);assert.equal(h.c.playbookSnapshotRead_(doc,true).health.lastCheckedAt,'new');
});
console.log(`Guidance snapshots: ${passed} passed.`);
