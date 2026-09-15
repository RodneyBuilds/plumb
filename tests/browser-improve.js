'use strict';
/**
 * Guidance, end to end: a real browser driving the real client
 * against the real server code, with a real Doc parse behind it.
 *
 * The load-bearing assertions here are about words, not layout. This feature is
 * trusted because of what it says and refuses to say, so the provenance line,
 * the empty state and the health banner are matched verbatim.
 *
 * Any uncaught page error fails the run.
 */
var path = require('path'), fs = require('fs'), cp = require('child_process');
var { chromium } = require('@playwright/test');
var { AxeBuilder } = require('@axe-core/playwright');

var PORT = 8894, BASE = 'http://127.0.0.1:' + PORT;
var SHOTS = path.join(__dirname, '..', 'screenshots', 'plumb-' + new Date().toISOString().slice(0, 10));
var server, pass = 0, fail = 0, failures = [], pageErrors = [];

function check(name, condition, detail) {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' (' + detail + ')' : '')); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
async function waitServer() {
  for (var i = 0; i < 60; i++) {
    try { var r = await fetch(BASE); if (r.ok) { return; } } catch (ignore) {}
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
  }
  throw new Error('emulator did not start');
}
async function asUser(browser, email, options) {
  var context = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 } }, options || {}));
  var page = await context.newPage();
  page.on('pageerror', function (error) { pageErrors.push(email + ': ' + error.message); });
  page.on('console', function (message) { if (message.type() === 'error') { pageErrors.push(email + ' console: ' + message.text()); } });
  await page.goto(BASE + '/setuser?email=' + encodeURIComponent(email));
  await page.locator('#boot').waitFor({ state: 'hidden' });
  return { context: context, page: page };
}
async function openGoalByMetric(page, name) {
  await page.locator('.perf .gc').first().waitFor();
  await page.locator('.perf button.gn', { hasText: name }).first().click();
  await page.locator('.perf .guide').waitFor({ timeout: 10000 });
}
/* Cards are ordered worst first, so "the first card for this metric" is not a
   stable way to reach a particular site's goal. Anything asserting on a site
   override has to name the site. */
async function openGoalAtSite(page, metric, site) {
  await page.locator('.perf .gc').first().waitFor();
  await page.locator('.perf .gc', { hasText: site }).filter({ hasText: metric }).first().locator('button.gn').click();
  await page.locator('.perf .guide').waitFor({ timeout: 10000 });
}
async function shot(page, name) {
  await page.waitForTimeout(180);
  return page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}
async function noOverflow(page) {
  return page.evaluate(function () { return document.documentElement.scrollWidth <= window.innerWidth + 1; });
}
async function breakDoc() { return (await fetch(BASE + '/playbook/break')).json(); }
async function repairDoc() { return (await fetch(BASE + '/playbook/repair')).json(); }

