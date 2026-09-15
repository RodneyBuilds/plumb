'use strict';
/**
 * Integration: the real server files running against an in-memory Sheets.
 * Exercises provisioning, access, intake, performance, and guidance with simulated Google services.
 */
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

console.log('\nSetup and package scope');
var setup=sandbox.setupWorkspace_(); check('setup creates exactly 23 managed tables',setup.managedSheets===23&&book.order.length===23,String(book.order.length)); sandbox.setupWorkspace_(); check('setup is idempotent',book.order.length===23);
check('the 4 performance tables exist',['Metrics','Goals','Actuals','NotificationLog'].every(function(name){return !!book.getSheetByName(name);}));
check('the 3 Guidance tables exist',['GuidanceBlocks','PlaybookHealth','Actions'].every(function(name){return !!book.getSheetByName(name);}));
check('the 3 performance permissions are seeded',['performance.enter','performance.goal.manage','performance.metric.manage'].every(function(key){return !!sandbox.findRow_('Permissions','permissionKey',key);}));
check('the 3 Guidance permissions are seeded',['playbook.manage','improvement.action.manage','improvement.action.own'].every(function(key){return !!sandbox.findRow_('Permissions','permissionKey',key);}));
check('the department level is designed into the goal table',sandbox.headersOf_('Goals').indexOf('departmentUnitId')!==-1);
var seed=sandbox.seedTestData_(); check('TEST seed creates neutral sites and users',seed.sites===5&&seed.users===3&&seed.intake===1,JSON.stringify(seed)); check('former routes are absent',call('pipeline.list',{}).code==='E_NOT_FOUND'&&call('diagnostic.options',{}).code==='E_NOT_FOUND'&&call('report.model',{}).code==='E_NOT_FOUND');
check('TEST seed creates metrics, goals and reported numbers',seed.metrics===6&&seed.goals===8&&seed.actuals>30,JSON.stringify(seed));

console.log('\nRole journeys and isolation');
switchUser('admin@example.org'); var admin=call('bootstrap'); check('admin gets Intake and Admin',admin.nav.some(function(x){return x.id==='intake';})&&admin.nav.some(function(x){return x.id==='admin';}));
check('admin gets every performance surface',['performance','entry','rollup','goals','metrics'].every(function(id){return admin.nav.some(function(x){return x.id===id;});}),JSON.stringify(admin.nav.map(function(x){return x.id;})));
switchUser('regional@example.org'); var regional=call('bootstrap'); check('regional gets Intake management without Admin',regional.canManageIntake&&!regional.nav.some(function(x){return x.id==='admin';})); check('regional sees North request',call('intake.list',{}).items.length===1);
check('regional may manage goals but not metrics',regional.nav.some(function(x){return x.id==='goals';})&&!regional.nav.some(function(x){return x.id==='metrics';}));
check('regional gets the rollup, covering 3 sites',regional.nav.some(function(x){return x.id==='rollup';}));
switchUser('site@example.org'); var site=call('bootstrap'); check('site can create but cannot manage',site.canCreateIntake&&!site.canManageIntake); check('site sees own-site request',call('intake.list',{}).items.length===1); check('site cannot skip to triage',call('intake.transition',{id:call('intake.list',{}).items[0].id,version:1,status:'Triaged'}).code==='E_FORBIDDEN');
check('site staff may enter numbers but not set goals',site.nav.some(function(x){return x.id==='entry';})&&!site.nav.some(function(x){return x.id==='goals';}));
check('site staff get no rollup, having only 1 site',!site.nav.some(function(x){return x.id==='rollup';}));
check('site staff cannot reach the goal wizard through the API',call('goal.save',{metricId:'metric-clients-served',site:'Harbor North',goalKind:'period',target:10,owner:'X'}).code==='E_FORBIDDEN');
check('site staff cannot define metrics',call('metric.save',{name:'Sneaky',metricType:'count',direction:'higher'}).code==='E_FORBIDDEN');
switchUser('viewer@example.org'); var viewer=call('bootstrap'); check('viewer has no Intake navigation',!viewer.nav.some(function(x){return x.id==='intake';})); check('viewer Intake API is denied',call('intake.list',{}).code==='E_FORBIDDEN');
check('viewer gains no performance surface',!viewer.nav.some(function(x){return ['performance','entry','rollup','goals','metrics'].indexOf(x.id)!==-1;}));
check('viewer performance API is denied',call('performance.board',{}).code==='E_FORBIDDEN'&&call('performance.entry',{}).code==='E_FORBIDDEN');
switchUser('unknown@example.org'); check('unknown account is blocked',call('bootstrap').user.known===false&&call('intake.list',{}).code==='E_FORBIDDEN');

