'use strict';
const assert=require('node:assert/strict'), create=require('./security-harness');
function fixture(){const h=create();h.setup();return h;}
const input={site:'Sample Satellite',region:'Sample Region',active:true,submissionKey:'site-command'};
let total=0;
const sample=fixture(),original=sample.sandbox.operationPut_;let writes=0;
sample.sandbox.operationPut_=(...args)=>{writes++;return original(...args);};
assert.equal(sample.call('site.save',{item:input}).ok,true);
for(const after of [false,true])for(let nth=1;nth<=writes;nth++){
 const h=fixture(),put=h.sandbox.operationPut_;let step=0;
 h.sandbox.operationPut_=(...args)=>{if(++step===nth&&!after)throw Error('injected');const result=put(...args);if(step===nth&&after)throw Error('injected');return result;};
 assert.equal(h.call('site.save',{item:input}).ok,false);
 const pending=h.rows('Operations').some(row=>!['COMMITTED','CANCELLED'].includes(row.status));
 if(pending){assert.equal(h.call('site.list').items.some(row=>row.site===input.site),false);assert.equal(h.call('bootstrap').sites.includes(input.site),false);}
 h.sandbox.operationPut_=put;
 const result=h.call('site.save',{item:input});assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(h.call('site.save',{item:input}).duplicate,true);
 assert.equal(h.rows('Sites').filter(row=>row.site===input.site).length,1);
 const site=h.sandbox.findAccessUnitByName_('site',input.site),region=h.sandbox.findAccessUnitByName_('region',input.region);
 assert.equal(site.parentUnitId,region.unitId);assert.equal(h.call('bootstrap').sites.includes(input.site),true);
 total++;
}
const h=fixture();assert.equal(h.call('site.save',{item:{site:'Harbor North',region:'North',active:false,submissionKey:'deactivate'}}).ok,true);h.switchUser('site@example.org');assert.equal(h.call('bootstrap').sites.includes('Harbor North'),false);assert.equal(h.call('intake.list').items?.some(row=>row.site==='Harbor North')||false,false);total++;
const changing=fixture();for(const [index,active] of [true,false,true].entries())assert.equal(changing.call('site.save',{item:{site:'Sample State',region:'North',active,submissionKey:'state-'+index}}).ok,true);assert.equal(changing.sandbox.findRow_('Sites','site','Sample State').active,true);total++;
console.log('PASSED '+total+' / '+total+' site recovery scenarios');
