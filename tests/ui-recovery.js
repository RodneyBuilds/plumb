'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const context=vm.createContext({console,Promise,Math,Date,JSON,Object,Array,String,Number,setTimeout,clearTimeout,
  document:{addEventListener:()=>{},getElementById:()=>null}});
for(const name of ['ClientJs','ImproveUi']) {
  let source=fs.readFileSync(path.join(__dirname,'../app',name+'.html'),'utf8').replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,'');
  if(name==='ClientJs')source=source.replace(/\nstart\(\);\s*$/,'\n');
  vm.runInContext(source,context,{filename:name+'.html'});
}
(async()=>{
  let count=0;
  assert.equal(context.friendly({error:'E_RECOVERY: this save needs administrator review.'}),'this save needs administrator review.');count++;
  const html=context.deliveryStatusHtml_({UNKNOWN:1,PENDING:2,RETRYABLE:1,SENT:4});
  assert.match(html,/Delivery unconfirmed/);assert.match(html,/will not be resent automatically/);assert.match(html,/Queued or being processed<\/span><span>3/);count++;
  const areas={peopleArea:{innerHTML:''},sitesArea:{innerHTML:''}};
  context.document.getElementById=id=>areas[id] || null;
  context.ADMIN={people:[{name:'Test staff',email:'staff@example.org',roleName:'Site',active:true,pending:true}],sites:[]};
  context.renderAdminLists_();assert.match(areas.peopleArea.innerHTML,/Recovery required/);assert.match(areas.peopleArea.innerHTML,/disabled onclick="openPersonForm/);count++;
  for(const [state,sent,pattern] of [['UNKNOWN',false,/may have been sent/],['RETRYABLE',false,/queued/],['SENDING',false,/not yet confirmed/],['CANCELLED',false,/cancelled/],['FAILED',false,/administrator/],['SENT',true,/Google accepted/]]) {
    let message='',requests=0;
    context.run=()=>{requests++;return Promise.resolve({ok:true,reminded:{state,sent,recipient:'staff@example.org'}});};
    context.toast=value=>{message=value;};context.perfSetMain=()=>{};context.improvePlaybookHtml=()=>'';
    context.improveRemindEditor();await Promise.resolve();
    assert.match(message,pattern);assert.equal(requests,1);count++;
  }
  let failure;
  const bridge={withSuccessHandler:()=>bridge,withFailureHandler:fn=>{failure=fn;return bridge;},api:()=>failure({message:'PRIVATE GOOGLE DETAILS'})};
  context.google={script:{run:bridge}};
  const result=await context.runOnce_('intake.save',{});assert.equal(result.code,'E_NETWORK');assert.ok(!result.error.includes('PRIVATE'));count++;
  console.log(`UI recovery: ${count} passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
