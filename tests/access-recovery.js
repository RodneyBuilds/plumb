'use strict';
// Real access and receipt functions; all Google services are simulated in memory.
const assert = require('node:assert/strict');
const create = require('./security-harness');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function ready() { const h=create(); h.setup(); return h; }
function command(h, update) {
 const south=h.sandbox.findAccessUnitByName_('site','Harbor South').unitId;
 const scopes=[{scopeId:south,status:'active',primary:true}];
 if(update) {
  const person=h.sandbox.findRow_('Users','email','site@example.org');
  scopes.unshift({...h.sandbox.accessScopesForUser_(person.userId,true)[0],status:'inactive',primary:false});
 }
 return {email:update?'site@example.org':'new@example.org',name:'Recovery sample',roleKey:'site',scopes};
}
function receiptFor(h,payload) {
 const hash=h.sandbox.operationHash_(payload);
 return h.rows('Operations').find(r=>r.action==='access.save'&&r.commandHash===hash);
}
function businessSnapshot(h) { return JSON.stringify({sheets:h.book.sheets,writes:h.writes}); }
function verifyFinal(h,payload,receipt) {
 const people=h.rows('Users').filter(r=>r.email===payload.email);
 assert.equal(people.length,1);
 const scopes=h.sandbox.accessScopesForUser_(people[0].userId,true);
 assert.equal(new Set(scopes.map(s=>s.userScopeId)).size,scopes.length);
 assert.deepEqual(Array.from(h.sandbox.resolveAccessUser_(payload.email).scopeSites),['Harbor South']);
 assert.equal(h.rows('Operations').find(r=>r.operationId===receipt.operationId).status,'COMMITTED');
 const auditId=h.sandbox.operationChildId_(receipt.operationId,'audit:access:'+people[0].userId+':'+(payload.email==='new@example.org'?'create':'update'));
 assert.equal(h.rows('AuditLog').filter(r=>r.id===auditId).length,1);
 const before=businessSnapshot(h), result=h.call('access.save',payload);
 assert.equal(result.ok,true); assert.equal(result.duplicate,true); assert.equal(result.operationId,receipt.operationId);
 assert.equal(businessSnapshot(h),before);
}
for(const update of [false,true]) {
 const baseline=ready(), payload=command(baseline,update), put=baseline.sandbox.operationPut_;
 let total=0; baseline.sandbox.operationPut_=(...args)=>{total++;return put(...args);};
 assert.equal(baseline.call('access.save',payload).ok,true);
 for(const phase of ['before','after']) for(let fault=1;fault<=total;fault++) {
  test((update?'scope revocation':'new user')+' '+phase+' durable write '+fault+'/'+total,()=>{
   const h=ready(), input=command(h,update), original=h.sandbox.operationPut_; let calls=0;
   h.sandbox.operationPut_=(...args)=>{
    calls++;
    if(calls===fault&&phase==='before')throw Error('injected before durable write');
    const result=original(...args);
    if(calls===fault&&phase==='after')throw Error('injected after durable write');
    return result;
   };
   assert.equal(h.call('access.save',input).ok,false);
   h.sandbox.operationPut_=original;
   const receipt=receiptFor(h,input);
   if(receipt&&receipt.status!=='COMMITTED')assert.equal(h.sandbox.resolveAccessUser_(input.email),null);
   assert.equal(h.sandbox.resolveAccessUser_('admin@example.org').known,true);
   assert.equal(h.props.ACCESS_UPDATE_PENDING,undefined);
   assert.equal(h.call('access.save',input).ok,true);
   verifyFinal(h,input,receiptFor(h,input));
  });
 }
}
test('invalid complete scope command leaves no receipt or business mutation',()=>{
 const h=ready(),payload=command(h,true);payload.scopes.push({scopeId:'not-a-unit',status:'active'});
 const before=businessSnapshot(h);assert.equal(h.call('access.save',payload).code,'E_VALIDATION');assert.equal(businessSnapshot(h),before);
});
test('pending target rejects changed command; unrelated staff remain authorized',()=>{
 const h=ready(),payload=command(h,true),put=h.sandbox.operationPut_;
 h.sandbox.operationPut_=(table,key,row)=>{if(table==='UserScopes')throw Error('injected');return put(table,key,row);};
 assert.equal(h.call('access.save',payload).ok,false);h.sandbox.operationPut_=put;
 assert.equal(h.call('access.save',{...payload,name:'different'}).code,'E_RECOVERY');
 assert.equal(h.sandbox.resolveAccessUser_('regional@example.org').known,true);
 assert.equal(h.sandbox.resolveAccessUser_('site@example.org'),null);
 assert.equal(h.call('access.list').items.find(r=>r.email==='site@example.org').pending,true);
 assert.equal(h.sandbox.recoverAccessOperation_(receiptFor(h,payload).operationId).status,'COMMITTED');
 verifyFinal(h,payload,receiptFor(h,payload));
});
test('installer recovery finishes self-revocation and its audit',()=>{
 const h=ready();assert.equal(h.call('access.save',{email:'second@example.org',name:'Second',roleKey:'admin',scopes:[{scopeId:'ORG-ROOT',status:'active'}]}).ok,true);
 const payload={email:'admin@example.org',name:'Installer',roleKey:'admin',active:false},put=h.sandbox.operationPut_;
 h.sandbox.operationPut_=(table,key,row)=>{if(table==='AuditLog')throw Error('injected audit failure');return put(table,key,row);};
 assert.equal(h.call('access.save',payload).ok,false);h.sandbox.operationPut_=put;
 assert.equal(h.sandbox.resolveAccessUser_('admin@example.org'),null);
 assert.equal(h.sandbox.resolveAccessUser_('second@example.org').known,true);
 assert.equal(h.sandbox.recoverAccessOperation_(receiptFor(h,payload).operationId).status,'COMMITTED');
 assert.equal(h.sandbox.resolveAccessUser_('admin@example.org'),null);
 assert.equal(h.rows('AuditLog').filter(r=>r.recordId===h.sandbox.findRow_('Users','email','admin@example.org').userId&&r.action==='update').length,1);
});
test('PREPARING self-change requires exact original command for installer recovery',()=>{
 const h=ready(),payload={email:'admin@example.org',name:'Installer renamed',roleKey:'admin'},put=h.sandbox.operationPut_;
 h.sandbox.operationPut_=(table,key,row)=>{if(table==='OperationSteps')throw Error('injected preparation failure');return put(table,key,row);};
 assert.equal(h.call('access.save',payload).ok,false);h.sandbox.operationPut_=put;
 const receipt=receiptFor(h,payload);assert.equal(receipt.status,'PREPARING');
 assert.equal(h.sandbox.resolveAccessUser_('admin@example.org'),null);
 assert.throws(()=>h.sandbox.recoverAccessOperation_(receipt.operationId),/original complete/);
 assert.throws(()=>h.sandbox.recoverAccessOperation_(receipt.operationId,{...payload,name:'Wrong'}),/E_CONFLICT/);
 assert.equal(h.sandbox.recoverAccessOperation_(receipt.operationId,payload).status,'COMMITTED');
 assert.equal(h.sandbox.resolveAccessUser_('admin@example.org').name,'Installer renamed');
});
test('recovery rejects unknown, external, different active or effective identities',()=>{
 const h=ready(),payload=command(h,false),put=h.sandbox.operationPut_;
 h.sandbox.operationPut_=(table,key,row)=>{if(table==='Users')throw Error('injected');return put(table,key,row);};
 h.call('access.save',payload);h.sandbox.operationPut_=put;const id=receiptFor(h,payload).operationId;
 for(const email of ['','unknown@example.org','outside@example.net','site@example.org']) {h.switchUser(email);assert.throws(()=>h.sandbox.recoverAccessOperation_(id),/E_FORBIDDEN/);}
 h.switchUser('admin@example.org');h.sandbox.Session.getEffectiveUser=()=>({getEmail:()=> 'other@example.org'});
 assert.throws(()=>h.sandbox.recoverAccessOperation_(id),/E_FORBIDDEN/);
 assert.equal(typeof h.sandbox.recoverAccessOperation,'undefined');
});
test('same payload after a later edit creates a new accepted revision',()=>{
 const h=ready(),payload=command(h,false),first=h.call('access.save',payload);
 assert.equal(first.ok,true);
 assert.equal(h.call('access.save',{...payload,name:'A later edit'}).ok,true);
 const restored=h.call('access.save',payload);
 assert.equal(restored.ok,true);assert.notEqual(restored.operationId,first.operationId);assert.equal(restored.duplicate,false);
 assert.equal(restored.item.name,payload.name);
});
test('scope-only pending operation fences its person and cannot use access recovery',()=>{
 const h=ready(),person=h.sandbox.findRow_('Users','email','site@example.org'),scope=h.sandbox.accessScopesForUser_(person.userId,true)[0];
 const put=h.sandbox.operationPut_;
 h.sandbox.operationPut_=(table,key,row)=>{if(table==='UserScopes')throw Error('injected');return put(table,key,row);};
 assert.throws(()=>h.sandbox.operationRun_({actor:'admin@example.org',action:'scope-only-test',submissionKey:'scope-only',payload:{scopeId:scope.scopeId}},
  ()=>[h.sandbox.operationStep_('UserScopes','userScopeId',scope,{...scope,status:'inactive'})],
  {tableKeys:{UserScopes:'userScopeId'},authorize:()=>{}}),/injected/);
 h.sandbox.operationPut_=put;
 assert.equal(h.sandbox.resolveAccessUser_('site@example.org'),null);
 assert.equal(h.sandbox.resolveAccessUser_('admin@example.org').known,true);
 const receipt=h.rows('Operations').find(r=>r.action==='scope-only-test');
 assert.throws(()=>h.sandbox.recoverAccessOperation_(receipt.operationId),/access operations only/);
});
test('cancelled preparation releases target and permits a fresh same-command attempt',()=>{
 const h=ready(),payload=command(h,true),put=h.sandbox.operationPut_;
 h.sandbox.operationPut_=(table,key,row)=>{if(table==='OperationSteps')throw Error('injected');return put(table,key,row);};
 assert.equal(h.call('access.save',payload).ok,false);h.sandbox.operationPut_=put;
 const old=receiptFor(h,payload);assert.equal(old.status,'PREPARING');
 assert.equal(h.sandbox.resolveAccessUser_('site@example.org'),null);
 assert.equal(h.sandbox.operationCancelPreparation_(old.operationId,{authorize:()=>{}}).status,'CANCELLED');
 assert.equal(h.sandbox.resolveAccessUser_('site@example.org').known,true);
 const retry=h.call('access.save',payload);assert.equal(retry.ok,true);assert.notEqual(retry.operationId,old.operationId);
 assert.equal(h.rows('Operations').find(r=>r.operationId===old.operationId).status,'CANCELLED');
 verifyFinal(h,payload,h.rows('Operations').find(r=>r.operationId===retry.operationId));
});
console.log('PASSED '+passed+' / '+passed+' access recovery scenarios');
