'use strict';
// Scoped responses exercise real server functions with explicitly simulated Google services.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const units = {'ORG-ROOT': {unitType:'organization',name:'Organization'}, north:{unitType:'region',name:'North',parentUnitId:'ORG-ROOT'}, south:{unitType:'region',name:'South',parentUnitId:'ORG-ROOT'}, n:{unitType:'site',name:'North Site',parentUnitId:'north'}, s:{unitType:'site',name:'South Site',parentUnitId:'south'}};
let active = true, mails = [];
const user = {known:true,email:'north@example.org',name:'North',permissions:['performance.enter','playbook.manage'],scopes:[{scopeId:'north',status:'active'}],scopeSites:['North Site']};
const sandbox = {console,Date,JSON,Object,Array,String,Number,playbookSnapshotRead_:()=>({generationId:'demo-generation'}),outboxDispatchOne_:()=>({}),ACCESS_ROOT_UNIT_ID_:'ORG-ROOT',GUIDANCE_SITUATIONS:['recover'],SITUATION_LABELS:{recover:'Recover'},GUIDANCE_PROBLEM_KINDS:{},REMINDER_ROUNDS:[],PRODUCT_NAME:'Test',
 hasPermission_:(u,p)=>!!u?.known && u.permissions.includes(p),scopeAssignmentActive_:s=>s.status==='active',sitesInScope_:u=>u.scopeSites,
 unitWithinScope_:(id,parent,map)=>{const seen=new Set();while(id&&!seen.has(id)){if(id===parent)return true;seen.add(id);id=map[id]?.parentUnitId;}return false;},
 requirePerformanceRead_:()=>{},requirePermission_:()=>{},accessUnitIndex_:()=>units,metricRows_:()=>[{metricId:'m',name:'Metric',active:true}],metricIndex_:rows=>Object.fromEntries(rows.map(r=>[r.metricId,r])),perfActive_:v=>v!==false,
 resolveAccessUser_:email=>active&&email===user.email?user:null,cleanRow_:r=>r,
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>k==='REMINDERS_ENABLED'?'true':null})},isValidPeriod_:()=>true,periodLabel_:p=>p,openPeriod_:()=> '2026-08',
 MailApp:{sendEmail:m=>mails.push(m)},ScriptApp:{getService:()=>({getUrl:()=>''})},newId_:()=> 'notification',nowIso_:()=> '2026-09-11',appendRows_:()=>{},readTable_:()=>[]};
