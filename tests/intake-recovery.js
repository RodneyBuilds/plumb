'use strict';
// Real handlers and Sheets adapter; Google identity/storage are simulated.
const assert = require('node:assert/strict');
const create = require('./security-harness');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function ready() {
  const h = create(); h.setup();
  const faults = {writes:0,at:0,after:false};
  for (const sheet of Object.values(h.book.sheets)) {
    const range = sheet.getRange;
    sheet.getRange = function(...args) {
      const result = range.apply(this,args), write = result.setValues;
      result.setValues = function(values) {
        faults.writes++;
        const fail = faults.at === faults.writes;
        if (fail && !faults.after) throw Error('injected before persistence');
        const output = write.call(this,values);
        if (fail && faults.after) throw Error('injected after persistence');
        return output;
      };
      return result;
    };
  }
  return Object.assign(h,{faults});
}
const payload = {submissionKey:'fault-tested-request',title:'Synthetic request',site:'Harbor North',description:'An internal workflow test.',note:'Complete note'};
function scenario(h, kind) {
  if (kind === 'create') return {action:'intake.save',input:payload};
  const item = h.rows('Intake')[0];
  return kind === 'edit' ? {action:'intake.save',input:{id:item.id,version:item.version,title:'Revised synthetic title',note:'Changed title'}} :
    {action:'intake.transition',input:{id:item.id,version:item.version,status:'Triaged',note:'Accepted for review'}};
}
for (const kind of ['create','edit','transition']) {
  const baseline = ready(), command = scenario(baseline,kind);
  const ok = baseline.call(command.action,command.input); assert.equal(ok.ok,true,JSON.stringify(ok));
  const count = baseline.faults.writes;
  for (const after of [false,true]) for (let boundary=1;boundary<=count;boundary++) {
    test(`${kind} recovers ${after?'lost acknowledgment':'before write'} ${boundary}/${count}`,()=>{
      const h = ready(), command = scenario(h,kind), historyCount = h.rows('IntakeHistory').length, auditCount = h.rows('AuditLog').length;
      h.faults.at=boundary; h.faults.after=after;
      assert.equal(h.call(command.action,command.input).ok,false);
      const pending = h.rows('Operations').filter(r=>r.status!=='COMMITTED');
      if (pending.length) {
        const pendingKeys = h.sandbox.operationPendingKeys_('Intake');
        const listed = h.call('intake.list'); assert.equal(listed.ok,true);
        assert.ok(listed.items.every(r=>!pendingKeys[r.id]));
      }
      h.faults.at=0;
      const result=h.call(command.action,command.input); assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(h.rows('IntakeHistory').length,historyCount+1);
      assert.equal(h.rows('AuditLog').length,auditCount+1);
      assert.ok(h.rows('Operations').every(r=>r.status==='COMMITTED'));
      const writes=h.faults.writes, again=h.call(command.action,command.input);
      assert.equal(again.ok,true);assert.equal(again.duplicate,true);assert.equal(h.faults.writes,writes);
      if (kind==='create') assert.equal(h.rows('Intake').filter(r=>r.submissionKey===payload.submissionKey).length,1);
    });
  }
}
test('invalid note or date leaves business and operation tables untouched',()=>{
  for (const invalid of [{note:'x'.repeat(2001)},{targetDate:'2026-02-30'},{dueDate:'tomorrow'}]) {
    const h=ready(), before=JSON.stringify(h.book.sheets), result=h.call('intake.save',{...payload,...invalid});
    assert.equal(result.code,'E_VALIDATION');assert.equal(h.faults.writes,0);assert.equal(JSON.stringify(h.book.sheets),before);
  }
});
test('same key with different content conflicts without overwriting',()=>{
  const h=ready(); assert.equal(h.call('intake.save',payload).ok,true);
  const writes=h.faults.writes, result=h.call('intake.save',{...payload,title:'Different content'});
  assert.equal(result.code,'E_CONFLICT');assert.equal(h.faults.writes,writes);
});
test('same key belongs to actor and cannot reveal another actors request',()=>{
  const h=ready(); const first=h.call('intake.save',payload);h.switchUser('site@example.org');
  const second=h.call('intake.save',payload);assert.equal(second.ok,true);assert.notEqual(first.item.id,second.item.id);
});
test('revoked caller cannot replay a committed save',()=>{
  const h=ready();h.switchUser('site@example.org');assert.equal(h.call('intake.save',payload).ok,true);
  const row=h.sandbox.findRow_('Users','email','site@example.org');row.active=false;h.sandbox.writeRowAt_('Users',row._row,row);
  assert.equal(h.call('intake.save',payload).code,'E_FORBIDDEN');
});
console.log(`Intake recovery: ${passed} passed`);
