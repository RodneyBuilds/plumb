'use strict';
var path=require('path'),cp=require('child_process'),{chromium}=require('@playwright/test'),{AxeBuilder}=require('@axe-core/playwright');
var PORT=8892,BASE='http://127.0.0.1:'+PORT,server,pass=0,fail=0,failures=[];
function check(name,condition,detail){if(condition){pass++;console.log('  PASS  '+name);}else{fail++;failures.push(name+(detail?' ('+detail+')':''));console.log('  FAIL  '+name);}}
async function waitServer(){for(var i=0;i<40;i++){try{var r=await fetch(BASE);if(r.ok)return;}catch(ignore){}await new Promise(function(resolve){setTimeout(resolve,150);});}throw new Error('emulator did not start');}
async function asUser(browser,email,viewport){var context=await browser.newContext({viewport:viewport||{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',function(error){console.log('  PAGE ERROR '+error.message);});await page.goto(BASE+'/setuser?email='+encodeURIComponent(email));await page.waitForLoadState('domcontentloaded');await page.locator('#boot').waitFor({state:'attached'});await page.locator('#boot').waitFor({state:'hidden'});return{context:context,page:page};}
async function navLabels(page){return page.locator('#navList .navitem').allTextContents();}
/* Routes, not labels: the entry item carries a count badge whose text moves
   with the data, and a nav assertion should not break because a number changed. */
async function navRoutes(page){return page.locator('#navList .navitem').evaluateAll(function(nodes){return nodes.map(function(n){return n.dataset.route;});});}
(async function(){
  server=cp.spawn(process.execPath,[path.join(__dirname,'emulator.js'),String(PORT)],{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe']});var serverErrors='';server.stderr.on('data',function(d){serverErrors+=d;});await waitServer();var browser=await chromium.launch({headless:true});
  try{
    console.log('\nAdmin journey');
    var session=await asUser(browser,'admin@example.org'),page=session.page;
    var routes=await navRoutes(page);check('admin navigation covers all three layers',JSON.stringify(routes)===JSON.stringify(['home','performance','entry','rollup','intake','goals','metrics','playbook','access','admin']),JSON.stringify(routes));
    await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('heading',{name:'Intake that stays accountable'}).waitFor();
    var body=(await page.locator('body').innerText()).toLowerCase();/* Playbook is an implemented navigation surface. */
    check('former module labels are absent',!/(od diagnostic|site pipeline|source library|work records)/.test(body));
    await page.getByRole('button',{name:'Admin',exact:true}).click();await page.getByRole('button',{name:'Add site'}).click();await page.locator('#siteName').fill('Browser Added Site');await page.locator('#siteRegion').fill('Browser Region');await page.getByRole('button',{name:'Save site'}).click();await page.getByText('Site saved.').waitFor();await page.getByRole('button',{name:'Intake',exact:true}).click();await page.getByRole('button',{name:'Create request'}).click();var adminChoices=await page.locator('#ifSite option').allTextContents();check('new admin site is immediately available in Intake',adminChoices.includes('Browser Added Site'),JSON.stringify(adminChoices));await page.locator('#ifTitle').fill('Browser verified request');await page.locator('#ifSite').selectOption('Browser Added Site');await page.locator('#ifDescription').fill('Created through the real Intake browser and server path.');await page.getByRole('button',{name:'Create request',exact:true}).last().click();await page.getByRole('heading',{name:'Browser verified request'}).waitFor();check('admin can create and open a request',await page.getByText('Browser Added Site',{exact:true}).isVisible());
    check('detail exposes versioned record',/Version 1/.test(await page.locator('#main').innerText()));
    var axe=await new AxeBuilder({page:page}).analyze();check('admin request view has no critical accessibility violations',axe.violations.filter(function(v){return v.impact==='critical';}).length===0);
    await session.context.close();

    console.log('\nRegional journey');
    session=await asUser(browser,'regional@example.org');page=session.page;check('regional navigation excludes Admin and the metric library',JSON.stringify(await navRoutes(page))===JSON.stringify(['home','performance','entry','rollup','intake','goals','playbook','access']),JSON.stringify(await navRoutes(page)));
    await page.getByRole('button',{name:'Intake',exact:true}).click();await page.locator('.request-card').first().click();await page.getByRole('button',{name:'Change status'}).waitFor();check('regional sees Change status',await page.getByRole('button',{name:'Change status'}).isVisible());await page.getByRole('button',{name:'Change status'}).click();await page.locator('#tfStatus').selectOption('Triaged');await page.getByRole('button',{name:'Update status'}).click();await page.getByText('Triaged',{exact:true}).first().waitFor();check('regional can triage an in-scope request',await page.getByText('Triaged',{exact:true}).first().isVisible());await session.context.close();

    console.log('\nSite journey');
    session=await asUser(browser,'site@example.org');page=session.page;check('site navigation excludes setup and the rollup',JSON.stringify(await navRoutes(page))===JSON.stringify(['home','performance','entry','intake','playbook','access']),JSON.stringify(await navRoutes(page)));await page.getByRole('button',{name:'Intake',exact:true}).click();
    await page.getByRole('button',{name:'Create request'}).click();var choices=await page.locator('#ifSite option').allTextContents();check('site chooser contains only its assigned site',JSON.stringify(choices)===JSON.stringify(['Choose a site','Harbor North']));await page.locator('#ifTitle').fill('Site submitted request');await page.locator('#ifSite').selectOption('Harbor North');await page.locator('#ifDescription').fill('A site-scoped request created in browser verification.');await page.getByRole('button',{name:'Create request',exact:true}).last().click();await page.getByRole('heading',{name:'Site submitted request'}).waitFor();check('site can create an in-scope request',await page.getByRole('heading',{name:'Site submitted request'}).isVisible());check('site cannot manage status',await page.getByRole('button',{name:'Change status'}).count()===0);await session.context.close();

    console.log('\nViewer and unknown journeys');
    session=await asUser(browser,'viewer@example.org');page=session.page;check('viewer navigation is Home and My access only',JSON.stringify(await navLabels(page))===JSON.stringify(['Home','My access']),JSON.stringify(await navLabels(page)));check('viewer sees clear access explanation',await page.getByText('Your current role does not include operational Intake records.').isVisible());await page.getByRole('button',{name:'Review my access'}).click();check('viewer can review role and scope',await page.getByRole('heading',{name:'My access'}).isVisible());await session.context.close();
    session=await asUser(browser,'unknown@example.org');page=session.page;check('unknown account sees setup blocker',await page.getByRole('heading',{name:'You are signed in, but not set up yet'}).isVisible());check('unknown account never sees app shell',await page.locator('#app').isHidden());await session.context.close();

    console.log('\nResponsive and failure states');
    session=await asUser(browser,'admin@example.org',{width:390,height:844});page=session.page;check('mobile loads without horizontal page overflow',await page.evaluate(function(){return document.documentElement.scrollWidth<=document.documentElement.clientWidth+1;}));await page.locator('#menuBtn').click();check('mobile menu opens',await page.locator('#sidebar').evaluate(function(el){return el.classList.contains('open');}));await page.locator('#menuBtn').press('Escape');check('mobile menu closes with Escape',await page.locator('#sidebar').evaluate(function(el){return !el.classList.contains('open');}));await session.context.close();

    console.log('\nDialog honesty and async safety');
    session=await asUser(browser,'admin@example.org');page=session.page;
    await page.route('**/run',function(route){var post=route.request().postData()||'';if(post.indexOf('Errorville')!==-1){route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({result:{ok:false,code:'E_VALIDATION',error:'E_VALIDATION: forced test failure.'}})});return;}if(post.indexOf('Slow Site')!==-1){setTimeout(function(){route.continue();},1200);return;}route.continue();});
    await page.getByRole('button',{name:'Admin',exact:true}).click();
    await page.getByRole('button',{name:'Add site'}).click();
    check('region is labeled optional',/Region \(optional\)/.test(await page.locator('#dialogWrap').innerText()));
    check('site name is labeled required',/Site name \(required\)/.test(await page.locator('#dialogWrap').innerText()));
    await page.locator('#siteName').fill('Errorville');
    await page.getByRole('button',{name:'Save site'}).click();
    await page.locator('#dialogWrap .form-error').waitFor();
    check('server failure is shown inside the open dialog',/forced test failure/.test(await page.locator('#dialogWrap .form-error').innerText()));
    check('failed save re-enables the button',await page.locator('#saveSiteButton').isEnabled());
    await page.locator('.dialog-close').click();
    await page.getByRole('button',{name:'Add site'}).click();
    await page.locator('#siteName').fill('Region Free Site');
    await page.getByRole('button',{name:'Save site'}).click();
    await page.getByText('Site saved.').waitFor();
    check('site without a region saves with visible confirmation',true);
    await page.getByText('Region Free Site').first().waitFor();
    check('saved site appears in the admin list',await page.getByText('Region Free Site').first().isVisible());
    await page.locator('#toast.show').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Add site'}).click();
    await page.locator('#siteName').fill('Slow Site');
    await page.getByRole('button',{name:'Save site'}).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Intake',exact:true}).click();
    await page.getByRole('button',{name:'Create request'}).click();
    await page.locator('#ifTitle').fill('Draft typed while a save lands');
    await page.waitForSelector('#toast.show');
    check('late save announces itself',/Site saved/.test(await page.locator('#toast-msg').innerText()));
    await page.waitForTimeout(300);
    check('open intake form survives a late response',await page.locator('#intakeForm').isVisible());
    check('typed draft text is intact',await page.locator('#ifTitle').inputValue()==='Draft typed while a save lands');
    check('user stays on the Intake page',/^Intake$/.test((await page.locator('#main .page-head h1').innerText()).trim()));
    await page.locator('.dialog-close').click();
    await page.getByRole('button',{name:'Create request'}).click();
    var refreshedChoices=await page.locator('#ifSite option').allTextContents();
    check('the late-saved site is available in the next form',refreshedChoices.includes('Slow Site'),JSON.stringify(refreshedChoices));
    await page.locator('.dialog-close').click();
    await page.unroute('**/run');
    await page.route('**/run',function(route){var post=route.request().postData()||'';if(post.indexOf('access.list')!==-1){setTimeout(function(){route.continue();},400);return;}route.continue();});
    await page.getByRole('button',{name:'Admin',exact:true}).click();
    await page.getByRole('button',{name:'Add site'}).click();
    await page.locator('#siteName').fill('Chained Site');
    await page.locator('#siteRegion').fill('Chained Region');
    await page.getByRole('button',{name:'Save site'}).click();
    await page.locator('#dialogWrap').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Add person'}).click();
    await page.locator('#personScope').waitFor();
    var unitChoices=await page.locator('#personScope option').allTextContents();
    check('a just-saved site is offered when adding a person, no reload',unitChoices.some(function(u){return u.indexOf('Chained Site')===0;}),JSON.stringify(unitChoices));
    await page.locator('.dialog-close').click();
    await session.context.close();
  } finally {await browser.close();}
  console.log('\n----------------------------------------');console.log('PASSED '+pass+' / '+(pass+fail));if(fail){console.log('FAILURES:\n  - '+failures.join('\n  - '));process.exitCode=1;}else{console.log('All Intake browser journeys passed.');}
})().catch(function(error){console.error(error.stack||error);process.exitCode=1;}).finally(function(){if(server&&!server.killed)server.kill();});