vm.createContext(sandbox);
for (const file of ['Playbook.gs','Reminders.gs']) vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../app',file),'utf8'),sandbox);
const block = id=>({metricId:'m',blockId:id,situation:'recover',scopeUnitId:id,scopeType:units[id].unitType,steps:[id==='s'?'SECRET-SOUTH':'allowed']});
sandbox.playbookDocId_=()=> 'SECRET-DOC';sandbox.playbookEnsureFresh_=()=>{};sandbox.playbookHealthRow_=()=>({docId:'SECRET-DOC',docName:'SECRET-NAME',docUrl:'SECRET-URL',problemsJson:JSON.stringify([{heading:'SECRET-HEADING',sectionKey:'m|s'}])});sandbox.guidanceRows_=()=>[block('ORG-ROOT'),block('n'),block('s')];
assert.equal(sandbox.isPlaybookMaintainer_(user),false);
assert.throws(()=>sandbox.requirePlaybookMaintainer_(user),/E_FORBIDDEN/);
const board=sandbox.playbookBoard_(user);
assert.equal(JSON.stringify(board).includes('SECRET'),false);
assert.equal(board.sections[0].blocks.length,2);
assert.equal(board.doc,null);assert.equal(board.health,null);assert.equal(board.unattachedProblems.length,0);
const admin={...user,scopes:[{scopeId:'ORG-ROOT',status:'active'}],scopeSites:['North Site','South Site']};assert.equal(sandbox.isPlaybookMaintainer_(admin),true);
units.nd={unitType:'department',name:'North Department',parentUnitId:'n'};
units.sd={unitType:'department',name:'South Department',parentUnitId:'s'};
units.orphan={unitType:'department',name:'Orphan',parentUnitId:'missing'};
units.invalid={unitType:'invalid',name:'Invalid',parentUnitId:'n'};
units.cycle={unitType:'department',name:'Cycle',parentUnitId:'cycle'};
const southUser={...user,scopes:[{scopeId:'south',status:'active'}],scopeSites:['South Site']};
assert.equal(sandbox.playbookVisibleBlock_(user,block('nd'),units),true);
assert.equal(sandbox.playbookVisibleBlock_(admin,block('nd'),units),true);
assert.equal(sandbox.playbookVisibleBlock_(southUser,block('nd'),units),false);
assert.equal(sandbox.playbookVisibleBlock_(user,block('sd'),units),false);
assert.equal(sandbox.playbookVisibleBlock_(southUser,block('sd'),units),true);
assert.equal(sandbox.playbookVisibleBlock_(admin,block('sd'),units),true);
assert.equal(sandbox.playbookVisibleBlock_(user,block('north'),units),true);
assert.equal(sandbox.playbookVisibleBlock_(user,block('ORG-ROOT'),units),true);
assert.equal(sandbox.playbookVisibleBlock_(user,block('south'),units),false);
for (const caller of [user,admin]) {
 for (const scopeUnitId of ['missing','orphan','invalid','cycle','constructor','']) {
  assert.equal(sandbox.playbookVisibleBlock_(caller,{scopeUnitId},units),false);
 }
 assert.equal(sandbox.playbookVisibleBlock_(caller,null,units),false);
 assert.equal(sandbox.playbookVisibleBlock_(caller,block('nd'),null),false);
}
sandbox.guidanceRows_=()=>['ORG-ROOT','north','n','nd','south','s','sd','orphan','invalid','cycle'].map(block);
assert.deepEqual(Array.from(sandbox.playbookBoard_(user).sections[0].blocks,b=>b.blockId).sort(),['ORG-ROOT','n','nd','north'].sort());
assert.deepEqual(Array.from(sandbox.playbookBoard_(southUser).sections[0].blocks,b=>b.blockId).sort(),['ORG-ROOT','s','sd','south'].sort());
assert.deepEqual(Array.from(sandbox.playbookBoard_(admin).sections[0].blocks,b=>b.blockId).sort(),['ORG-ROOT','north','n','nd','south','s','sd'].sort());
sandbox.dataDueOutstanding_=()=>[{goalId:'north',site:'North Site',recipient:user.email},{goalId:'SECRET-GOAL',site:'South Site',recipient:'SECRET-EMAIL'}];
assert.equal(JSON.stringify(sandbox.previewDataDueReminders_(user,{period:'2026-08'})).includes('SECRET'),false);
assert.equal(sandbox.reminderRecipientAllowed_({recipient:user.email,site:'North Site'}),true);
assert.equal(sandbox.reminderRecipientAllowed_({recipient:user.email,site:'South Site'}),false);
assert.equal(sandbox.reminderRecipientAllowed_({recipient:'external@example.net',site:'North Site'}),false);
active=false;assert.equal(sandbox.reminderRecipientAllowed_({recipient:user.email,site:'North Site'}),false);
sandbox.sendDataDueRound_('2026-08',{type:'data-due-1'},new Date());assert.equal(mails.length,0);
sandbox.situationOfStatus_=()=> 'recover';sandbox.resolveGuidanceBlocks_=()=>({missing:true,blocks:[]});sandbox.guidanceChainForGoal_=()=>[];
assert.equal(sandbox.guidanceForGoal_({}, {}, {user}).docUrl,'');
assert.equal(sandbox.guidanceForGoal_({}, {}, {}).docName,'');
assert.equal(sandbox.guidanceForGoal_({}, {}, {user:admin}).docUrl,'SECRET-URL');
assert.equal(typeof sandbox.runPlaybookCheck,'undefined');assert.equal(typeof sandbox.runDataDueReminders,'undefined');
console.log('PASS security-content: scoped JSON, maintainer boundary, recipient revocation, private handlers');
