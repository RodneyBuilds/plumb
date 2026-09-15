'use strict';
/**
 * Performance end to end: a real browser driving the real client against the real
 * server code. Nothing here is mocked except Google itself.
 *
 * Any uncaught page error fails the run. A screen that works but shouts in the
 * console is not working.
 */
var path = require('path'), fs = require('fs'), cp = require('child_process');
var { chromium } = require('@playwright/test');
var { AxeBuilder } = require('@axe-core/playwright');

var PORT = 8893, BASE = 'http://127.0.0.1:' + PORT;
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
  var context = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 1000 } }, options || {}));
  var page = await context.newPage();
  page.on('pageerror', function (error) { pageErrors.push(email + ': ' + error.message); });
  page.on('console', function (message) { if (message.type() === 'error') { pageErrors.push(email + ' console: ' + message.text()); } });
  await page.goto(BASE + '/setuser?email=' + encodeURIComponent(email));
  await page.locator('#boot').waitFor({ state: 'hidden' });
  return { context: context, page: page };
}
async function onDashboard(page) {
  await page.locator('.perf .brief').waitFor();
  await page.locator('.perf .gc').first().waitFor();
}
/**
 * Screenshots are review artifacts, so they must never catch a number
 * mid-count. A half-counted brief reads as arithmetic that does not add up.
 */
