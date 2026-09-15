'use strict';
const assert = require('node:assert/strict'), harness = require('./recovery-harness');
let passed = 0;
const time='2026-09-11T10:00:00.000Z', later='2026-09-11T10:16:00.000Z';
function test(name,run) { try {run(); passed++; console.log('PASS '+name);} catch(error) {console.error('FAIL '+name);throw error;} }
const command = {actor:'user-1',action:'item.save',submissionKey:'submission-1',payload:{value:'saved'}};
function options() { return {authorize:()=>{},tableKeys:{Items:'id',Events:'id'}}; }
function plan(c) { return (id)=>[{table:'Items',key:'item-1',before:null,after:{id:'item-1',value:'saved'}},{table:'Events',key:c.operationChildId_(id,'event'),before:null,after:{id:c.operationChildId_(id,'event'),itemId:'item-1',value:'created'}}]; }
function run(h,cmd=command) { return h.c.operationRun_(cmd,plan(h.c),options()); }
const baseline = harness(); run(baseline); const writes = baseline.state.writes;
for (const after of [false,true]) for(let boundary=1;boundary<=writes;boundary++) {
  test(`operation recovers ${after?'lost acknowledgment':'before write'} ${boundary}/${writes}`,()=>{
    const h=harness(); h.state.failAt=boundary; h.state.failAfter=after;
    assert.throws(()=>run(h)); h.state.failAt=0;
    assert.equal(run(h).status,'COMMITTED');
    assert.equal(h.rows('Items').length,1); assert.equal(h.rows('Events').length,1);
    assert.equal(h.rows('Operations')[0].status,'COMMITTED');
    const count=h.state.writes; assert.equal(run(h).duplicate,true); assert.equal(h.state.writes,count);
  });
}
test('validation rejects every incomplete plan before first write',()=>{
  for(const bad of [[],[{table:'Items',key:'x',before:null,after:{id:'x'}}],[{table:'Operations',key:'x',before:null,after:{id:'x'}}],[{table:'Items',key:'x',before:null,after:{id:'different',value:'x'}}]]) {
    const h=harness(); assert.throws(()=>h.c.operationRun_(command,()=>bad,options())); assert.equal(h.state.writes,0);
  }
});
test('authorization is required and repeated even on committed retry',()=>{
  const h=harness(); run(h); const count=h.state.writes;
  assert.throws(()=>h.c.operationRun_(command,plan(h.c),{tableKeys:{Items:'id'}}));
  assert.throws(()=>h.c.operationRun_(command,plan(h.c),{...options(),authorize:()=>{throw Error('denied');}})); assert.equal(h.state.writes,count);
});
test('different payload for existing submission key conflicts',()=>{const h=harness();run(h);assert.throws(()=>run(h,{...command,payload:{value:'other'}}),/E_CONFLICT/);});
test('duplicate steps and existing key collisions fail closed',()=>{
  const h=harness(), row={table:'Items',key:'x',before:null,after:{id:'x',value:'x'}};
  assert.throws(()=>h.c.operationRun_(command,()=>[row,row],options()),/duplicate/); assert.equal(h.state.writes,0);
  h.c.appendRow_('Items',{id:'item-1',value:'a'});h.c.appendRow_('Items',{id:'item-1',value:'b'});assert.throws(()=>run(h),/duplicate/);
});
test('interrupted preparation blocks an unrelated new mutation',()=>{
  const h=harness();h.state.failAt=2;assert.throws(()=>run(h));h.state.failAt=0;
  assert.throws(()=>run(h,{...command,submissionKey:'other'}),/unfinished/);run(h);
});
test('preparing retry must reproduce original deterministic plan',()=>{
  const h=harness();h.state.failAt=2;assert.throws(()=>run(h));h.state.failAt=0;
  assert.throws(()=>h.c.operationRun_(command,()=>[{table:'Items',key:'changed',before:null,after:{id:'changed',value:'x'}}],options()),/different plan/);
});
test('any unresolved operation pauses all new writes, including unrelated keys',()=>{
  const h=harness();h.state.failAt=6;assert.throws(()=>run(h));h.state.failAt=0;
  assert.throws(()=>h.c.operationRun_({...command,submissionKey:'new'},()=>[{table:'Items',key:'other',before:null,after:{id:'other',value:'x'}}],options()),/unfinished operation/);
});
test('only unapplied preparation can be cancelled and cancelled steps are inert',()=>{
  const h=harness();h.state.failAt=4;assert.throws(()=>run(h));h.state.failAt=0;const id=h.rows('Operations')[0].operationId;
  assert.equal(h.c.operationCancelPreparation_(id,options()).status,'CANCELLED');assert.equal(h.c.operationPending_('Items','item-1'),false);assert.equal(h.rows('OperationSteps').length,2);
  assert.throws(()=>run(h),/cancelled/);assert.equal(run(h,{...command,submissionKey:'new'}).status,'COMMITTED');
  assert.throws(()=>h.c.operationCancelPreparation_(h.rows('Operations')[1].operationId,options()),/only an unapplied/);
});
test('unexpected persisted data goes to review without overwriting it',()=>{
  const h=harness();h.state.failAt=6;assert.throws(()=>run(h));h.state.failAt=0;
  h.c.writeRowAt_('Items',2,{id:'item-1',value:'external edit'});
  assert.throws(()=>run(h),/administrator review/);assert.equal(h.rows('Operations')[0].status,'NEEDS_REVIEW');assert.equal(h.rows('Items')[0].value,'external edit');
});
test('corrupted stored plan goes to review',()=>{
  const h=harness();h.state.failAt=5;assert.throws(()=>run(h));h.state.failAt=0;
  const row=h.rows('OperationSteps')[0];row.afterJson='{}';h.c.writeRowAt_('OperationSteps',row._row,row);
  assert.throws(()=>run(h),/administrator review/);assert.equal(h.rows('Items').length,0);
});
test('committed retry remains valid after a later legitimate change',()=>{
  const h=harness();run(h);h.c.writeRowAt_('Items',2,{id:'item-1',value:'later'});assert.equal(run(h).duplicate,true);assert.equal(h.rows('Items')[0].value,'later');
});
test('partial operation fences its affected rows',()=>{const h=harness();h.state.failAt=6;assert.throws(()=>run(h));assert.equal(h.c.operationPending_('Items','item-1'),true);h.state.failAt=0;run(h);assert.equal(h.c.operationPending_('Items','item-1'),false);});
test('authorized recovery completes a prepared operation without original browser command',()=>{
  const h=harness();h.state.failAt=6;assert.throws(()=>run(h));h.state.failAt=0;const receipt=h.rows('Operations')[0];let authorized=false;
  const result=h.c.operationRecover_(receipt.operationId,{...options(),authorize:r=>{assert.equal(r.actor,command.actor);authorized=true;}});
  assert.equal(result.status,'COMMITTED');assert.equal(authorized,true);assert.equal(h.rows('Events').length,1);
});
test('administrator recovery refuses incomplete preparation and denied callers',()=>{
  const h=harness();h.state.failAt=2;assert.throws(()=>run(h));h.state.failAt=0;const id=h.rows('Operations')[0].operationId;
  assert.throws(()=>h.c.operationRecover_(id,options()),/original command/);
  assert.throws(()=>h.c.operationRecover_(id,{...options(),authorize:()=>{throw Error('denied');}}),/denied/);
});
test('row and step builders complete schema, exclude metadata and normalize dates',()=>{
  const h=harness();const row=h.c.operationRow_('Items',{id:'x',_row:2,extra:'ignored'});assert.equal(row.value,'');assert.equal(row._row,undefined);assert.equal(row.extra,undefined);
  const step=h.c.operationStep_('Items','id',null,{id:'x',value:new Date(time)});assert.equal(step.before,null);assert.equal(step.after.value,time);
});
test('audit steps have deterministic IDs and pending-key map covers partial data',()=>{
  const h=harness();h.table('AuditLog',['id','entity','recordId','action','beforeJson','afterJson','actor','at']);
  const args=['op-1','now','item','x','create',null,{id:'x'},'actor'];
  assert.equal(h.c.operationAuditStep_(...args).key,h.c.operationAuditStep_(...args).key);
  h.state.failAt=6;assert.throws(()=>run(h));assert.equal(h.c.operationPendingKeys_('Items')['item-1'],true);
});
test('outbox deduplicates exact content and rejects collisions',()=>{const h=harness();const first=h.c.outboxEnqueue_('round',{userId:'u'});assert.equal(h.c.outboxEnqueue_('round',{userId:'u'}).jobId,first.jobId);assert.throws(()=>h.c.outboxEnqueue_('round',{userId:'v'}),/E_CONFLICT/);});
test('simultaneous claim cannot claim an active send',()=>{const h=harness();h.c.outboxEnqueue_('round',{});assert.ok(h.c.outboxClaim_(time));assert.equal(h.c.outboxClaim_(time),null);});
test('expired send becomes unknown rather than retried',()=>{const h=harness();h.c.outboxEnqueue_('round',{});h.c.outboxClaim_(time);assert.equal(h.c.outboxClaim_(later),null);assert.equal(h.rows('NotificationOutbox')[0].state,'UNKNOWN');});
test('preparation failure retries with bounded attempts',()=>{
  const h=harness();h.c.outboxEnqueue_('round',{});const adapter={prepare:()=>{throw Error('unavailable');},send:()=>{throw Error('must not send');}};
  assert.equal(h.c.outboxDispatchOne_(adapter,time).state,'RETRYABLE');assert.equal(h.c.outboxClaim_('2026-09-11T10:14:00.000Z'),null);
  assert.equal(h.c.outboxDispatchOne_(adapter,later).state,'RETRYABLE');assert.equal(h.c.outboxDispatchOne_(adapter,'2026-09-11T11:17:00.000Z').state,'FAILED');
});
test('revoked recipient cancels without a send attempt',()=>{const h=harness();h.c.outboxEnqueue_('round',{});let sent=0;assert.equal(h.c.outboxDispatchOne_({prepare:()=>null,send:()=>sent++},time).state,'CANCELLED');assert.equal(sent,0);});
test('ambiguous mail exception stays unknown',()=>{const h=harness();h.c.outboxEnqueue_('round',{});assert.equal(h.c.outboxDispatchOne_({prepare:()=>({}),send:()=>{throw Error('network unknown');}},time).state,'UNKNOWN');assert.equal(h.c.outboxClaim_(later),null);});
for(const after of [false,true]) test(`mail acceptance acknowledgment failure (${after?'after':'before'}) never automatically resends`,()=>{
  const h=harness();h.c.outboxEnqueue_('round',{});let sent=0;
  assert.throws(()=>h.c.outboxDispatchOne_({prepare:()=>({}),send:()=>{sent++;h.state.failAt=h.state.writes+1;h.state.failAfter=after;}},time));
  h.state.failAt=0;assert.equal(h.c.outboxClaim_(later),null);assert.equal(sent,1);assert.equal(h.rows('NotificationOutbox')[0].state,after?'SENT':'UNKNOWN');
});
test('lost claim acknowledgment causes no mail and becomes visible uncertainty',()=>{
  const h=harness();h.c.outboxEnqueue_('round',{});let sent=0;h.state.failAt=h.state.writes+1;h.state.failAfter=true;
  assert.throws(()=>h.c.outboxDispatchOne_({prepare:()=>({}),send:()=>sent++},time));h.state.failAt=0;assert.equal(h.c.outboxClaim_(later),null);assert.equal(sent,0);
});
test('old claim cannot settle a different attempt',()=>{
  const h=harness();h.c.outboxEnqueue_('round',{});const first=h.c.outboxClaim_(time);h.c.outboxFinish_(first,'RETRYABLE',time);h.c.outboxClaim_(later);assert.throws(()=>h.c.outboxFinish_(first,'SENT',later),/claim changed/);
});
function policy(h) { return {schemaVersion:1,tables:{Items:{key:'id',headers:['id','value']},Events:{key:'id',headers:['id','itemId','value']},NotificationOutbox:{key:'jobId',headers:Array.from(h.c.OUTBOX_HEADERS_)}},configKeys:['CUSTOMER_NAME'],references:[{table:'Events',column:'itemId',target:'Items',targetKey:'id'}]}; }
function target() {const data={},config={};return{data,config,isIsolated:true,isEmpty:()=>Object.keys(data).length===0,configure:v=>Object.assign(config,v),writeTable:(n,headers,rows)=>{data[n]=JSON.parse(JSON.stringify(rows));},readTable:n=>data[n]};}
test('backup roundtrip verifies relations and keeps configuration and notifications safe',()=>{
  const h=harness();run(h);h.c.outboxEnqueue_('round',{});h.c.outboxClaim_(time);const p=policy(h), b=h.c.backupBuild_(p,{CUSTOMER_NAME:'Synthetic',SECRET_VALUE:'excluded'}),t=target();
  assert.equal(b.body.config.SECRET_VALUE,undefined);const result=h.c.backupRestoreIsolated_(b,p,t);assert.equal(result.activated,false);assert.equal(t.config.REMINDERS_ENABLED,'false');assert.equal(t.config.RESTORE_STATE,'AWAITING_ADMIN_REVIEW');assert.equal(t.data.NotificationOutbox[0].state,'UNKNOWN');assert.equal(t.config.CUSTOMER_NAME,undefined);
});
test('backup rejects corruption, unsupported version, duplicate IDs and dangling references',()=>{
  const h=harness();run(h);const p=policy(h),original=h.c.backupBuild_(p,{});
  for(const edit of [b=>{b.body.schemaVersion=2;},b=>{b.body.tables.Items.push(b.body.tables.Items[0]);},b=>{b.body.tables.Events[0].itemId='missing';},b=>{b.body.config.EXTRA='not allowed';}]){
    const b=h.plain(original);edit(b);b.hash=h.c.operationHash_(b.body);assert.throws(()=>h.c.backupValidate_(b,p));
  }
  const b=h.plain(original);b.body.tables.Items[0].value='tampered';assert.throws(()=>h.c.backupValidate_(b,p),/integrity/);
});
test('restore refuses nonempty or nonisolated destinations before mutation',()=>{
  const h=harness(),p=policy(h),b=h.c.backupBuild_(p,{});for(const t of [{...target(),isIsolated:false},{...target(),isEmpty:()=>false}]){assert.throws(()=>h.c.backupRestoreIsolated_(b,p,t),/isolated empty/);assert.equal(Object.keys(t.config).length,0);}
});
test('restore write failure remains incomplete and cannot be activated or resumed in place',()=>{
  const h=harness();run(h);const p=policy(h),b=h.c.backupBuild_(p,{}),t=target(),write=t.writeTable;t.writeTable=(...args)=>{write(...args);throw Error('lost ack');};
  assert.throws(()=>h.c.backupRestoreIsolated_(b,p,t));assert.equal(t.config.RESTORE_STATE,'INCOMPLETE');assert.throws(()=>h.c.backupRestoreIsolated_(b,p,t),/empty/);
});
test('restore checks actual persisted values before review status',()=>{
  const h=harness();run(h);const p=policy(h),b=h.c.backupBuild_(p,{}),t=target();t.readTable=()=>[];assert.throws(()=>h.c.backupRestoreIsolated_(b,p,t),/verification/);assert.equal(t.config.RESTORE_STATE,'INCOMPLETE');
});
function notificationHarness() {
  const h=harness();h.load(['Reminders','Playbook']);h.table('NotificationLog',['notificationId','type','period','goalId','recipient','sentAt','result']);
  const sent=[];let allowed=true;
  Object.assign(h.c,{REMINDER_ROUNDS:[{type:'data-due-1',label:'Reminder'}],remindersEnabled_:()=>true,playbookAlertsEnabled_:()=>true,
    dataDueOutstanding_:()=>[{goalId:'g1',recipient:'staff@example.test',site:'North',metricName:'Follow-up'}],openPeriodOn_:()=> '2026-08',
    resolveAccessUser_:email=>allowed?{email}:null,hasPermission_:()=>true,sitesInScope_:()=>['North'],
    reminderSubject_:()=> 'Reminder',reminderBody_:()=> 'Follow-up at North',
    isPlaybookMaintainer_:user=>!!user,requirePlaybookMaintainer_:()=>{},playbookDocId_:()=> 'doc-1',
    playbookHealthRow_:()=>({docId:'doc-1',status:'broken',alertSignature:'sig-1',problemsJson:'[{"heading":"Heading"}]',lastEditorEmail:'staff@example.test'}),
    playbookSnapshotRead_:()=>({health:{docId:'doc-1',status:'broken',alertSignature:'sig-1',problemsJson:'[{"heading":"Heading"}]',lastEditorEmail:'staff@example.test'}}),
    playbookManagers_:()=>[{email:'staff@example.test'}],playbookAlertSubject_:()=> 'Manual issue',playbookAlertBody_:()=> 'Manual needs review',playbookBoard_:()=>({}),
    MailApp:{sendEmail:message=>sent.push(message),getRemainingDailyQuota:()=>10},ScriptApp:{getService:()=>({getUrl:()=> 'https://example.test/app'})}
  });
  return {...h,sent,revoke:()=>{allowed=false;}};
}
test('real reminder round uses outbox dedupe and projects confirmed per-goal logs',()=>{
  const h=notificationHarness(),round=h.c.REMINDER_ROUNDS[0];const first=h.c.sendDataDueRound_('2026-08',round,new Date(time));
  assert.equal(first.sent,1);assert.equal(first.logged,1);assert.equal(h.c.sendDataDueRound_('2026-08',round,new Date(time)).sent,0);assert.equal(h.sent.length,1);assert.equal(h.rows('NotificationLog').length,1);
});
test('real reminder retries quota failure but never retries uncertain delivery',()=>{
  const h=notificationHarness(),round=h.c.REMINDER_ROUNDS[0];h.c.MailApp.getRemainingDailyQuota=()=>0;
  assert.equal(h.c.sendDataDueRound_('2026-08',round,new Date(time)).retryable,1);assert.equal(h.sent.length,0);
  h.c.MailApp.getRemainingDailyQuota=()=>10;h.c.MailApp.sendEmail=()=>{throw Error('uncertain');};assert.equal(h.c.notificationDrain_(null,later).unknown,1);assert.equal(h.c.notificationDrain_(null,'2026-09-12T10:16:00.000Z').sent,0);
});
test('real outbox drain rechecks a queued recipient after revocation',()=>{
  const h=notificationHarness();h.c.outboxEnqueue_('queued',{type:'data-due',period:'2026-08',roundType:'data-due-1',recipient:'staff@example.test'});h.revoke();assert.equal(h.c.notificationDrain_(null,time).cancelled,1);assert.equal(h.sent.length,0);
});
test('real playbook alerts and manual reminders expose durable outcomes',()=>{
  const h=notificationHarness(),health=h.c.playbookHealthRow_();assert.equal(h.c.playbookAlert_(health,[{heading:'Heading'}]).sent,1);assert.equal(h.c.playbookAlert_(health,[{heading:'Heading'}]).sent,0);
  h.c.MailApp.sendEmail=()=>{throw Error('uncertain');};const response=h.c.playbookRemind_({email:'manager@example.test'},{});assert.equal(response.reminded.sent,false);assert.equal(response.reminded.state,'UNKNOWN');
  assert.equal(h.c.playbookRemind_({email:'manager@example.test'},{}).reminded.state,'UNKNOWN');assert.equal(h.rows('NotificationOutbox').length,2);
});
test('final notification authorization and send hold the same lock after preflight',()=>{
  const h=harness();h.c.outboxEnqueue_('locked',{});let allowed=true,sent=0;
  const result=h.c.outboxDispatchOne_({preflight:()=>{assert.equal(h.state.locked,false);allowed=false;},prepare:()=>{assert.equal(h.state.locked,true);return allowed?{}:null;},send:()=>{sent++;}},time);
  assert.equal(result.state,'CANCELLED');assert.equal(sent,0);
  h.c.outboxEnqueue_('locked-success',{});
  const success=h.c.outboxDispatchOne_({prepare:()=>{assert.equal(h.state.locked,true);return {};},send:()=>{assert.equal(h.state.locked,true);sent++;}},time);
  assert.equal(success.state,'SENT');assert.equal(sent,1);assert.equal(h.state.locked,false);
});
test('real access revocation during quota lookup cancels before final locked send',()=>{
  const h=require('./security-harness')();h.setup();const c=h.sandbox,now=new Date().toISOString();h.props.REMINDERS_ENABLED='true';
  const payload={type:'data-due',period:c.openPeriodOn_(new Date(now)),roundType:c.REMINDER_ROUNDS[0].type,recipient:'site@example.org'};
  c.outboxEnqueue_('revoke-during-quota',payload);let sent=0;
  c.MailApp.getRemainingDailyQuota=()=>{const result=h.call('access.save',{email:'site@example.org',name:'Site Tester',roleKey:'site',active:false});assert.equal(result.ok,true);return 100;};
  c.MailApp.sendEmail=()=>sent++;
  const result=c.notificationDrain_(null,now);assert.equal(result.cancelled,1);assert.equal(sent,0);assert.equal(c.resolveAccessUser_('site@example.org'),null);
});
test('notification bypasses stale screen-pinned broken health after a healthy publication',()=>{
  const h=require('./security-harness')();h.setup();const c=h.sandbox,doc='test-doc';h.props.PLAYBOOK_DOC_ID=doc;h.props.PLAYBOOK_ALERTS_ENABLED='true';
  const first=c.playbookSnapshotPublish_(doc,'',[],{docId:doc,status:'broken',alertSignature:'old-break',problemsJson:'[]',lastCheckedAt:'old'});
  assert.equal(c.playbookHealthRow_(doc).status,'broken');
  c.playbookSnapshotPublish_(doc,first.generationId,[],{docId:doc,status:'healthy',alertSignature:'',problemsJson:'[]',lastCheckedAt:'new'});
  assert.equal(c.playbookHealthRow_(doc).status,'broken');
  assert.equal(c.notificationPrepare_({type:'playbook-broken',docId:doc,signature:'old-break',recipient:'admin@example.org'},time),null);
});
console.log(`Recovery foundation: ${passed} passed.`);