(async function () {
  if (!fs.existsSync(SHOTS)) { fs.mkdirSync(SHOTS, { recursive: true }); }
  server = cp.spawn(process.execPath, [path.join(__dirname, 'emulator.js'), String(PORT)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  await waitServer();
  var browser = await chromium.launch({ headless: true });
  try {

    /* ==================== the hook on a dashboard card ==================== */
    console.log('\nThe hook on a card');
    var admin = await asUser(browser, 'admin@example.org');
    var page = admin.page;
    await page.locator('.perf .gc').first().waitFor();
    var hooks = page.locator('.perf .gc-guide');
    check('a card that needs attention carries the playbook hook', await hooks.count() >= 1, String(await hooks.count()));
    check('and it says how many steps are ready rather than nudging vaguely',
      /recovery steps? ready|no steps for this yet/.test(await hooks.first().innerText()), await hooks.first().innerText());
    check('an on-track card carries no hook, because there is nothing to act on',
      await page.locator('.perf .gc:has(.p-ok) .gc-guide').count() === 0);
    await shot(page, 'dashboard-with-hook-desktop.png');

    /* ==================== the guidance panel ==================== */
    console.log('\nThe guidance panel on a goal');
    await openGoalAtSite(page, 'Clients screened for housing need', 'Harbor North');
    var guide = page.locator('.perf .guide');
    var guideText = await guide.innerText();
    check('the panel names the source before it says anything', /What the playbook says/.test(guideText));
    check('the situation line is filled by the status band',
      /(on track, so the manual shows how to sustain it|at risk, so the manual shows how to recover it|off track, so the manual shows the urgent recovery steps)/.test(guideText),
      guideText.slice(0, 200));
    check('the provenance line is exact', /shown exactly as written, nothing generated/.test(guideText));
    check('the steps are shown as an ordered list', await guide.locator('ol li').count() >= 1);
    check('the organization block is labelled as the organization',
      /organization guidance/i.test(guideText));
    check('the site override layers on top of it rather than replacing it',
      /harbor north adds/i.test(guideText), guideText.slice(0, 400));
    check('and the organization is read first',
      guideText.search(/organization guidance/i) < guideText.search(/harbor north adds/i));
    check('the panel sits beside the chart, not on top of it',
      await page.locator('.perf .goal-grid > .card').count() === 1 && await page.locator('.perf .goal-grid > .guide').count() === 1);
    check('and the trajectory is still the dominant element',
      (await page.locator('.perf .goal-grid > .card').boundingBox()).width > (await guide.boundingBox()).width);
    check('no horizontal overflow on the goal detail', await noOverflow(page));
    await shot(page, 'goal-guidance-desktop.png');

    var axeGoal = await new AxeBuilder({ page: page }).include('main').analyze();
    var seriousGoal = axeGoal.violations.filter(function (v) { return v.impact === 'critical' || v.impact === 'serious'; });
    check('no critical or serious accessibility violations on the goal with the panel open',
      seriousGoal.length === 0, seriousGoal.map(function (v) { return v.id; }).join(', '));

    /* ==================== the urgent branch, the headline case ==================== */
    console.log('\nAn off-track goal escalates to the urgent block');
    await page.getByRole('button', { name: 'Performance' }).first().click();
    await page.locator('.perf .gc').first().waitFor();
    var offTrackCard = page.locator('.perf .gc:has(.p-err)').first();
    check('the board has a goal that is genuinely off track', await offTrackCard.count() === 1);
    await offTrackCard.locator('button.gn').click();
    await page.locator('.perf .guide').waitFor({ timeout: 10000 });
    var urgentText = await page.locator('.perf .guide').innerText();
    check('the situation line says it is off track',
      /off track, so the manual shows the urgent recovery steps/.test(urgentText), urgentText.slice(0, 200));
    check('and the gap line says why the manual escalated',
      /The gap is large, so the manual escalates to the urgent steps\./.test(urgentText), urgentText.slice(0, 300));
    check('the urgent steps are the ones shown', await page.locator('.perf .guide-body ol li').count() >= 1);
    check('the arithmetic behind the escalation is stated, not asserted',
      /% of the line/.test(urgentText));
    await shot(page, 'goal-guidance-offtrack-desktop.png');

    /* ==================== the honest empty state ==================== */
    console.log('\nThe honest empty state');
    await page.getByRole('button', { name: 'Performance' }).first().click();
    await openGoalByMetric(page, 'No-show rate');
    var emptyText = await page.locator('.perf .guide').innerText();
    check('a metric with nothing written for its situation says so plainly',
      /The manual has nothing for this metric in this situation yet\./.test(emptyText), emptyText.slice(0, 200));
    check('and it invents no steps at all', await page.locator('.perf .guide-body ol').count() === 0);
    check('a manager is told how to fix it', /Add a section for it so this never comes up blank again\./.test(emptyText));
    check('the provenance line still shows on an empty panel', /shown exactly as written, nothing generated/.test(emptyText));
    await shot(page, 'goal-guidance-empty-desktop.png');

    /* ==================== the Playbook screen, healthy ==================== */
    console.log('\nThe Playbook screen, healthy');
    await page.getByRole('button', { name: 'Playbook' }).first().click();
    await page.locator('.perf .pb-doc').waitFor({ timeout: 10000 });
    var playbookText = await page.locator('main').innerText();
    check('the health banner leads the screen', await page.locator('.perf .pb-health').count() === 1);
    check('it reads as healthy', /Playbook healthy/.test(playbookText));
    check('and names how many sections read cleanly and who last edited the Doc',
      /read cleanly/.test(playbookText) && /Last edited by/.test(playbookText), playbookText.slice(0, 300));
    check('the Doc card says where the manual lives', /Maintained in Google Docs/.test(playbookText));
    check('and offers a way into it', await page.locator('.perf .pb-doc a', { hasText: 'Open in Docs' }).count() === 1);
    check('the rules note explains what not to touch', /That heading is what connects your advice to the app\./.test(playbookText));
    check('every metric has a section', await page.locator('.perf .pb-sec').count() >= 3, String(await page.locator('.perf .pb-sec').count()));
    check('the first section is open and the rest are collapsed',
      await page.locator('.perf .pb-sec.expanded').count() === 1);
    check('a situation label carries its words, not only its colour',
      /on track, sustain|at risk, recover|off track, urgent/i.test(playbookText));
    check('no horizontal overflow on the Playbook screen', await noOverflow(page));
    await shot(page, 'playbook-healthy-desktop.png');

    var second = page.locator('.perf .pb-sec').nth(1);
    await second.locator('.pb-sec-h').click();
    await page.waitForTimeout(220);
    check('a section opens when you press it', await second.getAttribute('class') !== null && /expanded/.test(await second.getAttribute('class')));
    check('and says so to a screen reader', await second.locator('.pb-sec-h').getAttribute('aria-expanded') === 'true');

    var axePlaybook = await new AxeBuilder({ page: page }).include('main').analyze();
    var seriousPlaybook = axePlaybook.violations.filter(function (v) { return v.impact === 'critical' || v.impact === 'serious'; });
    check('no critical or serious accessibility violations on the Playbook screen',
      seriousPlaybook.length === 0, seriousPlaybook.map(function (v) { return v.id; }).join(', '));

    /* ==================== a broken heading ==================== */
    console.log('\nA broken heading is surfaced, never hidden');
    var brokeTo = await breakDoc();
    check('the fixture really did break the manual', brokeTo.status === 'broken', JSON.stringify(brokeTo));
    await page.getByRole('button', { name: 'Playbook' }).first().click();
    await page.locator('.perf .pb-health.bad').waitFor({ timeout: 10000 });
    var brokenText = await page.locator('main').innerText();
    check('the banner says a section cannot be read', /section can't be read/.test(brokenText), brokenText.slice(0, 300));
    check('it names the heading that broke', /When it is really bad/.test(brokenText));
    check('it names who last edited the Doc', /Last edited by/.test(brokenText));
    check('and it says the last good version is still being served',
      /still serving the last good version|still serving the last version it could read/.test(brokenText));
    check('the section itself is marked, not just the top of the page',
      await page.locator('.perf .pb-sec.broken').count() >= 1);
    check('and there is a way to go and fix it', await page.locator('.perf .pb-health.bad a', { hasText: 'Open the Doc' }).count() === 1);
    check('no horizontal overflow while broken', await noOverflow(page));
    await shot(page, 'playbook-broken-desktop.png');

    console.log('\nAnd no site is left without guidance while it is broken');
    await page.getByRole('button', { name: 'Performance' }).first().click();
    await openGoalAtSite(page, 'Clients screened for housing need', 'Harbor North');
    check('the goal still shows steps from the last good version',
      await page.locator('.perf .guide-body ol li').count() >= 1,
      String(await page.locator('.perf .guide-body ol li').count()));
    check('and the panel does not mention the breakage, because the reader cannot act on it',
      !/can't be read/.test(await page.locator('.perf .guide').innerText()));

    await repairDoc();
    await admin.context.close();

    /* ==================== the manual is read-only for site staff ==================== */
    console.log('\nRead-only for site staff');
    var site = await asUser(browser, 'site@example.org');
    var sitePage = site.page;
    await sitePage.getByRole('button', { name: 'Playbook' }).first().click();
    await sitePage.locator('.perf .pb-doc').waitFor({ timeout: 10000 });
    var siteText = await sitePage.locator('main').innerText();
    check('site staff can read the manual', await sitePage.locator('.perf .pb-sec').count() >= 1);
    check('and see no health banner they cannot act on', await sitePage.locator('.perf .pb-health').count() === 0);
    check('nor the editing rules, which are not theirs to follow',
      !/That heading is what connects your advice to the app\./.test(siteText));
    check('the Doc card tells them it is read-only', /Read-only for site staff/.test(siteText));
    await shot(sitePage, 'playbook-site-staff-desktop.png');
    await site.context.close();

    /* ==================== a viewer gets nothing ==================== */
    console.log('\nA viewer gains nothing from the Improve layer');
    var viewer = await asUser(browser, 'viewer@example.org');
    check('no Playbook item in the navigation',
      await viewer.page.locator('[data-route="playbook"]').count() === 0);
    check('and no Improve item for anybody yet, because its action workflow is pending',
      await viewer.page.locator('[data-route="improve"]').count() === 0);
    await viewer.context.close();

    /* ==================== the three verification sizes ==================== */
    console.log('\nEvery size, and the dark theme');
    var sizes = [{ w: 1440, h: 900, name: 'desktop' }, { w: 1133, h: 800, name: 'intermediate' }, { w: 390, h: 844, name: 'mobile' }];
    for (var i = 0; i < sizes.length; i++) {
      var size = sizes[i];
      var sized = await asUser(browser, 'admin@example.org', { viewport: { width: size.w, height: size.h } });
      var p = sized.page;
      await p.locator('.perf .gc').first().waitFor();
      check('no horizontal overflow on the dashboard at ' + size.name, await noOverflow(p));
      await openGoalByMetric(p, 'Clients screened for housing need');
      check('no horizontal overflow on the goal panel at ' + size.name, await noOverflow(p));
      /* Opening a goal from a scrolled dashboard must land at the top of the
         goal, not halfway down it. On a phone the guidance panel is below the
         fold, so getting this wrong hides the reason the goal was opened. */
      if (size.w <= 900) { await p.locator('#menuBtn').click(); }
      await p.getByRole('button', { name: 'Performance' }).first().click();
      await p.locator('.perf .gc').first().waitFor();
      await p.evaluate(function () { window.scrollTo(0, 400); var m = document.getElementById('main'); if (m) { m.scrollTop = 400; } });
      await openGoalByMetric(p, 'Clients screened for housing need');
      check('a new screen starts at its own top at ' + size.name,
        await p.evaluate(function () {
          var m = document.getElementById('main');
          return window.scrollY === 0 && (!m || m.scrollTop === 0);
        }));
      if (size.w <= 980) {
        var chartBox = await p.locator('.perf .goal-grid > .card').boundingBox();
        var guideBox = await p.locator('.perf .goal-grid > .guide').boundingBox();
        check('the panel stacks under the chart at ' + size.name, guideBox.y > chartBox.y);
      }
      await shot(p, 'goal-guidance-' + size.name + '.png');
      if (size.name === 'mobile') {
        await p.locator('#menuBtn').click();
        await p.getByRole('button', { name: 'Playbook' }).first().click();
        await p.locator('.perf .pb-doc').waitFor({ timeout: 10000 });
        check('no horizontal overflow on the Playbook screen at mobile', await noOverflow(p));
        await shot(p, 'playbook-mobile.png');
      }
      await sized.context.close();
    }

    var dark = await asUser(browser, 'admin@example.org');
    await dark.page.locator('#themeBtn').click();
    await dark.page.waitForTimeout(250);
    await openGoalByMetric(dark.page, 'Clients screened for housing need');
    check('the guidance panel works in the dark theme',
      await dark.page.locator('.perf .guide-body ol li').count() >= 1);
    await shot(dark.page, 'goal-guidance-dark.png');
    await dark.page.getByRole('button', { name: 'Playbook' }).first().click();
    await dark.page.locator('.perf .pb-doc').waitFor({ timeout: 10000 });
    await shot(dark.page, 'playbook-healthy-dark.png');
    check('and so does the Playbook screen', await dark.page.locator('.perf .pb-sec').count() >= 1);
    await dark.context.close();

    /* ==================== reduced motion ==================== */
    console.log('\nNothing is hidden behind motion');
    var still = await asUser(browser, 'admin@example.org', { reducedMotion: 'reduce' });
    await still.page.getByRole('button', { name: 'Playbook' }).first().click();
    await still.page.locator('.perf .pb-doc').waitFor({ timeout: 10000 });
    check('the first section is already open with motion off',
      await still.page.locator('.perf .pb-sec.expanded .pb-guid').first().isVisible());
    await still.context.close();

  } finally { await browser.close(); }

  check('no uncaught page errors anywhere in the run', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));

  console.log('\n----------------------------------------');
  console.log('PASSED ' + pass + ' / ' + (pass + fail));
  console.log('Screenshots: ' + SHOTS);
  if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
  else { console.log('All guidance browser journeys passed.'); }
})().catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(function () { if (server && !server.killed) { server.kill(); } });