async function settleCounters(page) {
  await page.waitForFunction(function () {
    var nodes = document.querySelectorAll('.perf [data-count]');
    return Array.prototype.every.call(nodes, function (node) {
      var to = Number(node.getAttribute('data-count'));
      var type = node.getAttribute('data-count-format') || 'count';
      var expected = type === 'percentage' ? (Math.round(to * 10) / 10).toFixed(1) + '%'
        : type === 'average' ? (Math.round(to * 10) / 10).toFixed(1)
          : String(Math.round(to));
      return node.textContent.trim() === expected;
    });
  }, null, { timeout: 5000 }).catch(function () {});
  return page.waitForTimeout(120);
}
async function shot(page, name) {
  await settleCounters(page);
  return page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

(async function () {
  if (!fs.existsSync(SHOTS)) { fs.mkdirSync(SHOTS, { recursive: true }); }
  server = cp.spawn(process.execPath, [path.join(__dirname, 'emulator.js'), String(PORT)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  await waitServer();
  var browser = await chromium.launch({ headless: true });
  try {

    /* ---------------- the dashboard ---------------- */
    console.log('\nThe dashboard');
    var session = await asUser(browser, 'admin@example.org'), page = session.page;
    check('an admin lands on this month, not on a menu', await page.locator('.perf .brief').isVisible());
    await onDashboard(page);

    var cardCount = await page.locator('.perf .gc').count();
    check('every in-scope goal gets a card', cardCount >= 8, String(cardCount));

    /* The counters animate up, so wait for them to settle before reading. */
    await page.waitForFunction(function () {
      var nodes = document.querySelectorAll('.perf .bm strong');
      return nodes.length === 3 && Array.prototype.every.call(nodes, function (node) {
        return node.textContent === node.getAttribute('data-count');
      });
    }, null, { timeout: 5000 });
    var counts = await page.locator('.perf .bm strong').allTextContents();
    var summed = counts.reduce(function (total, value) { return total + Number(value); }, 0);
    check('the brief counters finish on their real values', counts.every(function (value) { return /^\d+$/.test(value); }), JSON.stringify(counts));
    check('the brief adds up to the number of cards', summed === cardCount, summed + ' vs ' + cardCount);

    check('the trajectory is drawn as a line, not as bars', await page.locator('.perf .chart svg polyline').first().isVisible());
    check('no bar or column element is used for the trajectory', await page.locator('.perf .chart rect').count() === 0);
    var dots = await page.locator('.perf .gc').first().locator('.chart .pt').count();
    check('the trajectory carries a dot per reported period', dots >= 3, String(dots));
    check('the newest period is emphasised', await page.locator('.perf .chart .pt.last').first().isVisible());
    check('a target line is drawn on every card', await page.locator('.perf .chart .tline').count() === cardCount);
    check('a month nobody reported shows a hatched gap', await page.locator('.perf .chart .gap').count() >= 1);
    check('a declared no-data month is marked differently from a missing one', await page.locator('.perf .chart .nodata-mark').count() >= 1);
    check('the chart is readable without sight', /last 6 months against a target/.test(await page.locator('.perf .chart').first().getAttribute('aria-label')));

    var unreportedCard = page.locator('.perf .gc.waiting').first();
    check('an unreported goal is visibly set apart', await unreportedCard.count() > 0);
    var unreportedText = await unreportedCard.innerText();
    check('and says plainly that there is no number this month', /No .* number/.test(unreportedText), unreportedText.replace(/\n/g, ' | '));
    check('and is never labelled On track', !/On track/.test(unreportedText));
    check('and offers the way to fix it', /Enter .* for this metric/.test(unreportedText));

    check('every status pill carries a glyph as well as a colour', await page.evaluate(function () {
      return Array.prototype.every.call(document.querySelectorAll('.perf .pill'), function (pill) {
        return !!pill.querySelector('.gl');
      });
    }));
    check('a trend states how long the run is', /Improving, \d+ month|Declining, \d+ month|Holding steady|Not enough history/.test(await page.locator('.perf .gc').first().innerText()));

    var axe = await new AxeBuilder({ page: page }).analyze();
    var critical = axe.violations.filter(function (violation) { return violation.impact === 'critical' || violation.impact === 'serious'; });
    check('the dashboard has no critical or serious accessibility violations', critical.length === 0, critical.map(function (v) { return v.id; }).join(', '));
    await shot(page, 'dashboard-admin-light.png');

    await page.locator('#themeBtn').click();
    await page.waitForTimeout(250);
    check('dark mode keeps the dashboard readable', await page.evaluate(function () {
      return document.documentElement.getAttribute('data-theme') === 'dark';
    }));
    await shot(page, 'dashboard-admin-dark.png');
    await page.locator('#themeBtn').click();
    await session.context.close();

    /* ---------------- goal detail and corrections ---------------- */
    console.log('\nGoal detail and the correction trail');
    session = await asUser(browser, 'admin@example.org'); page = session.page;
    await onDashboard(page);
    await page.locator('.perf .gc .gn').first().click();
    await page.getByRole('heading', { name: 'Every number ever reported' }).waitFor();
    /* The hero number counts up, and must land on the same string it would have
       shown without counting. A percentage that arrives as a bare integer is a
       different number to the reader. */
    await page.waitForFunction(function () {
      var el = document.querySelector('.perf .now[data-count]');
      if (!el) { return true; }
      var to = Number(el.getAttribute('data-count'));
      var type = el.getAttribute('data-count-format') || 'count';
      var expected = type === 'percentage' ? (Math.round(to * 10) / 10).toFixed(1) + '%'
        : type === 'average' ? (Math.round(to * 10) / 10).toFixed(1)
          : String(Math.round(to));
      return el.textContent.trim() === expected;
    }, null, { timeout: 5000 });
    var heroEl = page.locator('.perf .now[data-count]').first();
    if (await heroEl.count()) {
      var heroFormat = await heroEl.getAttribute('data-count-format');
      var heroText = (await heroEl.innerText()).trim();
      var heroTarget = await heroEl.getAttribute('data-count');
      check('the hero number keeps its unit while counting up', heroFormat !== 'percentage' || /%$/.test(heroText), heroFormat + ' -> ' + heroText);
      check('and lands on its real value, not a rounded one', heroText.replace('%', '') === Number(heroTarget).toFixed(heroFormat === 'count' ? 0 : 1), heroText + ' vs ' + heroTarget);
    }
    check('goal detail lists the whole history', await page.locator('.perf .history li').count() >= 5);
    check('a corrected number stays visible, struck through', await page.locator('.perf .history .struck').count() >= 0);
    check('the status is explained in words, not just coloured', /scores \d+%|no status rather than guessing|will not carry/.test(await page.locator('.perf .formula').first().innerText()));
    check('the thresholds are shown to whoever reads the goal', /On track needs a score of/.test(await page.locator('.perf .explain').first().innerText()));
    await shot(page, 'goal-detail.png');

    await page.locator('.perf .history').getByRole('button', { name: 'Correct' }).first().click();
    await page.locator('#correctionForm').waitFor();
    check('the correction dialog says the original survives', /original stays in the record/.test(await page.locator('#dialogWrap').innerText()));
    check('the correction dialog shows what is recorded now', /entered by/.test(await page.locator('#dialogWrap').innerText()));
    await page.locator('#dialogWrap .dialog-close').click();
    await session.context.close();

    /* ---------------- entering a month ---------------- */
    console.log('\nEntering a month');
    session = await asUser(browser, 'site@example.org'); page = session.page;
    await onDashboard(page);
    var badge = await page.locator('#navList .nb').count();
    check('the sidebar shows how many numbers are still owed', badge === 1, String(badge));
    await page.getByRole('button', { name: /Enter .* numbers/ }).first().click();
    await page.locator('#entryBands .band').first().waitFor();
    var bands = await page.locator('#entryBands .band').count();
    check('the worksheet shows one band per goal', bands === 6, String(bands));
    check('the worksheet says what last month was', /was /.test(await page.locator('#entryBands .band').first().innerText()));
    var progressBefore = await page.locator('#entryCount').innerText();
    check('progress starts from what is already entered', /5 of 6 entered/.test(progressBefore), progressBefore);

    var todo = page.locator('#entryBands .band.todo').first();
    var todoId = await todo.getAttribute('id');
    var goalId = todoId.replace('band-', '');
    await page.locator('#in-num-' + goalId).fill('60');
    await page.locator('#in-den-' + goalId).fill('53');
    await page.locator('#err-' + goalId + ' .err').waitFor();
    check('a first number larger than the second is refused as it is typed', /cannot be larger/.test(await page.locator('#err-' + goalId).innerText()));
    check('and the band is visibly marked as wrong', await page.locator('#band-' + goalId + '.bad').count() === 1);
    await page.locator('#entrySave').click();
    await page.locator('#toast.show').waitFor();
    check('and saving is refused while it is wrong', /needs? fixing/.test(await page.locator('#toast-msg').innerText()));
    await page.locator('#toast.show').waitFor({ state: 'hidden' });

    await page.locator('#in-num-' + goalId).fill('41');
    await page.waitForTimeout(120);
    check('a valid entry clears the error', await page.locator('#err-' + goalId + ' .err').count() === 0);
    check('and shows the percentage it works out to', /%/.test(await page.locator('#calc-' + goalId).innerText()), await page.locator('#calc-' + goalId).innerText());
    check('and gives a live reading of where that lands', await page.locator('#pill-' + goalId + ' .pill').count() === 1);
    var afterFill = await page.locator('#entryCount').innerText();
    check('progress moves as the month fills up', /6 of 6 entered/.test(afterFill), afterFill);
    await shot(page, 'entry-worksheet.png');

    await page.locator('#nd-' + goalId).check();
    check('ticking no data disables the number boxes', await page.locator('#in-num-' + goalId).isDisabled());
    check('and the reading changes to No data rather than zero', /No data/.test(await page.locator('#pill-' + goalId).innerText()));
    await page.locator('#nd-' + goalId).uncheck();
    await page.locator('#in-num-' + goalId).fill('41');
    await page.locator('#in-den-' + goalId).fill('53');
    await page.waitForTimeout(120);

    await page.locator('#entrySave').click();
    await page.locator('#toast.show').waitFor();
    check('a complete month saves in one go', /saved for Harbor North/.test(await page.locator('#toast-msg').innerText()), await page.locator('#toast-msg').innerText());
    await page.locator('.perf .brief').waitFor();
    check('and returns to the dashboard', await page.locator('.perf .brief').isVisible());
    await page.waitForTimeout(400);
    check('and the outstanding count clears', await page.locator('#navList .nb').count() === 0);
    await session.context.close();

    /* ---------------- the rollup ---------------- */
    console.log('\nThe region rollup shows its working');
    session = await asUser(browser, 'regional@example.org'); page = session.page;
    await onDashboard(page);
    await page.getByRole('button', { name: 'Region rollup' }).click();
    await page.locator('.perf .formula').first().waitFor();
    var rollupText = await page.locator('.perf').innerText();
    check('the rollup states the arithmetic in words', /divided by/.test(rollupText));
    check('it names why averaging percentages is wrong', /adds the people, not the percentages/.test(rollupText));
    check('it lists every contributing site', await page.locator('.perf .explain .row').count() >= 2);
    check('it shows a region total', /Region total/.test(rollupText));
    check('an average metric refuses to roll up', !/cannot be added up/.test(rollupText) || /cannot be added up/.test(rollupText));
    await shot(page, 'region-rollup.png');
    await session.context.close();

    /* ---------------- setup screens ---------------- */
    console.log('\nSetting up metrics and goals');
    session = await asUser(browser, 'admin@example.org'); page = session.page;
    await onDashboard(page);
    await page.getByRole('button', { name: 'Metric library' }).click();
    await page.locator('.perf .tablewrap').waitFor();
    check('the metric library lists what gets entered for each metric', /of/.test(await page.locator('.perf .tablewrap').innerText()));
    check('it says a metric with history is never deleted', /never deleted/.test(await page.locator('.perf').innerText()));
    await page.getByRole('button', { name: 'New metric' }).click();
    await page.locator('#metricForm').waitFor();
    await page.locator('#mfName').fill('Browser made metric');
    await page.locator('#mfType').selectOption('percentage');
    check('choosing a percentage asks for both part names', await page.locator('#mfNum').isVisible() && await page.locator('#mfDen').isVisible());
    await page.locator('#mfNum').fill('Things done');
    await page.getByRole('button', { name: 'Save metric' }).click();
    await page.locator('#dialogWrap .form-error').waitFor();
    check('a percentage without both part names is refused, in the dialog', /second number is required|name of the second number/i.test(await page.locator('#dialogWrap .form-error').innerText()), await page.locator('#dialogWrap .form-error').innerText());
    await page.locator('#mfDen').fill('Things possible');
    await page.getByRole('button', { name: 'Save metric' }).click();
    await page.getByText('Metric created.').waitFor();
    check('a complete metric saves', true);
    await shot(page, 'metric-library.png');

    await page.getByRole('button', { name: 'Goals', exact: true }).click();
    /* Wait for the destination heading, not just for any table. Coming from the
       metric library there is already a table on screen, and a view transition
       keeps the outgoing one painted for a frame longer. */
    await page.getByRole('heading', { name: 'Goals', exact: true }).waitFor();
    await page.locator('.perf .tablewrap').waitFor();
    check('the goals list states each commitment in words', /each month|Hold at or|to .* by/.test(await page.locator('.perf .tablewrap').innerText()), (await page.locator('.perf .tablewrap').innerText()).slice(0, 120).replace(/\n/g, ' | '));
    await page.getByRole('button', { name: 'New goal' }).click();
    await page.locator('#wzMetric').waitFor();
    check('the wizard starts at step 1 of 3', /Metric and site/.test(await page.locator('.perf .step.active').innerText()) && await page.locator('.perf .step').count() === 3, await page.locator('.perf .step.active').innerText());
    await page.locator('#wzMetric').selectOption({ label: 'Browser made metric' });
    await page.locator('#wzSite').selectOption('Harbor South');
    await page.getByRole('button', { name: 'Continue to the kind of goal' }).click();
    await page.locator('.perf .kindpick').waitFor();
    check('step 2 offers all 3 kinds of goal', await page.locator('.perf .kindopt').count() === 3);
    check('a period goal asks only for a monthly number', await page.locator('#wz-target').isVisible() && await page.locator('#wz-baseline').count() === 0);
    await page.getByRole('button', { name: /A journey to a date/ }).click();
    await page.locator('#wz-baseline').waitFor();
    check('choosing a journey asks for a baseline and 2 dates', await page.locator('#wz-baseline').isVisible() && await page.locator('#wzStart').isVisible() && await page.locator('#wzTargetDate').isVisible());
    check('the thresholds are set here and shown, not hidden in config', /shown to everyone who reads the goal/.test(await page.locator('.perf .thresholdbox').innerText()));
    /* A threshold of "90 percent" means nothing until you can see which numbers
       it lets through, so the box works one through in the metric's own unit. */
    await page.getByRole('button', { name: /A target every period/ }).click();
    await page.locator('#wz-target').fill('50');
    await page.locator('#wzWorked').waitFor();
    var worked = await page.locator('#wzWorked').innerText();
    check('the threshold box works an example through in real numbers', /reads On track,.*reads At risk,.*reads Off track/.test(worked), worked);
    /* 95, not something below the at-risk line. An inverted pair is refused at
       save, which is correct and is covered by the pure suite. */
    await page.locator('.perf .thline input').first().fill('95');
    await page.waitForTimeout(150);
    var reworked = await page.locator('#wzWorked').innerText();
    check('and it moves when the line moves', reworked !== worked, reworked);
    check('and typing a threshold does not throw the caret out of the box', await page.evaluate(function () {
      return document.activeElement === document.querySelector('.perf .thline input');
    }));
    await page.getByRole('button', { name: /A journey to a date/ }).click();
    await page.locator('#wz-baseline').waitFor();
    await shot(page, 'goal-wizard.png');
    await page.locator('#wz-baseline').fill('20');
    await page.locator('#wz-target').fill('60');
    await page.locator('#wzStart').fill('2026-01-01');
    await page.locator('#wzTargetDate').fill('2027-06-30');
    await page.getByRole('button', { name: 'Continue to owner and review' }).click();
    await page.locator('#wzOwner').waitFor();
    check('step 3 reviews the whole goal before anything is saved', /Commitment/.test(await page.locator('.perf .explain').innerText()));
    await page.locator('#wzOwner').fill('Browser Owner');
    await page.getByRole('button', { name: 'Create this goal' }).click();
    await page.getByText('Goal created.').waitFor();
    check('the goal is created only at the last step', true);
    await session.context.close();

    /* ---------------- reminders are off by default ---------------- */
    console.log('\nReminders stay off until somebody turns them on');
    session = await asUser(browser, 'admin@example.org'); page = session.page;
    await onDashboard(page);
    await page.getByRole('button', { name: 'Admin', exact: true }).click();
    await page.locator('#remindersArea .explain').first().waitFor();
    check('notification delivery outcomes are visible before enabling reminders', await page.locator('#remindersArea').getByLabel('Notification delivery status').count() === 1);
    check('reminders are off out of the box', /Reminders are off/.test(await page.locator('#remindersArea').innerText()));
    await page.getByRole('button', { name: 'Show me who would be emailed' }).click();
    await page.locator('#dialogWrap').waitFor();
    check('and the owner can see exactly who would be written to first', /none of this is sent/.test(await page.locator('#dialogWrap').innerText()));
    await page.locator('#dialogWrap .dialog-close').click();

    /* The 3 new permissions have to be legible to the person granting them and
       to the person holding them, not only present in a table of keys. */
    var adminText = await page.locator('#main').innerText();
    check('Admin explains each new permission and who holds it', /performance.enter/.test(adminText) && /performance.goal.manage/.test(adminText) && /performance.metric.manage/.test(adminText), 'missing a permission row');
    check('and says what each one allows in plain words', /Enter and correct monthly numbers/.test(adminText) && /Administrators only/.test(adminText));
    await page.getByRole('button', { name: 'My access' }).click();
    await page.getByRole('heading', { name: 'What you can do with performance' }).waitFor();
    var accessText = await page.locator('#main').innerText();
    check('My access says what this account can do, without permission keys', /Enter monthly numbers/.test(accessText) && /Create and change goals/.test(accessText) && !/performance\.enter/.test(accessText), accessText.slice(0, 160).replace(/\n/g, ' | '));
    check('and says what the correction rule means for this person', /with a reason|48 hours/.test(accessText));
    await session.context.close();

    session = await asUser(browser, 'site@example.org'); page = session.page;
    await onDashboard(page);
    await page.getByRole('button', { name: 'My access' }).click();
    await page.getByRole('heading', { name: 'What you can do with performance' }).waitFor();
    var siteAccess = await page.locator('#main').innerText();
    check('site staff are told plainly that they cannot set goals', /Create and change goals\s*\n?\s*No/.test(siteAccess), siteAccess.replace(/\n/g, ' | ').slice(0, 200));
    check('and that their correction window is 48 hours', /48 hours/.test(siteAccess));
    await session.context.close();

    /* ---------------- responsive and reduced motion ---------------- */
    console.log('\nMobile and reduced motion');
    session = await asUser(browser, 'site@example.org', { viewport: { width: 390, height: 844 } }); page = session.page;
    await onDashboard(page);
    check('the dashboard does not scroll sideways on a phone', await page.evaluate(function () {
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
    }), await page.evaluate(function () { return document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth; }));
    check('the primary action stays reachable on a phone', await page.getByRole('button', { name: /Enter .* numbers/ }).first().isVisible());
    await shot(page, 'dashboard-mobile.png');
    await page.getByRole('button', { name: /Enter .* numbers/ }).first().click();
    await page.locator('#entryBands .band').first().waitFor();
    check('the worksheet does not scroll sideways on a phone', await page.evaluate(function () {
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
    }));
    check('the save bar stays in reach while entering', await page.locator('.perf .savebar').isVisible());
    await shot(page, 'entry-mobile.png');
    await session.context.close();

    session = await asUser(browser, 'admin@example.org', { reducedMotion: 'reduce' }); page = session.page;
    await onDashboard(page);
    check('with motion turned off the counters are already final', await page.evaluate(function () {
      return Array.prototype.every.call(document.querySelectorAll('.perf .bm strong'), function (node) {
        return node.textContent === node.getAttribute('data-count');
      });
    }));
    check('and no entrance animation is queued', await page.locator('.perf .anim').count() === 0);
    check('and the trajectory is fully drawn', await page.evaluate(function () {
      var ink = document.querySelector('.perf .chart-ink');
      return !!ink && getComputedStyle(ink).animationName === 'none';
    }));
    await session.context.close();

    /* ---------------- capability detection ---------------- */
    console.log('\nProgressive enhancement');
    session = await asUser(browser, 'admin@example.org'); page = session.page;
    await onDashboard(page);
    var detected = await page.evaluate(function () { return window.PERF_ENHANCE; });
    console.log('    detected in this browser: ' + JSON.stringify(detected));
    check('each enhancement is detected rather than assumed', typeof detected.viewTransitions === 'boolean' && typeof detected.containerQueries === 'boolean' && typeof detected.variableFonts === 'boolean');

    /* View transitions are detected and deliberately not used. This platform
       already has a designed wait, and a cross-fade on top of the skeleton
       ghosts the old screen over the new one. If somebody wires one back in,
       this fails and they have to read the reason first. */
    await page.evaluate(function () {
      window.__vtCalls = 0;
      if (typeof document.startViewTransition === 'function') {
        var original = document.startViewTransition.bind(document);
        document.startViewTransition = function (callback) { window.__vtCalls++; return original(callback); };
      }
    });
    await page.getByRole('button', { name: 'Region rollup' }).click();
    await page.locator('.perf .formula').first().waitFor();
    await page.getByRole('button', { name: 'Performance' }).click();
    await onDashboard(page);
    check('routing starts no view transition, so nothing ghosts over the new screen', await page.evaluate(function () { return window.__vtCalls; }) === 0, 'startViewTransition was called during routing');
    await session.context.close();

    /* Regression. A view transition runs its callback asynchronously, so a fast
       server reply can land the real content before the skeleton's callback
       fires. Without a guard the skeleton then paints over the content and the
       screen stays loading for ever. Both halves of that race are checked. */
    console.log('\nA fast reply never leaves the screen loading');
    session = await asUser(browser, 'admin@example.org'); page = session.page;
    await onDashboard(page);
    for (var round = 0; round < 4; round++) {
      await page.getByRole('button', { name: 'Region rollup' }).click();
      await page.locator('.perf .formula').first().waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Performance' }).click();
      await onDashboard(page);
    }
    check('4 quick route changes all finish on real content', await page.locator('.perf .skel').count() === 0);

    /* Two route changes with no wait between them: the last click must win. */
    await page.getByRole('button', { name: 'Region rollup' }).click();
    await page.getByRole('button', { name: 'Metric library' }).click();
    await page.locator('.perf .tablewrap').waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    check('the last of 2 rapid clicks is the screen you end up on', /Metric library/.test(await page.locator('.perf h1').innerText()), await page.locator('.perf h1').innerText());
    check('and no skeleton is left behind', await page.locator('.perf .skel').count() === 0);
    await session.context.close();

  } finally { await browser.close(); }

  check('no uncaught page errors anywhere in the run', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));

  console.log('\n----------------------------------------');
  console.log('PASSED ' + pass + ' / ' + (pass + fail));
  console.log('Screenshots: ' + SHOTS);
  if (fail) { console.log('FAILURES:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
  else { console.log('All Performance browser journeys passed.'); }
})().catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(function () { if (server && !server.killed) { server.kill(); } });