console.log('\nIdempotency and stale-write protection');
switchUser('admin@example.org'); var payload={submissionKey:'retry-proof-key',title:'Concurrent test',requestType:'Program support',site:'Harbor North',description:'Verify repeated submissions and stale edits.',priority:'Normal'};
var first=call('intake.save',payload), second=call('intake.save',payload); check('retry returns the same request',first.ok&&second.ok&&second.duplicate&&first.item.id===second.item.id); check('retry creates only 1 stored row',rows('Intake').filter(function(r){return r.submissionKey==='retry-proof-key';}).length===1);
var version=first.item.version, edit1=call('intake.save',{id:first.item.id,version:version,title:'First editor wins',requestType:first.item.requestType,site:first.item.site,description:first.item.description,priority:first.item.priority}), edit2=call('intake.save',{id:first.item.id,version:version,title:'Stale editor overwrites',requestType:first.item.requestType,site:first.item.site,description:first.item.description,priority:first.item.priority});
check('first versioned edit succeeds',edit1.ok&&edit1.item.version===version+1); check('stale edit returns E_CONFLICT',edit2.code==='E_CONFLICT'); check('stored title was not overwritten',sandbox.findRow_('Intake','id',first.item.id).title==='First editor wins');
var ids={},numbers={},unique=true; for(var i=0;i<25;i++){var made=call('intake.save',{submissionKey:'load-'+i,title:'Load '+i,requestType:'Other',site:'Harbor North',description:'Load test record '+i,priority:'Low'});if(!made.ok||ids[made.item.id]||numbers[made.item.requestNumber])unique=false;ids[made.item.id]=1;numbers[made.item.requestNumber]=1;}
check('25 rapid creates have unique ids and request numbers',unique&&Object.keys(ids).length===25&&Object.keys(numbers).length===25); check('mutations acquired the script lock',locks>=29);

console.log('\nConcurrency back-pressure');
var PERIOD=sandbox.openPeriod_();
var origGetLock=sandbox.LockService.getScriptLock;
sandbox.LockService.getScriptLock=function(){return{waitLock:function(){throw new Error('Timeout waiting for lock.');},releaseLock:function(){}};};
var busy=call('intake.save',{submissionKey:'busy-key',title:'Busy save',requestType:'Other',site:'Harbor North',description:'Lock is contended under load.',priority:'Low'});
check('a contended lock surfaces as retryable E_BUSY, not E_INTERNAL',!busy.ok&&busy.code==='E_BUSY');
var busyMonth=call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:'busy-month',entries:[]});
check('a contended month save is also retryable',!busyMonth.ok&&busyMonth.code==='E_BUSY',JSON.stringify(busyMonth));
sandbox.LockService.getScriptLock=origGetLock;
check('a busy save writes no row',rows('Intake').filter(function(r){return r.submissionKey==='busy-key';}).length===0);
check('a busy month save writes no row',rows('Actuals').filter(function(r){return String(r.submissionKey).indexOf('busy-month')===0;}).length===0);

/* ======================= performance layer ======================= */

function goalRow(id){return sandbox.findRow_('Goals','goalId',id);}
function actualsFor(id){return rows('Actuals').filter(function(r){return String(r.goalId)===id;});}
function boardItem(board,id){return board.items.filter(function(x){return x.goalId===id;})[0];}

console.log('\nPerformance setup: the metric library');
switchUser('admin@example.org');
var metrics=call('metric.list',{}); check('the metric library lists every metric',metrics.ok&&metrics.items.length===6,String(metrics.items&&metrics.items.length));
check('a percentage metric names both of its numbers',metrics.items.filter(function(m){return m.metricType==='percentage';}).every(function(m){return m.numeratorLabel&&m.denominatorLabel;}));
check('the library reports how many goals use each metric',metrics.items.filter(function(m){return m.metricId==='metric-housing-screen';})[0].goalCount===3);
var newMetric=call('metric.save',{name:'Referrals accepted',metricType:'percentage',direction:'higher',numeratorLabel:'Referrals accepted',denominatorLabel:'Referrals received'});
check('a new percentage metric can be created',newMetric.ok&&newMetric.created,JSON.stringify(newMetric));
check('a percentage metric without both part names is refused',call('metric.save',{name:'Half defined',metricType:'percentage',direction:'higher',numeratorLabel:'Only one'}).code==='E_VALIDATION');
check('a duplicate metric name is refused',call('metric.save',{name:'Clients served',metricType:'count',direction:'higher'}).code==='E_VALIDATION');
check('a metric type cannot change once it exists',call('metric.save',{metricId:'metric-clients-served',name:'Clients served',metricType:'percentage',direction:'higher',numeratorLabel:'a',denominatorLabel:'b'}).code==='E_VALIDATION');
var retired=call('metric.retire',{metricId:newMetric.item.metricId,updatedAt:newMetric.item.updatedAt});
check('a metric can be retired',retired.ok&&retired.item.active===false);
check('a retired metric cannot take a new goal',call('goal.save',{metricId:newMetric.item.metricId,site:'Harbor North',goalKind:'period',target:50,owner:'Someone'}).code==='E_VALIDATION');
check('retiring deletes nothing',!!sandbox.findRow_('Metrics','metricId',newMetric.item.metricId));

