'use strict';
const assert=require('node:assert/strict'), harness=require('./recovery-harness');
let passed=0;
function test(name,fn) {fn();passed++;console.log('PASS '+name);}
function environment() {
  const h=harness();h.load(['GuidanceSnapshots','RecoveryAdmin']);Object.entries(h.c.GUIDANCE_SNAPSHOT_SCHEMA_).forEach(([n,headers])=>h.table(n,headers));
  const props={DEPLOYMENT_ACCOUNT_EMAIL:'installer@example.test',WORKSPACE_DOMAIN:'example.test',SCHEMA_VERSION:'1',BACKUP_FOLDER_ID:'folder-private',BACKUP_FILE_ID:'backup-file',RESTORE_SPREADSHEET_ID:'restore-target',CUSTOMER_NAME:'Synthetic',OTHER_PRIVATE_SETTING:'must not export'};
  let actor='installer@example.test', effective=actor, targetWrites=0, failAt=0, after=false, fileCounter=0;
  const source={getId:()=> 'source-book',getSheetByName:n=>h.state.tables[n]||null};
  const files={}, permissions={}, receipts=[];
  function blob(text) {return{getBytes:()=>Array.from(Buffer.from(text)),getDataAsString:()=>text};}
  function file(id,text) {files[id]={getId:()=>id,getUrl:()=> 'https://example.test/'+id,getSize:()=>Buffer.byteLength(text),getBlob:()=>blob(text)};return files[id];}
  class Sheet {
    constructor(name) {this.name=name;this.rows=[];this.maxRows=1000;this.maxColumns=26;}
    getLastRow(){return this.rows.length;}
    getMaxRows(){return this.maxRows;}getMaxColumns(){return this.maxColumns;}
    insertRowsAfter(n,count){this.maxRows+=count;}insertColumnsAfter(n,count){this.maxColumns+=count;}
    getRange(r,c,n,m){return{setNumberFormat:()=>{},setValues:values=>{
      targetWrites++;if(failAt===targetWrites&&!after)throw Error('before persistence');
      values.forEach((row,i)=>{this.rows[r-1+i]||=[];row.forEach((value,j)=>{this.rows[r-1+i][c-1+j]=typeof value==='string'&&/^'[=+\-@]/.test(value)?value.slice(1):value;});});
      if(failAt===targetWrites&&after)throw Error('lost acknowledgment');
    }};}
    getDataRange(){return{getValues:()=>this.rows.map(row=>row.slice())};}
  }
  const tabs={Sheet1:new Sheet('Sheet1')},target={getId:()=> 'restore-target',getName:()=> 'PLUMB RESTORE TEST',getUrl:()=> 'https://example.test/restore-target',getSheets:()=>Object.values(tabs),getSheetByName:n=>tabs[n]||null,insertSheet:n=>{if(tabs[n])throw Error('exists');return tabs[n]=new Sheet(n);}};
  h.c.SHEETS=Object.keys(h.state.tables).map(name=>({name,headers:h.state.tables[name].rows[0].slice()}));
  Object.assign(h.c,{normalizeEmail_:s=>String(s||'').trim().toLowerCase(),internalEmail_:s=>s.endsWith('@example.test'),currentEmail_:()=>actor,Session:{getEffectiveUser:()=>({getEmail:()=>effective})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>props[k]=v})},ss_:()=>source,
    ScriptApp:{getOAuthToken:()=> 'noncredential-test-substitute'},
    UrlFetchApp:{fetch:url=>{const id=decodeURIComponent(url.split('/files/')[1].split('/permissions')[0]);receipts.push(id);const data=permissions[id]||{permissions:[{type:'user',role:'owner',emailAddress:'installer@example.test'}]};return{getResponseCode:()=>data.code||200,getContentText:()=>JSON.stringify(data)};}},
    DriveApp:{getFolderById:()=>({createFile:content=>file('backup-'+(++fileCounter),content.getDataAsString())}),getFileById:id=>{if(!files[id])throw Error('no file');return files[id];}},
    SpreadsheetApp:{openById:id=>{assert.equal(id,'restore-target');return target;}}
  });
  h.c.Utilities.newBlob=blob;
  h.c.appendRow_('Items',{id:'item-1',value:'=literal text'});
  return {...h,props,files,permissions,receipts,tabs,target,file,setActor:value=>{actor=value;},setEffective:value=>{effective=value;},writes:()=>targetWrites,fail:(n,phaseAfter)=>{failAt=n;after=phaseAfter;}};
}
function exportThenRestore(h) {const result=h.c.recoveryExportConfigured_();h.props.BACKUP_FILE_ID=result.fileId;return h.c.recoveryRestoreConfigured_();}
test('configured installer exports read-back-verified versioned logical package only',()=>{
  const h=environment(),result=h.c.recoveryExportConfigured_(),package_=JSON.parse(h.files[result.fileId].getBlob().getDataAsString());
  assert.equal(result.exported,true);assert.equal(result.logicalOnly,true);assert.equal(package_.body.config.OTHER_PRIVATE_SETTING,undefined);assert.equal(package_.body.releaseVersion,'0.1.0');assert.equal(package_.body.templateVersion,'1');assert.equal(package_.body.codeArtifactIncluded,false);assert.equal(h.receipts.filter(id=>id==='folder-private').length,2);
});
test('restore writes an isolated empty workbook and never changes source configuration',()=>{
  const h=environment(),before=JSON.stringify(h.props),result=exportThenRestore(h);
  assert.equal(result.activated,false);assert.equal(result.manualActivationRequired,true);assert.equal(h.tabs.Items.rows[1][1],'=literal text');
  const control=Object.fromEntries(h.tabs._RestoreControl.rows.slice(1));assert.equal(control.RESTORE_STATE,'AWAITING_ADMIN_REVIEW');assert.equal(control.REMINDERS_ENABLED,'false');assert.equal(control.ENVIRONMENT,'TEST');
  assert.equal(h.props.SCHEMA_VERSION,'1');assert.equal(h.props.ENVIRONMENT,undefined);assert.equal(h.rows('Items')[0].value,'=literal text');assert.ok(before.includes('Synthetic'));
});
test('unknown or impersonated installer is denied before Drive access',()=>{
  const h=environment();h.setActor('other@example.test');assert.throws(()=>h.c.recoveryExportConfigured_(),/E_FORBIDDEN/);assert.equal(h.receipts.length,0);
  h.setActor('installer@example.test');h.setEffective('other@example.test');assert.throws(()=>h.c.recoveryExportConfigured_(),/E_FORBIDDEN/);assert.equal(h.receipts.length,0);
});
test('group, public, unknown and incomplete permission lists are rejected before export',()=>{
  for(const acl of [{permissions:[{type:'group',role:'reader'}]},{permissions:[{type:'anyone',role:'reader'}]},{permissions:[]},{permissions:[{type:'user',role:'owner',emailAddress:'installer@example.test'}],nextPageToken:'more'},{code:403}]){
    const h=environment();h.permissions['folder-private']=acl;assert.throws(()=>h.c.recoveryExportConfigured_(),/E_FORBIDDEN/);assert.equal(Object.keys(h.files).length,0);
  }
});
test('restore refuses current source, nonempty workbook and wrong target name',()=>{
  const h=environment(),exp=h.c.recoveryExportConfigured_();assert.throws(()=>h.c.recoveryRestore_(exp.fileId,'source-book'),/current datastore/);
  h.target.getName=()=> 'Production';assert.throws(()=>h.c.recoveryRestore_(exp.fileId,'restore-target'),/name the empty/i);h.target.getName=()=> 'PLUMB RESTORE TEST';h.tabs.Sheet1.rows=[['occupied']];assert.throws(()=>h.c.recoveryRestore_(exp.fileId,'restore-target'),/empty/);assert.equal(h.writes(),0);
});
const baseline=environment();exportThenRestore(baseline);const boundaries=baseline.writes();
for(const after of [false,true])for(let boundary=1;boundary<=boundaries;boundary++)test(`isolated restore ${after?'lost acknowledgment':'before write'} ${boundary}/${boundaries} never activates or changes source`,()=>{
  const h=environment(),exp=h.c.recoveryExportConfigured_();h.fail(boundary,after);assert.throws(()=>h.c.recoveryRestore_(exp.fileId,'restore-target'));
  assert.equal(h.props.ENVIRONMENT,undefined);assert.equal(h.rows('Items').length,1);assert.equal(h.rows('Items')[0].value,'=literal text');
  const control=Object.fromEntries((h.tabs._RestoreControl?.rows||[]).slice(1));assert.notEqual(control.RESTORE_STATE,'LIVE');assert.notEqual(control.REMINDERS_ENABLED,'true');
});
test('interrupted unserved snapshot staging does not prevent a coherent backup',()=>{
  const h=environment(),doc='doc-1',health={docId:doc,status:'healthy',lastCheckedAt:'old'},block={blockId:'a',sourceDocId:doc,stepsJson:'["old"]'};
  const first=h.c.playbookSnapshotPublish_(doc,'',[block],health);h.state.failAt=h.state.writes+2;assert.throws(()=>h.c.playbookSnapshotPublish_(doc,first.generationId,[{...block,stepsJson:'["new"]'}],{...health,lastCheckedAt:'new'}));h.state.failAt=0;
  assert.equal(h.rows('GuidanceSnapshots').length,2);const exp=h.c.recoveryExportConfigured_(),pkg=JSON.parse(h.files[exp.fileId].getBlob().getDataAsString());
  assert.equal(pkg.body.tables.GuidanceSnapshots.length,1);assert.equal(pkg.body.tables.PlaybookSnapshots.length,1);assert.equal(pkg.body.tables.PlaybookPointers[0].generationId,first.generationId);assert.equal(h.rows('GuidanceSnapshots').length,2);
});
test('active snapshot corruption blocks backup rather than silently deleting served guidance',()=>{
  const h=environment(),doc='doc-1';h.c.playbookSnapshotPublish_(doc,'',[{blockId:'a',sourceDocId:doc,stepsJson:'["old"]'}],{docId:doc,status:'healthy',lastCheckedAt:'old'});
  const row=h.rows('GuidanceSnapshots')[0];row.contentJson='{}';h.c.writeRowAt_('GuidanceSnapshots',row._row,row);assert.throws(()=>h.c.recoveryExportConfigured_(),/active guidance snapshot/);assert.equal(Object.keys(h.files).length,0);
});
test('restored backup corruption is rejected before any target mutation',()=>{
  const h=environment(),exp=h.c.recoveryExportConfigured_(),package_=JSON.parse(h.files[exp.fileId].getBlob().getDataAsString());package_.body.tables.Items[0].value='changed';h.file('corrupt-file',JSON.stringify(package_));assert.throws(()=>h.c.recoveryRestore_('corrupt-file','restore-target'),/integrity/);assert.equal(h.writes(),0);
});
test('restore refuses other declared code/template versions without a migration',()=>{
  const h=environment(),exp=h.c.recoveryExportConfigured_(),package_=JSON.parse(h.files[exp.fileId].getBlob().getDataAsString());package_.body.releaseVersion='99.0.0';package_.hash=h.c.operationHash_(package_.body);h.file('future-file',JSON.stringify(package_));assert.throws(()=>h.c.recoveryRestore_('future-file','restore-target'),/code\/template/);assert.equal(h.writes(),0);
});
console.log(`Recovery administrator: ${passed} passed.`);
