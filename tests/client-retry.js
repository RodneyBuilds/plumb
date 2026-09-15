'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const create=require('./security-harness');
const source=fs.readFileSync(path.join(__dirname,'../app/ClientJs.html'),'utf8').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,'').replace(/\nstart\(\);\s*$/,'\n');
(async()=>{
  const h=create();h.setup();
  const c=vm.createContext({console,Promise,Math,Date,JSON,Object,Array,String,Number,setTimeout,clearTimeout,document:{addEventListener:()=>{},getElementById:()=>null}});
  vm.runInContext(source,c);
  c.netStart_=()=>{};c.netEnd_=()=>{};let banners=0,requests=0;
  c.showPendingMutation_=()=>{banners++;};
  c.runOnce_=(action,payload)=>{requests++;return Promise.resolve(h.call(action,JSON.parse(JSON.stringify(payload))));};
  c.closeDialog=()=>{};c.toast=()=>{};c.openIntake=()=>{};c.go=()=>{};
  const append=h.sandbox.appendRow_;let fail=true;
  h.sandbox.appendRow_=function(table,row){if(table==='IntakeHistory'&&fail){fail=false;throw Error('injected after request row');}return append(table,row);};
  const payload={submissionKey:'preserve-command',title:'Original title',site:'Harbor North',description:'Original description'};
  const first=await c.run('intake.save',payload);assert.equal(first.ok,false);assert.ok(banners);
  payload.title='Later unsent title';
  const blocked=await c.run('intake.save',payload);assert.equal(blocked.code,'E_RECOVERY');assert.equal(requests,1);
  assert.equal(c.PENDING_MUTATION.payload.title,'Original title');
  const retry=await c.retryPendingMutation_();assert.equal(retry.ok,true);assert.equal(retry.item.title,'Original title');
  assert.equal(c.PENDING_MUTATION,null);assert.equal(h.rows('Intake').filter(row=>row.submissionKey==='preserve-command').length,1);
  assert.equal(h.rows('IntakeHistory').filter(row=>row.intakeId===retry.item.id).length,1);
  // Validation fails before persistence and does not strand a client-side command.
  const invalid=await c.run('intake.save',{submissionKey:'invalid-command',title:'',site:'Harbor North',description:'description'});
  assert.equal(invalid.code,'E_VALIDATION');assert.equal(c.PENDING_MUTATION,null);
  console.log('Client retry: original payload survives edits, safe retry completes history, prevalidation permits correction');
})().catch(error=>{console.error(error);process.exitCode=1;});