console.log('\nPerformance setup: goals in 3 kinds');
check('all 3 goal kinds are stored',goalRow('goal-north-served').goalKind==='period'&&goalRow('goal-north-days').goalKind==='journey'&&goalRow('goal-north-certified').goalKind==='hold');
check('only a journey stores a baseline and a target date',String(goalRow('goal-north-served').baseline)===''&&goalRow('goal-north-days').baseline===11.4&&!!goalRow('goal-north-days').targetDate);
check('a journey without dates is refused',call('goal.save',{metricId:'metric-clients-served',site:'Harbor Central',goalKind:'journey',baseline:10,target:20,owner:'Someone'}).code==='E_VALIDATION');
check('a period goal needs only a target',call('goal.save',{metricId:'metric-clients-served',site:'Harbor Central',goalKind:'period',target:20,owner:'Sample Administrator',ownerEmail:'admin@example.org'}).ok);
check('a second live goal for the same metric and site is refused',call('goal.save',{metricId:'metric-clients-served',site:'Harbor Central',goalKind:'period',target:30,owner:'Someone'}).code==='E_VALIDATION');
check('thresholds are stored per goal',goalRow('goal-north-certified').onTrackPace===0.98);
var goalList=call('goal.list',{});
check('every goal read carries its own thresholds, so they are never hidden in config',goalList.items.every(function(item){return typeof item.onTrackPace==='number'&&typeof item.atRiskPace==='number';}));
check('a goal cannot move between sites',call('goal.save',{goalId:'goal-north-served',version:goalRow('goal-north-served').version,metricId:'metric-clients-served',site:'Harbor Central',goalKind:'period',target:40,owner:'x'}).code==='E_VALIDATION');
check('a goal cannot change kind',call('goal.save',{goalId:'goal-north-served',version:goalRow('goal-north-served').version,metricId:'metric-clients-served',site:'Harbor North',goalKind:'hold',target:40,owner:'x'}).code==='E_VALIDATION');

console.log('\nThe dashboard, in 1 round trip');
var board=call('performance.board',{});
check('the board returns every in-scope goal at once',board.ok&&board.items.length>=8,String(board.items&&board.items.length));
check('every card carries a status, a trend and a 6-period trajectory',board.items.every(function(item){return !!item.result.status&&!!item.result.trend&&item.trajectory.length===6;}));
check('the counts match the cards',board.counts.onTrack+board.counts.attention+board.counts.unreported===board.counts.total&&board.counts.total===board.items.length);
check('the worst goals come first',board.items.length<2||board.items[0].result.status!=='On track');
check('the board states when entry closes',/^\d{4}-\d{2}-05$/.test(board.entryClosesOn),board.entryClosesOn);
switchUser('site@example.org');
var siteBoard=call('performance.board',{});
check('site staff see only their own site',siteBoard.items.every(function(item){return item.site==='Harbor North';}));
check('and their counts match what they can see',siteBoard.counts.total===siteBoard.items.length);
switchUser('regional@example.org');
var regionalBoard=call('performance.board',{});
check('regional staff see their whole region',regionalBoard.items.length>siteBoard.items.length);
check('and nothing outside it',regionalBoard.items.every(function(item){return ['Harbor North','Harbor East','Harbor West'].indexOf(item.site)!==-1;}));

console.log('\nStaleness, and last month never standing in for this month');
switchUser('admin@example.org');
board=call('performance.board',{});
var followUp=boardItem(board,'goal-north-followup');
check('a goal reported last month but not this month reads Not reported',followUp.result.status==='Not reported',followUp.result.status);
check('and is never On track',followUp.result.status!=='On track');
check('and says how long ago it was last reported',followUp.result.stale===1,String(followUp.result.stale));
check('a month nobody reported breaks the trajectory rather than bridging it',followUp.trajectory.filter(function(p){return p.value===null;}).length===2);
check('the trajectory records which months were reported at all',followUp.trajectory.filter(function(p){return !p.reported;}).length===2);

console.log('\nNo data is a real answer, and it is not zero');
var west=boardItem(board,'goal-west-screen');
check('a declared no-data month is marked as reported, not missing',west.trajectory.filter(function(p){return p.noData;}).length===1);
check('a no-data month carries no value',west.trajectory.filter(function(p){return p.noData;})[0].value===null);

