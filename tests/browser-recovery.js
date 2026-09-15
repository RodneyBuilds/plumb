'use strict';
const path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('@playwright/test'),{AxeBuilder}=require('@axe-core/playwright');
const port=8896,base='http://127.0.0.1:'+port;
const shots=path.join(__dirname,'../screenshots','plumb-'+new Date().toISOString().slice(0,10));
(async()=>{
  const server=cp.spawn(process.execPath,[path.join(__dirname,'emulator.js'),String(port)],{stdio:['ignore','ignore','pipe']});
  let browser;
  try {
    let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,150));}
    assert.ok(ready,'local emulator must start');browser=await chromium.launch({headless:true});fs.mkdirSync(shots,{recursive:true});
    for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
      const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base+'/setuser?email=admin%40example.org');await page.locator('#boot').waitFor({state:'hidden'});
      await page.evaluate(()=>go('intake'));await page.getByRole('button',{name:'Create request',exact:true}).click();
      const title='Recovery '+label;await page.locator('#ifTitle').fill(title);await page.locator('#ifSite').selectOption('Harbor North');await page.locator('#ifDescription').fill('Synthetic recovery demonstration.');
      let dropped=false,initialKey='';
      await page.route('**/run',async route=>{
        const post=route.request().postDataJSON();
        if(!dropped && post.args?.[0]?.action==='intake.save') {
          dropped=true;initialKey=post.args[0].payload.submissionKey;
          const response=await route.fetch(),body=await response.json();assert.equal(body.result.ok,true);
          await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({__error:'Simulated lost response after successful persistence'})});
        } else await route.continue();
      });
      await page.locator('#saveIntakeButton').click();await page.getByRole('heading',{name:'A save needs recovery'}).waitFor();
      await page.getByText('Review the original change',{exact:true}).click();
      assert.match(await page.locator('#pendingMutationValues').innerText(),new RegExp(title));
      await page.evaluate(()=>{document.getElementById('ifTitle').value='Later unsent edit';});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),true);
      const violations=(await new AxeBuilder({page}).include('#pendingMutation').analyze()).violations.filter(v=>['critical','serious'].includes(v.impact));assert.deepEqual(violations.map(v=>v.id),[]);
      await page.screenshot({path:path.join(shots,'recovery-'+label+'.png')});
      await page.getByRole('button',{name:'Retry original change',exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
      const items=await page.evaluate(async()=>{const response=await run('intake.list',{});return response.items;});
      assert.equal(items.filter(row=>row.submissionKey===initialKey).length,1);assert.equal(items.some(row=>row.title==='Later unsent edit'),false);
      assert.equal(await page.locator('#pendingMutation').count(),0);assert.deepEqual(errors,[]);
      await context.close();console.log('PASS '+label+': lost response, original preview, safe retry, no duplicate, no overflow, accessible recovery panel');
    }
  } finally {if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
