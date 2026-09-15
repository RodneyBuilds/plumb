'use strict';
// Fresh simulated Google runtime for adversarial boundary tests.
module.exports = function () {
var fs = require('fs'), path = require('path'), vm = require('vm');
var APP = path.join(__dirname, '..', 'app'), pass = 0, fail = 0, failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function Sheet(name) { this.name = name; this._v = []; }
Sheet.prototype.getName = function () { return this.name; }; Sheet.prototype.getLastRow = function () { return this._v.length; }; Sheet.prototype.getLastColumn = function () { return this._v.reduce(function (n,r) { return Math.max(n,r.length); },0); };
Sheet.prototype.getMaxRows = function () { return Math.max(1000,this._v.length); };
function Range(sheet,row,col,rows,cols) { this.s=sheet; this.r=row; this.c=col; this.nr=rows; this.nc=cols; }
Range.prototype.setNumberFormat = function (format) { if (format !== '@') { throw new Error('unexpected number format'); } return this; };
Range.prototype.getValues = function () { var out=[]; for(var i=0;i<this.nr;i++){var line=[],src=this.s._v[this.r-1+i]||[];for(var j=0;j<this.nc;j++){line.push(src[this.c-1+j]===undefined?'':src[this.c-1+j]);}out.push(line);}return out; };
/* Every setValues is counted per tab, so "the whole month leaves as one write"
   can be asserted rather than assumed. */
var WRITES = {};
Range.prototype.setValues = function (values) { WRITES[this.s.name]=(WRITES[this.s.name]||0)+1; for(var i=0;i<values.length;i++){var ri=this.r-1+i;while(this.s._v.length<=ri)this.s._v.push([]);for(var j=0;j<values[i].length;j++)this.s._v[ri][this.c-1+j]=values[i][j];}return this; };
Sheet.prototype.getDataRange = function () { var rows=this._v.length||1,cols=this.getLastColumn()||1;return new Range(this,1,1,rows,cols); }; Sheet.prototype.getRange=function(r,c,nr,nc){return new Range(this,r,c,nr,nc);}; Sheet.prototype.setFrozenRows=function(){}; Sheet.prototype.deleteRow=function(r){this._v.splice(r-1,1);};
function Book(){this.sheets={};this.order=[];} Book.prototype.getId=function(){return'test-book';}; Book.prototype.getName=function(){return'Intake Workspace TEST';}; Book.prototype.getSheetByName=function(n){return this.sheets[n]||null;}; Book.prototype.insertSheet=function(n){var s=new Sheet(n);this.sheets[n]=s;this.order.push(n);return s;};
var book=new Book(), email='admin@example.org', scriptProps={ENVIRONMENT:'TEST',DEMO_MODE:'true',WORKSPACE_DOMAIN:'example.org',DEPLOYMENT_ACCOUNT_EMAIL:'admin@example.org'}, userProps={}, cache={}, locks=0, sentMail=[], triggers=[];
function props(store){return{getProperty:function(k){return store[k]||null;},setProperty:function(k,v){store[k]=String(v);return this;}};}
/* The Doc clock is the test's, so the on-read freshness check can be proved
   rather than assumed: nothing moves unless the test moves it. */
var docClock = new Date('2026-08-14T09:00:00.000Z').getTime();
/* Every touch of the fake Doc moves its modified time, the way a real edit
   does. Without that the on-read freshness short-circuit would look like it
   worked simply because nothing ever changed. */
function docNow(){docClock+=1000;return new Date(docClock).toISOString();}
var GAS=require('./gas-doc-fakes.js').build({now:docNow,ownerEmail:'admin@example.org'});
var sandbox={console:console,Math:Math,Date:Date,JSON:JSON,Object:Object,Array:Array,String:String,Number:Number,Boolean:Boolean,isFinite:isFinite,Set:Set,encodeURIComponent:encodeURIComponent,decodeURIComponent:decodeURIComponent,
  DocumentApp:GAS.DocumentApp,DriveApp:GAS.DriveApp,UrlFetchApp:GAS.UrlFetchApp,
  SpreadsheetApp:{getActiveSpreadsheet:function(){return book;},openById:function(){return book;}},
  Utilities:{getUuid:require('crypto').randomUUID,DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:function(algorithm,text){return Array.from(require('crypto').createHash(algorithm).update(text).digest());}},
  Session:{getEffectiveUser:function(){return{getEmail:function(){return 'admin@example.org';}};},getActiveUser:function(){return{getEmail:function(){return email;}};}},
  PropertiesService:{getScriptProperties:function(){return props(scriptProps);},getUserProperties:function(){return props(userProps);}},
  CacheService:{getScriptCache:function(){return{get:function(k){return cache[k]||null;},put:function(k,v){cache[k]=v;}};}},
  LockService:{getScriptLock:function(){return{waitLock:function(){locks++;},releaseLock:function(){}};}},
  MailApp:{sendEmail:function(options){sentMail.push(options);}},
  ScriptApp:{
    getService:function(){return{getUrl:function(){return 'https://script.google.com/a/test/exec';}};},
    getProjectTriggers:function(){return triggers.slice();},
    deleteTrigger:function(target){triggers=triggers.filter(function(item){return item!==target;});},
    newTrigger:function(handler){var b={timeBased:function(){return b;},atHour:function(){return b;},everyDays:function(){return b;},everyHours:function(){return b;},create:function(){triggers.push({getHandlerFunction:function(){return handler;}});}};return b;},
    getOAuthToken:function(){return 'fake-oauth-token';}
  },
  HtmlService:{createTemplateFromFile:function(){return{evaluate:function(){return this;},setTitle:function(){return this;},addMetaTag:function(){return this;},setSandboxMode:function(){return this;}};},createHtmlOutputFromFile:function(){return{getContent:function(){return'';}};},SandboxMode:{IFRAME:'IFRAME'}}
};
vm.createContext(sandbox); ['Logic','Operations','Outbox','Backup','GuidanceSnapshots','RecoveryAdmin','Sheets','Rbac','AccessModel','Auth','Performance','Playbook','Reminders','Setup','Intake','Code'].forEach(function(n){vm.runInContext(fs.readFileSync(path.join(APP,n+'.gs'),'utf8'),sandbox,{filename:n+'.gs'});});
// Model a client opening a new command; explicit keys are preserved for retry tests.
function call(action,payload){payload=Object.assign({},payload||{});if (/^(metric|goal|actual)\.(save|retire|correct|saveMonth)$/.test(action)&&!payload.submissionKey)payload.submissionKey=require('crypto').randomUUID();if(action==='site.save'&&payload.item&&!payload.item.submissionKey)payload.item=Object.assign({submissionKey:require('crypto').randomUUID()},payload.item);return sandbox.api({action:action,payload:payload});} function switchUser(next){email=next;cache={};}
function rows(name){return sandbox.readTable_(name);}


return { sandbox: sandbox, props: scriptProps, book: book, writes: WRITES, call: call, rows: rows, switchUser: switchUser, setup: function () { sandbox.setupWorkspace_(); sandbox.seedTestData_(); } };
};