console.log('\nCorrections append and never overwrite');
var served=actualsFor('goal-north-served');
check('the original and its correction both survive',served.filter(function(r){return r.actualId==='seed-correction-original';}).length===1&&served.filter(function(r){return r.supersedesActualId==='seed-correction-original';}).length===1);
var detail=call('goal.get',{goalId:'goal-north-served'});
check('goal detail shows every number ever reported',detail.ok&&detail.history.length===served.length,detail.history&&String(detail.history.length)+' vs '+served.length);
check('the superseded value is flagged with the reason it was replaced',detail.history.filter(function(h){return h.superseded;}).length===1&&/counted twice/.test(detail.history.filter(function(h){return h.superseded;})[0].replacedReason));
check('the superseded value is left out of the live trajectory',detail.item.trajectory.filter(function(p){return p.value===26;}).length===0);
var target=detail.history.filter(function(h){return !h.superseded&&!h.supersedesActualId&&!h.noData;})[0];
var correction=call('actual.correct',{actualId:target.actualId,value:99,numerator:'',denominator:'',correctionReason:'Data entry error: verified against the source system'});
check('a manager correction is accepted and recorded as approved',correction.ok&&correction.approved===true,JSON.stringify(correction));
check('the correction appends rather than overwriting',!!sandbox.findRow_('Actuals','actualId',target.actualId));
check('the same entry cannot be corrected twice',call('actual.correct',{actualId:target.actualId,value:98,correctionReason:'again'}).code==='E_CONFLICT');
check('a correction without a reason is refused',call('actual.correct',{actualId:correction.item.actualId,value:97,correctionReason:''}).code==='E_VALIDATION');
switchUser('site@example.org');
var oldEntry=call('goal.get',{goalId:'goal-north-screen'}).history.filter(function(h){return !h.superseded;})[0];
check('site staff cannot correct a number outside the 48 hour window',call('actual.correct',{actualId:oldEntry.actualId,numerator:1,denominator:2,correctionReason:'changed my mind'}).code==='E_FORBIDDEN');

console.log('\nOne month, one write, one lock');
switchUser('site@example.org');
var sheet=call('performance.entry',{});
check('the worksheet returns every goal for the site',sheet.ok&&sheet.items.length===6,String(sheet.items&&sheet.items.length));
check('the worksheet says what was reported last month',sheet.items.filter(function(item){return item.goalId==='goal-north-followup';})[0].previous!==null);
check('the worksheet ships what a live reading needs',sheet.items.every(function(item){return item.preview&&typeof item.preview.elapsed==='number';}));
WRITES.Actuals=0;
var monthKey='month-key-1';
var saveResult=call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:monthKey,entries:[{goalId:'goal-north-followup',numerator:41,denominator:53}]});
check('a month saves',saveResult.ok&&saveResult.saved===1,JSON.stringify(saveResult));
check('the whole month leaves as exactly 1 write to Actuals',WRITES.Actuals===1,String(WRITES.Actuals));
var repeat=call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:monthKey,entries:[{goalId:'goal-north-followup',numerator:41,denominator:53}]});
check('replaying the same submission key changes nothing',repeat.ok&&repeat.duplicate===true);
check('and creates no duplicate row',actualsFor('goal-north-followup').filter(function(r){return String(r.period)===PERIOD;}).length===1);
var unchanged=call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:'month-key-unchanged',entries:[{goalId:'goal-north-followup',numerator:41,denominator:53}]});
check('saving the same numbers again writes nothing',unchanged.ok&&unchanged.saved===0&&unchanged.skipped===1,JSON.stringify(unchanged));
check('a goal from another site is refused',call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:'month-cross',entries:[{goalId:'goal-east-screen',numerator:1,denominator:2}]}).code==='E_FORBIDDEN');
check('another site\'s worksheet is refused',call('performance.entry',{site:'Harbor Central'}).code==='E_FORBIDDEN');
check('a percentage entry with a zero denominator is refused',call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:'month-zero',entries:[{goalId:'goal-north-screen',numerator:0,denominator:0}]}).code==='E_VALIDATION');
check('a numerator larger than its denominator is refused',call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:'month-big',entries:[{goalId:'goal-north-screen',numerator:60,denominator:51}]}).code==='E_VALIDATION');
var nodataSave=call('actual.saveMonth',{site:'Harbor North',period:PERIOD,submissionKey:'month-key-nodata',entries:[{goalId:'goal-north-followup',noData:true}]});
check('changing a number inside the free window is recorded as a correction, not an overwrite',nodataSave.ok&&nodataSave.corrected===1,JSON.stringify(nodataSave));
var followUpNow=call('goal.get',{goalId:'goal-north-followup'});
check('the no-data month reads as Not entered rather than a score',followUpNow.item.result.status==='Not yet measured'&&followUpNow.item.result.noData===true,followUpNow.item.result.status);
check('and the number it replaced is still in the record',followUpNow.history.filter(function(h){return h.superseded;}).length>=1);

console.log('\nRegion rollup adds people, not percentages');
switchUser('regional@example.org');
var rollup=call('performance.rollup',{});
check('the rollup groups by metric',rollup.ok&&rollup.blocks.length>=1);
var screen=rollup.blocks.filter(function(b){return b.metric.metricId==='metric-housing-screen';})[0];
check('the percentage metric rolls up across sites',!!screen&&screen.kind==='weighted');
check('it sums both parts rather than averaging percentages',screen.numerator>0&&screen.denominator>0&&Math.abs(screen.total-(screen.numerator/screen.denominator)*100)<1e-9);
check('the weighted answer differs from the naive average of unequal sites',Math.abs(screen.total-screen.naiveAverage)>1,screen.total+' vs '+screen.naiveAverage);
check('it states the arithmetic in words',/divided by/.test(screen.formula));
check('it lists every contributing site',screen.parts.length>=2);
var average=rollup.blocks.filter(function(b){return b.metric.metricType==='average';})[0];
check('an average metric refuses to roll up rather than inventing a figure',!average||average.kind==='not-aggregatable');

console.log('\nData-due reminders');
switchUser('admin@example.org');
sentMail.length=0;
var settings=call('reminders.settings',{});
check('reminders are off until somebody turns them on',settings.ok&&settings.enabled===false);
var round=sandbox.REMINDER_ROUNDS[0];
var blocked=sandbox.sendDataDueRound_(PERIOD,round,new Date());
check('a round with reminders off sends nothing',blocked.ran===false&&sentMail.length===0);
var preview=call('reminders.preview',{});
check('the preview shows who would be emailed and still sends nothing',preview.ok&&preview.recipients.length>=1&&sentMail.length===0,JSON.stringify(preview.recipients&&preview.recipients.length));
var turnedOn=call('reminders.settings',{enabled:true});
check('turning reminders on installs exactly 1 daily trigger',turnedOn.ok&&turnedOn.enabled===true&&turnedOn.triggers===1,JSON.stringify(turnedOn));
call('reminders.settings',{enabled:true});
check('turning them on twice still leaves 1 trigger',call('reminders.settings',{}).triggers===1);
var firstRound=sandbox.sendDataDueRound_(PERIOD,round,new Date());
check('the first round emails the owners with something missing',firstRound.ran===true&&firstRound.sent>=1,JSON.stringify(firstRound));
check('one owner gets one email listing everything they owe',sentMail.length===firstRound.sent,sentMail.length+' emails for '+firstRound.sent+' sends');
check('the email names the goals rather than only counting them',/Follow-up|Clients|Staff|Days/.test(sentMail[0].body));
var mailAfterFirst=sentMail.length;
var secondRun=sandbox.sendDataDueRound_(PERIOD,round,new Date());
check('running the same round twice sends nothing the second time',secondRun.sent===0&&sentMail.length===mailAfterFirst,JSON.stringify(secondRun));
check('and the log records it per goal, per period, per round',rows('NotificationLog').filter(function(r){return String(r.type)===round.type&&String(r.period)===PERIOD;}).length>=1);
var laterRound=sandbox.sendDataDueRound_(PERIOD,sandbox.REMINDER_ROUNDS[1],new Date());
check('the second round of the month is a separate send',laterRound.sent>=1,JSON.stringify(laterRound));
check('a day that is not a reminder day does nothing',sandbox.reminderRoundForDay_(17)===null);

/* ======================= Guidance: the guidance layer ======================= */

console.log('\nThe manual is created with structure and not one word of advice');
switchUser('admin@example.org');
var made = call('playbook.ensureDoc', {});
check('an administrator can create the manual', made.ok && made.created === true, JSON.stringify(made.error || ''));
var DOC = sandbox.playbookDocId_();
function servedBlock(id) { return sandbox.playbookSnapshotRead_(DOC,true).blocks.filter(function (row) { return row.blockId === id; })[0] || null; }
check('and it is recorded so the app can find it again', !!DOC);
check('creating it twice makes only one', call('playbook.ensureDoc', {}).created === false);
check('it is named after the customer, never after the product',
  GAS.doc(DOC).getName().indexOf(sandbox.PRODUCT_NAME) === -1 && /operating manual/i.test(GAS.doc(DOC).getName()));
check('every metric in the library gets a section',
  GAS.childIndex(DOC, 'Metric: Clients screened for housing need') !== -1
  && GAS.childIndex(DOC, 'Metric: No-show rate') !== -1);
check('the structural headings are written in the brand green',
  GAS.colourOf(DOC, 'Metric: No-show rate') === '#19713F'
  && GAS.colourOf(DOC, 'On track, sustain') === '#19713F');
check('a metric section is a level 2 heading and a situation is level 3',
  GAS.headingOf(DOC, 'Metric: No-show rate') === 'HEADING2' && GAS.headingOf(DOC, 'At risk, recover') === 'HEADING3');
check('the rules banner sits above the content, where somebody editing will see it',
  /green[\s\S]*checker/.test(GAS.doc(DOC).getBody().getChild(2).getText())
  && GAS.doc(DOC).getBody().getChild(3).getText() === 'Content');
check('and no advice was invented to fill it', call('playbook.board', {}).sections.every(function (section) { return section.blocks.length === 0; }));
check('a manual with nothing written in it is healthy, not broken',
  call('playbook.board', {}).health.status === 'healthy');

console.log('\nWhat a person writes is what the app serves');
/* The library is alphabetical, so the first section in the Doc is the housing
   screen and the first of each situation heading belongs to it. */
GAS.insertAfter(DOC, 'On track, sustain', { kind: 'body', text: 'Keep the housing screen on the intake checklist.' });
GAS.insertAfter(DOC, 'At risk, recover', { kind: 'body', text: 'Spot-check 5 intakes a week for a completed screen.' });
GAS.insertAfter(DOC, 'At risk, recover', { kind: 'body', text: 'Add the housing screen to the intake checklist so it cannot be skipped.' });
GAS.insertAfter(DOC, 'Off track, urgent', { kind: 'body', text: 'Make the housing screen a required field before an intake can be closed.' });
GAS.append(DOC, { kind: 'heading2', text: 'Metric: Clients screened for housing need (Site: Harbor North)' });
GAS.append(DOC, { kind: 'heading3', text: 'At risk, recover' });
GAS.append(DOC, { kind: 'body', text: 'Use the shared screening list the site lead keeps.' });
var afterWriting = call('playbook.recheck', {});
check('the manual reads cleanly', afterWriting.ok && afterWriting.health.status === 'healthy', JSON.stringify(afterWriting.health && afterWriting.health.problems));
check('every block written is served, and only those', afterWriting.health.sectionCount === 4, String(afterWriting.health.sectionCount));
check('the headings nobody wrote under produced nothing at all',
  sandbox.playbookSnapshotRead_(DOC,true).blocks.every(function (row) { return JSON.parse(row.stepsJson).length > 0; }));
check('the steps are stored exactly as written',
  JSON.parse(servedBlock(sandbox.guidanceBlockId_('ORG-ROOT', 'metric-housing-screen', 'recover')).stepsJson)[0]
  === 'Add the housing screen to the intake checklist so it cannot be skipped.');
check('the health record names who last edited the Doc', afterWriting.health.lastEditor === 'Sample East Manager');
check('and says where that name came from', afterWriting.health.lastEditorSource === 'drive-api');

console.log('\nGuidance arrives on the goal, in one round trip');
var screenGoal = call('goal.get', { goalId: 'goal-north-screen' });
check('the goal carries its guidance', screenGoal.ok && !!screenGoal.guidance);
check('the situation is the band the engine already computed',
  screenGoal.item.result.status === 'At risk' && screenGoal.guidance.situation === 'recover',
  screenGoal.item.result.status + ' / ' + screenGoal.guidance.situation);
check('the organization block and the site override both show', screenGoal.guidance.blocks.length === 2, String(screenGoal.guidance.blocks.length));
check('the organization is read first', screenGoal.guidance.blocks[0].label === 'Organization guidance');
check('and the local block says which place added it', screenGoal.guidance.blocks[1].label === 'Harbor North adds');
check('the most specific block is recorded as the one that leads', screenGoal.guidance.winnerScope === 'site');
check('the steps are the exact maintained text',
  screenGoal.guidance.blocks[0].steps[1] === 'Spot-check 5 intakes a week for a completed screen.');
check('the panel knows which Doc it came from', /operating manual/i.test(screenGoal.guidance.docName));

var eastGoal = call('goal.get', { goalId: 'goal-east-screen' });
check('a site with no override sees only the organization block',
  eastGoal.guidance.blocks.length === 1 && eastGoal.guidance.blocks[0].label === 'Organization guidance');
check('and an on-track goal is shown how to sustain it',
  eastGoal.item.result.status === 'On track' && eastGoal.guidance.situation === 'sustain',
  eastGoal.item.result.status);

console.log('\nThe honest empty state');
var noGuidance = call('goal.get', { goalId: 'goal-north-served' });
check('a metric with nothing written for its situation says so', noGuidance.guidance.missing === true);
check('and offers no steps at all', noGuidance.guidance.blocks.length === 0 && noGuidance.guidance.stepCount === 0);
var unmeasured = call('goal.get', { goalId: 'goal-north-followup' });
check('a goal the engine cannot judge gets no situation', unmeasured.guidance.situation === null);

console.log('\nThe dashboard hook counts what is ready');
var boardWithGuidance = call('performance.board', {});
var screenCard = boardItem(boardWithGuidance, 'goal-north-screen');
check('an at-risk card knows the playbook has steps', screenCard.guidance.missing === false);
check('and how many there are', screenCard.guidance.stepCount === 3, String(screenCard.guidance.stepCount));
check('a card with nothing written says so rather than pretending', boardItem(boardWithGuidance, 'goal-north-served').guidance.missing === true);

console.log('\nA broken heading never reaches a site as missing guidance');
sandbox.PropertiesService.getScriptProperties().setProperty('PLAYBOOK_ALERTS_ENABLED', 'false');
sentMail.length = 0;
GAS.rename(DOC, 'At risk, recover', 'When it starts slipping');
var broken = call('playbook.recheck', {});
check('the manual reads as broken', broken.health.status === 'broken');
check('exactly 1 problem is reported for 1 mistake', broken.health.problemCount === 1, JSON.stringify(broken.health.problems));
check('and it names the heading that broke', broken.health.problems[0].heading === 'When it starts slipping');
check('in words a person can act on', broken.health.problems[0].explained === 'does not name one of the 3 situations');
check('the last good date is kept, not overwritten', !!broken.health.lastGoodAt && broken.health.lastGoodAt !== broken.health.lastCheckedAt);
var stillServed = call('goal.get', { goalId: 'goal-north-screen' });
check('the site is still shown the last good steps', stillServed.guidance.blocks.length === 2, String(stillServed.guidance.blocks.length));
check('word for word', stillServed.guidance.blocks[0].steps[0] === 'Add the housing screen to the intake checklist so it cannot be skipped.');
check('a broken section is never half-updated',
  JSON.parse(servedBlock(sandbox.guidanceBlockId_('ORG-ROOT', 'metric-housing-screen', 'sustain')).stepsJson).length === 1);

console.log('\nThe alert names the section and the editor, once');
check('alerts are off out of the box and a broken check sends nothing', sentMail.length === 0);
var playbookSettings = call('playbook.settings', { enabled: true });
check('turning them on installs exactly 1 trigger', playbookSettings.ok && playbookSettings.triggers === 1, JSON.stringify(playbookSettings));
call('playbook.settings', { enabled: true });
check('turning them on twice still leaves 1 trigger', call('playbook.settings', {}).triggers === 1);
sentMail.length = 0;
sandbox.runPlaybookCheck_();
check('the first check after a break emails the people who can fix it', sentMail.length >= 1, String(sentMail.length));
check('the email names the section', /When it starts slipping/.test(sentMail[0].body));
check('and who last edited the Doc', /Sample East Manager/.test(sentMail[0].body));
check('and says the last good version is still serving', /still showing the last version it could read/.test(sentMail[0].body));
var afterFirstAlert = sentMail.length;
sandbox.runPlaybookCheck_();
check('running the check again on the same break sends nothing', sentMail.length === afterFirstAlert);
GAS.rename(DOC, 'Off track, urgent', 'When it is really bad');
sandbox.runPlaybookCheck_();
check('a different break is a different alert', sentMail.length > afterFirstAlert, String(sentMail.length));

console.log('\nFixing the Doc puts it back');
GAS.rename(DOC, 'When it starts slipping', 'At risk, recover');
GAS.rename(DOC, 'When it is really bad', 'Off track, urgent');
var repaired = call('playbook.recheck', {});
check('the manual reads cleanly again', repaired.health.status === 'healthy', JSON.stringify(repaired.health.problems));
check('and the last good date moves forward', repaired.health.lastGoodAt === repaired.health.lastCheckedAt);

console.log('\nOnly a clean parse is trusted to delete anything');
GAS.removeLine(DOC, 'Make the housing screen a required field before an intake can be closed.');
GAS.removeLine(DOC, 'Off track, urgent');
var afterDelete = call('playbook.recheck', {});
check('losing a situation from a working section is reported, not silently obeyed',
  afterDelete.health.status === 'broken' && afterDelete.health.problems[0].kind === 'missing-situation',
  JSON.stringify(afterDelete.health.problems));
check('and the block it lost is still being served meanwhile',
  !!servedBlock(sandbox.guidanceBlockId_('ORG-ROOT', 'metric-housing-screen', 'urgent')));
GAS.insertAfter(DOC, 'Spot-check 5 intakes a week for a completed screen.', { kind: 'heading3', text: 'Off track, urgent' });
GAS.insertAfter(DOC, 'Off track, urgent', { kind: 'body', text: 'Make the housing screen a required field before an intake can be closed.' });
check('putting it back makes the manual clean again', call('playbook.recheck', {}).health.status === 'healthy');

/* Deleting a whole section is unambiguous: nothing in it parsed and nothing in
   it broke, so there is no mistake to protect the site from. */
var siteOverrideId = sandbox.guidanceBlockId_(sandbox.findAccessUnitByName_('site', 'Harbor North').unitId, 'metric-housing-screen', 'recover');
check('the site override is being served before it is removed', !!servedBlock(siteOverrideId));
GAS.removeSection(DOC, 'Metric: Clients screened for housing need (Site: Harbor North)');
var afterSectionDelete = call('playbook.recheck', {});
check('removing a whole section leaves the manual clean', afterSectionDelete.health.status === 'healthy', JSON.stringify(afterSectionDelete.health.problems));
check('and a clean parse really does delete it', !servedBlock(siteOverrideId));
check('so the site falls back to the organization guidance',
  call('goal.get', { goalId: 'goal-north-screen' }).guidance.blocks.length === 1);
GAS.append(DOC, { kind: 'heading2', text: 'Metric: Clients screened for housing need (Site: Harbor North)' });
GAS.append(DOC, { kind: 'heading3', text: 'At risk, recover' });
GAS.append(DOC, { kind: 'body', text: 'Use the shared screening list the site lead keeps.' });
call('playbook.recheck', {});
check('and writing it again brings it straight back',
  call('goal.get', { goalId: 'goal-north-screen' }).guidance.blocks.length === 2);

console.log('\nInteractive reads use the last explicitly published snapshot');
var beforeFetches = GAS.fetched.length;
call('performance.board', {});
call('performance.board', {});
check('reading the dashboard twice does not re-parse an unchanged Doc', GAS.fetched.length === beforeFetches, String(GAS.fetched.length - beforeFetches));
GAS.insertAfter(DOC, 'Keep the housing screen on the intake checklist.', { kind: 'body', text: 'Review the checklist every quarter.' });
call('performance.board', {});
check('interactive reads never fetch or parse edited documents', GAS.fetched.length === beforeFetches);
call('playbook.recheck', {});
check('an explicit authorized refresh publishes the edited guidance',
  call('goal.get', { goalId: 'goal-east-screen' }).guidance.blocks[0].steps.length === 2);

console.log('\nThe manual is read-only for site staff');
switchUser('site@example.org');
var siteBoard2 = call('playbook.board', {});
check('site staff can read the manual', siteBoard2.ok && siteBoard2.sections.length >= 1);
check('and see no health banner they cannot act on', siteBoard2.health === null && siteBoard2.canManage === false);
check('a direct recheck is refused', call('playbook.recheck', {}).code === 'E_FORBIDDEN');
check('creating a manual is refused', call('playbook.ensureDoc', {}).code === 'E_FORBIDDEN');
check('reporting a break is refused', call('playbook.remind', {}).code === 'E_FORBIDDEN');
check('but their goals still carry guidance', call('goal.get', { goalId: 'goal-north-screen' }).guidance.blocks.length >= 1);
switchUser('viewer@example.org');
check('a viewer gets nothing from the playbook', call('playbook.board', {}).code === 'E_FORBIDDEN');
switchUser('admin@example.org');
check('the Playbook item appears in the navigation',
  call('bootstrap').nav.filter(function (x) { return x.id === 'playbook'; }).length === 1);
/* The complete improvement action workflow is planned. Its permission ships now; its screen does
   not, so the navigation must not offer it yet. */
check('Improve does not appear until its screen exists',
  call('bootstrap').nav.every(function (x) { return x.id !== 'improve'; }));
check('though the permission that will open it is already granted',
  call('bootstrap').improve.canOwnActions === true);
switchUser('viewer@example.org');
check('and never for a viewer',
  call('bootstrap').nav.filter(function (x) { return x.id === 'improve' || x.id === 'playbook'; }).length === 0);
check('a viewer is granted no action permission either',
  call('bootstrap').improve.canOwnActions === false && call('bootstrap').improve.canReadPlaybook === false);

console.log('\nA period the sheet turned into a date is still readable');
switchUser('admin@example.org');
var actualsSheet = book.getSheetByName('Actuals');
var actualHeaders = actualsSheet._v[0];
var periodCol = actualHeaders.indexOf('period'), goalCol = actualHeaders.indexOf('goalId');
var coerced = 0;
actualsSheet._v.forEach(function (line, index) {
  if (index === 0 || String(line[goalCol]) !== 'goal-north-screen') { return; }
  var text = String(line[periodCol]);
  if (!/^\d{4}-\d{2}$/.test(text)) { return; }
  /* Exactly what Google Sheets does to "2026-07" when the column is not forced
     to plain text. The in-memory fake stores strings verbatim and would never
     surface this on its own, so the coercion is applied deliberately. */
  line[periodCol] = new Date(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, 1);
  coerced++;
});
check('the fixture turned stored periods into Date objects', coerced >= 3, String(coerced));
var afterCoercion = call('performance.board', {});
var screenCard = afterCoercion.items.filter(function (item) { return item.goalId === 'goal-north-screen'; })[0];
check('the goal still resolves after the sheet coerced its periods', !!screenCard);
check('its trajectory still finds the reported months', screenCard && screenCard.trajectory.filter(function (point) { return point.value !== null; }).length >= 3, screenCard && JSON.stringify(screenCard.trajectory.map(function (point) { return point.value; })));
check('and its status is not thrown off', screenCard && screenCard.result.status !== 'Not yet measured', screenCard && screenCard.result.status);

console.log('\nThe product name never reaches customer data');
var storedText=book.order.map(function(name){return book.getSheetByName(name)._v.map(function(row){return row.join(' ');}).join(' ');}).join(' ');
check('no cell in any tab contains the product name',storedText.indexOf(sandbox.PRODUCT_NAME)===-1,'found "'+sandbox.PRODUCT_NAME+'" in stored data');
check('the branding response still reports it',call('bootstrap').branding.productName===sandbox.PRODUCT_NAME);

console.log('\n----------------------------------------'); console.log('PASSED '+pass+' / '+(pass+fail)); if(fail){console.log('FAILURES:\n  - '+failures.join('\n  - '));process.exit(1);} console.log('All integration checks passed.');
