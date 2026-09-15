/**
 * Playbook.gs - the maintained operating manual, and the safety net around it.
 *
 * people write the manual in Google Docs, with spell-check,
 * comments and everything else Docs gives them, and this file reads it. That is
 * the right call for how the writing actually happens, and it means the app
 * depends on formatting a human controls. Four things make that safe, and all
 * four live here:
 *
 *   1. A coloured rules banner and green structural headings written into the
 *      Doc, so a person editing can see which lines are load-bearing.
 *   2. A checker that runs on a schedule or an explicit maintainer request, and
 *      turns a silent break into a named email within hours.
 *   3. Immutable guidance generations, the parsed copy the app serves, so nobody ever
 *      waits on a Doc parse and a broken Doc never leaves a site with nothing.
 *   4. The last-good rule: only a parse with no problems at all is trusted to
 *      remove anything.
 *
 * Every judgement about the format is a pure function in Logic.gs. This file
 * reads the Doc, publishes a complete generation, and queues notifications.
 *
 */

var PLAYBOOK_DOC_PROP_ = 'PLAYBOOK_DOC_ID';
var PLAYBOOK_TRIGGER_HANDLER_ = 'runPlaybookCheck_';
var PLAYBOOK_CHECK_HOURS_ = 4;
var PLAYBOOK_CONTENT_MARKER_ = 'Content';

/** Structural headings use a fixed green to distinguish managed document structure from customer branding. */
var PLAYBOOK_HEADING_GREEN_ = '#19713F';
var PLAYBOOK_BANNER_BG_ = '#E3F0E7';

/** Alerts ship switched off, exactly like the Performance reminders. A build that
    can email real people by default is a build that emails real people by
    accident. The check itself is never gated: the safety net has to run. */
function playbookAlertsEnabled_() {
  return String(PropertiesService.getScriptProperties().getProperty('PLAYBOOK_ALERTS_ENABLED') || '').toLowerCase() === 'true';
}

/* ============================ the managed Doc ============================ */

function playbookDocId_() {
  try {
    var stored = PropertiesService.getScriptProperties().getProperty(PLAYBOOK_DOC_PROP_);
    if (stored) { return String(stored); }
  } catch (ignore) {}
  var row = readTable_('PlaybookHealth')[0];
  return row ? String(row.docId || '') : '';
}

function playbookDocName_() {
  var branding = brandingConfig_();
  return String(branding.customerName || 'Your organization') + ' operating manual';
}

/**
 * Create the manual, once, with its structure and nothing else in it.
 *
 * Every active metric gets a section and its 3 situation headings, and not one
 * word of advice. Seeding example steps would be the app inventing guidance,
 * so until a person writes something every
 * goal shows the honest empty state. A structure to fill in is help; words
 * nobody wrote are not.
 */
function playbookEnsureDoc_(user) {
  requirePlaybookMaintainer_(user);
  var existing = playbookDocId_();
  if (existing) {
    try { DriveApp.getFileById(existing); return { docId: existing, created: false }; }
    catch (missing) { /* the Doc was deleted or moved out of reach; make a new one */ }
  }
  var doc = DocumentApp.create(playbookDocName_());
  var docId = doc.getId();
  playbookWriteStructure_(doc, playbookStarterSections_());
  doc.saveAndClose();

  var file = DriveApp.getFileById(docId);
  /* Filed beside the workspace it belongs to, rather than loose in somebody's
     Drive root where the next person cannot find it. */
  try {
    var parents = DriveApp.getFileById(ss_().getId()).getParents();
    if (parents.hasNext()) { file.moveTo(parents.next()); }
  } catch (ignoreMove) {}

  PropertiesService.getScriptProperties().setProperty(PLAYBOOK_DOC_PROP_, docId);
  audit_('playbook', docId, 'create-doc', null, { docId: docId, name: playbookDocName_() }, user.email);
  return { docId: docId, created: true };
}

/** One section per active metric, headings only. */
function playbookStarterSections_() {
  return metricRows_()
    .filter(function (metric) { return perfActive_(metric.active); })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
    .map(function (metric) { return { heading: 'Metric: ' + String(metric.name), situations: GUIDANCE_SITUATIONS.slice() }; });
}

function playbookWriteStructure_(doc, sections) {
  var body = doc.getBody();
  body.clear();
  playbookSetIf_(body, 'setMarginTop', 54);
  playbookSetIf_(body, 'setMarginBottom', 54);
  playbookSetIf_(body, 'setMarginLeft', 54);
  playbookSetIf_(body, 'setMarginRight', 54);

  playbookStyleParagraph_(body.appendParagraph(playbookDocName_()).setHeading(DocumentApp.ParagraphHeading.HEADING1), 'title');
  playbookStyleParagraph_(body.appendParagraph('Maintained by your team. Read by the app.'), 'subtitle');
  playbookBanner_(body);
  playbookStyleParagraph_(body.appendParagraph(PLAYBOOK_CONTENT_MARKER_).setHeading(DocumentApp.ParagraphHeading.HEADING2), 'marker');

  (sections || []).forEach(function (section) {
    playbookStyleParagraph_(body.appendParagraph(section.heading).setHeading(DocumentApp.ParagraphHeading.HEADING2), 'section');
    (section.situations || []).forEach(function (situation) {
      playbookStyleParagraph_(body.appendParagraph(SITUATION_LABELS[situation]).setHeading(DocumentApp.ParagraphHeading.HEADING3), 'section');
      (section.steps && section.steps[situation] || []).forEach(function (step) {
        if (body.appendListItem) { playbookStyleParagraph_(body.appendListItem(step), 'body'); }
        else { playbookStyleParagraph_(body.appendParagraph(step), 'body'); }
      });
    });
  });
  return doc;
}

/**
 * The rules note, written into the Doc itself.
 *
 * It sits in a coloured single-cell table because a Google Docs paragraph
 * cannot carry a background, and the whole point is that it does not look like
 * something you are meant to edit.
 */
function playbookBanner_(body) {
  var text = 'How editing works. Every section below starts with a heading shown in green. '
    + 'That heading is what connects your advice to the app. Write freely everywhere else. '
    + 'A checker scans this document a few times a day, and the moment the app reads it, and emails you if a green heading gets broken. '
    + 'While a heading is broken the app keeps showing the last version it could read, so no site is left without guidance.';
  try {
    if (!body.appendTable) { throw new Error('no tables here'); }
    var table = body.appendTable([[text]]);
    var cell = table.getRow(0).getCell(0);
    playbookSetIf_(cell, 'setBackgroundColor', PLAYBOOK_BANNER_BG_);
    var cellText = cell.editAsText && cell.editAsText();
    if (cellText) { playbookSetIf_(cellText, 'setFontFamily', 'Arial'); playbookSetIf_(cellText, 'setFontSize', 10); }
    return table;
  } catch (noTable) {
    return playbookStyleParagraph_(body.appendParagraph(text), 'metadata');
  }
}

function playbookSetIf_(target, method, value) {
  try { if (target && typeof target[method] === 'function') { target[method](value); } } catch (ignore) {}
  return target;
}

/**
 * A structural heading is green so a person can see it is load-bearing.
 *
 * The colour is never checked on the way back in. Requiring it would mean a
 * theme change or a paste-without-formatting broke every site's guidance, which
 * is the opposite of robust. The green is an affordance for the human, and the
 * heading level is the contract with the machine.
 */
function playbookStyleParagraph_(paragraph, kind) {
  var spacing = { title: [0, 6], subtitle: [0, 14], metadata: [0, 10], marker: [18, 8], section: [16, 6], body: [0, 6] }[kind] || [0, 6];
  playbookSetIf_(paragraph, 'setSpacingBefore', spacing[0]);
  playbookSetIf_(paragraph, 'setSpacingAfter', spacing[1]);
  playbookSetIf_(paragraph, 'setLineSpacing', 1.15);
  try {
    var text = paragraph.editAsText && paragraph.editAsText();
    if (!text) { return paragraph; }
    playbookSetIf_(text, 'setFontFamily', 'Arial');
    if (kind === 'section') { playbookSetIf_(text, 'setForegroundColor', PLAYBOOK_HEADING_GREEN_); }
    if (kind === 'marker') { playbookSetIf_(text, 'setForegroundColor', PLAYBOOK_HEADING_GREEN_); }
    if (kind === 'subtitle') { playbookSetIf_(text, 'setForegroundColor', '#5F6B76'); playbookSetIf_(text, 'setFontSize', 10); }
  } catch (ignoreText) {}
  return paragraph;
}

/**
 * The Doc as a flat list of typed lines.
 *
 * This is the only function in the build that knows Google Docs exists. Every
 * decision about what the lines mean happens in Logic.gs against fixtures.
 *
 * Reading starts after the Content marker so the title and the rules banner are
 * never mistaken for guidance. If somebody deletes the marker, reading starts at
 * the top: the banner is prose that matches no heading grammar, so it is ignored
 * rather than becoming a phantom problem.
 */
function playbookDocToLines_(docId) {
  var body;
  try { body = DocumentApp.openById(docId).getBody(); }
  catch (error) { throw new Error('E_SOURCE: the operating manual could not be opened. Check that the Doc still exists and the app can reach it.'); }

  var count = body.getNumChildren(), started = false, lines = [];
  for (var m = 0; m < count; m++) {
    var probe = body.getChild(m);
    if (probe.getText && String(probe.getText()).trim() === PLAYBOOK_CONTENT_MARKER_) { started = true; break; }
  }
  var skipping = started;

  for (var i = 0; i < count; i++) {
    var child = body.getChild(i);
    var type = String(child.getType());
    var text = child.getText ? String(child.getText()) : '';
    if (skipping) {
      if (text.trim() === PLAYBOOK_CONTENT_MARKER_) { skipping = false; }
      continue;
    }
    /* Tables hold the rules banner and anything else somebody pastes in for
       people to read. Guidance is prose and lists, never a table. */
    if (type.indexOf('TABLE') !== -1) { continue; }
    if (!text.trim()) { continue; }
    if (type.indexOf('LIST_ITEM') !== -1) { lines.push({ kind: 'body', text: text }); continue; }

    var heading = '';
    try { heading = child.asParagraph && String(child.asParagraph().getHeading()); } catch (notParagraph) { heading = ''; }
    if (heading && heading.indexOf('HEADING2') !== -1) { lines.push({ kind: 'heading2', text: text }); }
    /* A heading demoted from 3 to 4 still reads. Demoting is a formatting
       accident; the situation it names has not changed. */
    else if (heading && (heading.indexOf('HEADING3') !== -1 || heading.indexOf('HEADING4') !== -1)) { lines.push({ kind: 'heading3', text: text }); }
    else if (heading && heading.indexOf('HEADING1') !== -1) { lines.push({ kind: 'heading1', text: text }); }
    else { lines.push({ kind: 'body', text: text }); }
  }
  return lines;
}

/* ============================ the checker ============================ */

function playbookHealthRow_(docId) {
  return playbookSnapshotRead_(String(docId || '')).health;
}

function playbookDocMeta_(docId) {
  var meta = { name: '', url: '', modifiedAt: '', editor: '', editorEmail: '', editorSource: 'unknown', editedAt: '' };
  try {
    var file = DriveApp.getFileById(docId);
    meta.name = String(file.getName() || '');
    meta.url = String(file.getUrl() || '');
    var updated = file.getLastUpdated();
    meta.modifiedAt = updated ? new Date(updated).toISOString() : '';
  } catch (ignore) {}
  var editor = playbookLastEditor_(docId);
  meta.editor = editor.name;
  meta.editorEmail = editor.email;
  meta.editorSource = editor.source;
  meta.editedAt = editor.at || meta.modifiedAt;
  return meta;
}

/**
 * Who last edited the Doc.
 *
 * DriveApp cannot answer this. The Drive REST call can, using the Drive access
 * the app already holds. This adapter requires the explicit external-request scope.
 *
 * If the call is unavailable for any reason the owner's name is used and the
 * source is recorded, so the screen never implies it knows more than it does.
 */
function playbookLastEditor_(docId) {
  try {
    var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(docId)
      + '?fields=modifiedTime,lastModifyingUser(displayName,emailAddress)&supportsAllDrives=true';
    var response = UrlFetchApp.fetch(url, {
      method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    });
    if (Number(response.getResponseCode()) === 200) {
      var data = JSON.parse(response.getContentText() || '{}');
      var person = data && data.lastModifyingUser;
      if (person && (person.displayName || person.emailAddress)) {
        return {
          name: String(person.displayName || person.emailAddress || ''),
          email: String(person.emailAddress || ''),
          at: data.modifiedTime ? new Date(data.modifiedTime).toISOString() : '',
          source: 'drive-api'
        };
      }
    }
  } catch (ignoreApi) {}
  try {
    var owner = DriveApp.getFileById(docId).getOwner();
    if (owner) { return { name: String(owner.getName() || owner.getEmail() || ''), email: String(owner.getEmail() || ''), at: '', source: 'owner-fallback' }; }
  } catch (ignoreOwner) {}
  return { name: '', email: '', at: '', source: 'unknown' };
}

/**
 * Parse the Doc, decide what to serve, record the health, alert if it broke.
 *
 * The last-good rule is the whole of the safety net and it is 4 lines long:
 * a parse with no problems replaces the served set, so deleting a section in
 * the Doc really deletes it; a parse with any problem only updates what it
 * could read, and everything it could not read keeps serving.
 */
function playbookCheck_(options) {
  options = options || {};
  var docId = options.docId || playbookDocId_();
  if (!docId) { return { checked: false, reason: 'no manual has been created yet' }; }

  var now = nowIso_();
  var meta = playbookDocMeta_(docId);
  var snapshot = playbookSnapshotRead_(docId,true);
  var previous = snapshot.health, served = snapshot.blocks;

  var parsed, readFailure = '';
  try {
    var index = guidanceIndex_(metricRows_(), readTable_('OrganizationUnits').map(cleanRow_), ACCESS_ROOT_UNIT_ID_);
    parsed = parseGuidanceLines_(playbookDocToLines_(docId), index, docId);
  } catch (error) {
    /* The Doc could not be opened at all. That is a break like any other: the
       last good blocks keep serving and somebody gets told. */
    readFailure = String(error && error.message ? error.message : error);
    parsed = { blocks: [], problems: [{ kind: 'not-a-heading', heading: meta.name || 'the operating manual', detail: 'the document could not be opened' }] };
  }

  var problems = parsed.problems.slice();
  if (!readFailure) { problems = problems.concat(guidanceMissingProblems_(served, parsed)); }

  var clean = problems.length === 0;
  var candidate = playbookCandidateBlocks_(docId, parsed.blocks, served, clean, problems, now);
  if (!readFailure) {
    var afterMeta = playbookDocMeta_(docId);
    if (!meta.modifiedAt || meta.modifiedAt !== afterMeta.modifiedAt) { throw new Error('E_CONFLICT: the manual changed while being read. Recheck it.'); }
  }

  var signature = guidanceAlertSignature_(problems);
  var health = {
    docId: docId,
    docName: meta.name || playbookDocName_(),
    docUrl: meta.url,
    status: clean ? 'healthy' : 'broken',
    sectionCount: parsed.blocks.length,
    problemCount: problems.length,
    problemsJson: JSON.stringify(problems),
    lastCheckedAt: now,
    lastGoodAt: clean ? now : String(previous && previous.lastGoodAt || ''),
    docModifiedAt: meta.modifiedAt,
    lastEditor: meta.editor,
    lastEditorEmail: meta.editorEmail,
    lastEditorSource: meta.editorSource,
    lastEditedAt: meta.editedAt,
    alertSignature: signature
  };
  var publication = playbookSnapshotPublish_(docId,snapshot.generationId,candidate,health);
  playbookResetCache_();

  var alerted = clean ? { sent: 0, reason: 'healthy' } : playbookAlert_(health, problems);
  return { checked: true, docId: docId, status: health.status, blocks: parsed.blocks.length, written: publication.written, generationId:publication.generationId, problems: problems, alert: alerted };
}

/**
 * Build the complete next generation in memory. Broken sections retain their last good content.
 */
function playbookCandidateBlocks_(docId, blocks, served, clean, problems, now) {
  var keepWhole = Object.create(null), next = Object.create(null);
  if (!clean) {
    (problems || []).forEach(function(problem) { if (problem.sectionKey) { keepWhole[String(problem.sectionKey)] = true; } });
    (served || []).forEach(function(row) { next[row.blockId] = cleanRow_(row); });
  }
  (blocks || []).filter(function(block) { return !keepWhole[String(block.sectionKey)]; }).forEach(function(block) {
    next[block.blockId] = {
      blockId:block.blockId, scopeUnitId:block.scopeUnitId, scopeType:block.scopeType,
      metricId:block.metricId, situation:block.situation, stepsJson:JSON.stringify(block.steps),
      sourceDocId:docId, sourceHeading:block.sourceHeading, parsedAt:now, ok:true
    };
  });
  return Object.keys(next).sort().map(function(key) { return next[key]; });
}

/** Everyone who can actually fix a broken manual. */
function playbookManagers_() {
  return readTable_('Users').map(function (row) {
    return resolveAccessUser_(String(row.email || '').trim().toLowerCase());
  }).filter(function (user) { return isPlaybookMaintainer_(user); }).map(function (user) {
    return { email: user.email, name: user.name };
  });
}

/**
 * One email per distinct break.
 *
 * The outbox keys the document, recipient, and problem signature. A log entry
 * never decides whether delivery succeeded or should be attempted again.
 */
function playbookAlert_(health, problems) {
  if (!problems.length) { return { sent: 0, reason: 'healthy' }; }
  if (!playbookAlertsEnabled_()) { return { sent: 0, reason: 'playbook alerts are switched off' }; }

  var signature = String(health.alertSignature || '');
  var ids = playbookManagers_().map(function(person) {
    var payload = {type:'playbook-broken',docId:String(health.docId),signature:signature,recipient:person.email};
    return outboxEnqueue_(operationCanonical_(payload),payload).jobId;
  });
  return Object.assign(notificationDrain_(ids,nowIso_()),{signature:signature});
}

function playbookAlertSubject_(problems) {
  return problems.length === 1
    ? '1 section of the operating manual cannot be read'
    : problems.length + ' sections of the operating manual cannot be read';
}

function playbookAlertBody_(health, problems, appUrl) {
  var lines = [];
  lines.push('Hello,');
  lines.push('');
  lines.push(problems.length === 1
    ? 'One section of ' + health.docName + ' can no longer be matched to a situation, so it is not being read.'
    : problems.length + ' sections of ' + health.docName + ' can no longer be matched to a situation, so they are not being read.');
  lines.push('');
  problems.forEach(function (problem) {
    lines.push('  - "' + String(problem.heading) + '" ' + (GUIDANCE_PROBLEM_KINDS[String(problem.kind)] || 'could not be read')
      + (problem.detail ? ' (' + String(problem.detail) + ')' : '') + '.');
  });
  lines.push('');
  if (health.lastEditor) {
    lines.push('The document was last edited by ' + health.lastEditor
      + (health.lastEditedAt ? ' on ' + niceDate_(String(health.lastEditedAt).slice(0, 10)) : '') + '.');
    if (String(health.lastEditorSource) === 'owner-fallback') {
      lines.push('That is the document owner. The exact last editor was not available.');
    }
    lines.push('');
  }
  lines.push(health.lastGoodAt
    ? 'Nothing is lost in the meantime. The app is still showing the last version it could read, from '
      + niceDate_(String(health.lastGoodAt).slice(0, 10)) + ', so no site is left without guidance.'
    : 'The app is showing the last version it could read, so no site is left without guidance.');
  lines.push('');
  lines.push('Every section starts with a heading shown in green. Putting the green heading back the way it was is all this needs.');
  if (health.docUrl) { lines.push(''); lines.push('Open the manual: ' + health.docUrl); }
  if (appUrl) { lines.push('Open the Playbook screen: ' + appUrl); }
  lines.push('');
  lines.push('This is an automatic message from ' + PRODUCT_NAME + '. You are receiving it because you maintain the operating manual.');
  return lines.join('\n');
}

/** Routine reads pin stored guidance only. Freshness is visible in health metadata;
 * live document access belongs exclusively to an explicit or scheduled refresh.
 */
function playbookEnsureFresh_() {
  var docId = playbookDocId_();
  if (!docId) { return {checked:false,reason:'no manual'}; }
  var snapshot = playbookSnapshotRead_(docId);
  return {checked:false,reason:'serving stored guidance; refresh requires a maintainer or scheduled check',generationId:snapshot.generationId};
}

/** Installed once by an administrator. Removing and recreating keeps the count
    at exactly 1 however many times this runs. */
function installPlaybookTrigger_() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return [PLAYBOOK_TRIGGER_HANDLER_, 'runPlaybookCheck'].indexOf(trigger.getHandlerFunction()) !== -1;
  });
  existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger(PLAYBOOK_TRIGGER_HANDLER_).timeBased().everyHours(PLAYBOOK_CHECK_HOURS_).create();
  return { installed: 1, removed: existing.length };
}

function runPlaybookCheck_() {
  var result = playbookCheck_({ force: true });
  result.delivery = notificationDrain_(null,nowIso_());
  return result;
}

/* ============================ serving guidance ============================ */

/**
 * The goal's scope path, most specific first.
 * Department if one is set, then the site, then every parent above it.
 */
function guidanceChainForGoal_(goal, unitIndex) {
  var units = unitIndex || accessUnitIndex_();
  var chain = [], seen = {};
  function push(unitId) {
    var id = String(unitId || '');
    while (id && !seen[id]) {
      var unit = units[id];
      if (!unit) { return; }
      seen[id] = true;
      chain.push({ unitId: id, unitType: String(unit.unitType), name: String(unit.name || '') });
      id = String(unit.parentUnitId || '');
    }
  }
  var department = String(goal && goal.departmentUnitId || '');
  if (department) { push(department); }
  var siteUnit = findAccessUnitByName_('site', String(goal && goal.site || ''));
  if (siteUnit) { push(siteUnit.unitId); }
  /* A site that never made it into OrganizationUnits still gets the
     organization's guidance rather than nothing at all. */
  if (!seen[ACCESS_ROOT_UNIT_ID_]) { push(ACCESS_ROOT_UNIT_ID_); }
  return chain;
}

/**
 * Read once per request, not once per card.
 *
 * Apps Script gives every request a fresh global scope, so this cache lives and
 * dies with one call and can never go stale in production. The offline harness
 * keeps one scope for the whole run, which would quietly turn that into a
 * long-lived cache and hide exactly the staleness bug it must not have, so the
 * lifetime is declared out loud instead of inherited from the platform.
 */
var GUIDANCE_ROW_CACHE_ = null;
function playbookResetCache_() { GUIDANCE_ROW_CACHE_ = null; PLAYBOOK_SNAPSHOT_CACHE_ = Object.create(null); }
function guidanceRows_() {
  if (!GUIDANCE_ROW_CACHE_) {
    GUIDANCE_ROW_CACHE_ = playbookSnapshotRead_(playbookDocId_()).blocks.map(cleanRow_).map(function (row) {
      var steps = [];
      try { steps = JSON.parse(String(row.stepsJson || '[]')); } catch (badJson) { steps = []; }
      row.steps = Array.isArray(steps) ? steps : [];
      return row;
    }).filter(function (row) { return row.steps.length > 0; });
  }
  return GUIDANCE_ROW_CACHE_;
}

/**
 * What the manual says about this goal, right now.
 *
 * Deterministic from end to end: the situation is the band the status engine
 * already computed, the blocks are rows somebody wrote, and the steps are the
 * exact text. There is no path through this function that produces a word the
 * manual does not contain.
 */
function guidanceForGoal_(goal, statusResult, context) {
  context = context || {};
  var situation = situationOfStatus_(statusResult && statusResult.status);
  var resolved = resolveGuidanceBlocks_(guidanceRows_(), guidanceChainForGoal_(goal, context.unitIndex), String(goal.metricId), situation);
  var health = context.health !== undefined ? context.health : playbookHealthRow_(playbookDocId_());
  return {
    situation: situation,
    situationLabel: situation ? SITUATION_LABELS[situation] : '',
    missing: resolved.missing,
    stepCount: resolved.blocks.reduce(function (total, entry) { return total + entry.row.steps.length; }, 0),
    blocks: resolved.blocks.map(function (entry) {
      return {
        blockId: String(entry.row.blockId),
        scopeType: entry.unitType,
        scopeName: entry.unitName,
        /* The organization's position is labelled as the organization's. A local
           block says which place added it, so nobody reads a site's practice as
           the network's rule. */
        label: entry.unitType === 'organization' ? 'Organization guidance' : entry.unitName + ' adds',
        steps: entry.row.steps.slice()
      };
    }),
    winnerScope: resolved.winner ? resolved.winner.unitType : '',
    winnerScopeName: resolved.winner ? resolved.winner.unitName : '',
    winnerBlockId: resolved.winner ? String(resolved.winner.row.blockId) : '',
    docName: health && isPlaybookMaintainer_(context.user) ? String(health.docName || '') : '',
    docUrl: health && isPlaybookMaintainer_(context.user) ? String(health.docUrl || '') : '',
    updatedAt: health ? String(health.lastGoodAt || health.lastCheckedAt || '') : ''
  };
}

/* ============================ the Playbook screen ============================ */

function isPlaybookMaintainer_(user) {
  return hasPermission_(user, 'playbook.manage') && Array.isArray(user.scopes) && user.scopes.some(function (scope) {
    return String(scope.scopeId) === ACCESS_ROOT_UNIT_ID_ && scopeAssignmentActive_(scope);
  });
}
function requirePlaybookMaintainer_(user) {
  if (!isPlaybookMaintainer_(user)) { throw new Error('E_FORBIDDEN: organization-wide manual access is required.'); }
}
function playbookCanManage_(user) { return isPlaybookMaintainer_(user); }
function playbookVisibleBlock_(user, row, units) {
  if (!user || !user.known || !row || !units) { return false; }
  var scopeId = String(row.scopeUnitId || '');
  if (!Object.prototype.hasOwnProperty.call(units, scopeId)) { return false; }
  var scope = units[scopeId], root = units[ACCESS_ROOT_UNIT_ID_];
  if (!scope || !root || String(root.unitType) !== 'organization' ||
      ['organization', 'program', 'division', 'region', 'site', 'department'].indexOf(String(scope.unitType)) === -1 ||
      !unitWithinScope_(scopeId, ACCESS_ROOT_UNIT_ID_, units)) { return false; }
  if (isPlaybookMaintainer_(user) || scopeId === ACCESS_ROOT_UNIT_ID_) { return true; }
  var allowedSites = sitesInScope_(user);
  return Object.keys(units).some(function (id) {
    var unit = units[id];
    return unit && String(unit.unitType) === 'site' && allowedSites.indexOf(String(unit.name)) !== -1 &&
      (unitWithinScope_(id, scopeId, units) ||
       (String(scope.unitType) === 'department' && unitWithinScope_(scopeId, id, units)));
  });
}

/** One shape for a problem wherever it is shown, so the banner and the section
    note can never disagree about what went wrong. */
function playbookProblemView_(problem) {
  return {
    kind: String(problem.kind),
    heading: String(problem.heading || ''),
    detail: String(problem.detail || ''),
    sectionKey: String(problem.sectionKey || ''),
    explained: GUIDANCE_PROBLEM_KINDS[String(problem.kind)] || 'could not be read'
  };
}

/**
 * The whole screen in 1 round trip, like every other surface here.
 * Managers get the health record; site staff get the manual and nothing else,
 * because a health banner they cannot act on is noise.
 */
function playbookBoard_(user) {
  requirePerformanceRead_(user);
  var manage = playbookCanManage_(user);
  var docId = playbookDocId_();
  if (docId) { playbookEnsureFresh_(); }
  var health = docId ? playbookHealthRow_(docId) : null;
  var metrics = metricIndex_(metricRows_());
  var units = accessUnitIndex_();

  var problems = [];
  if (health && health.problemsJson) {
    try { problems = JSON.parse(String(health.problemsJson)) || []; } catch (badJson) { problems = []; }
  }

  if (!manage) { problems = []; }
  var byMetric = Object.create(null);
  guidanceRows_().filter(function (row) { return playbookVisibleBlock_(user, row, units); }).forEach(function (row) {
    var key = String(row.metricId);
    if (!byMetric[key]) { byMetric[key] = []; }
    var unit = units[String(row.scopeUnitId)];
    byMetric[key].push({
      blockId: String(row.blockId),
      situation: String(row.situation),
      situationLabel: SITUATION_LABELS[String(row.situation)] || String(row.situation),
      scopeType: String(row.scopeType),
      scopeName: unit ? String(unit.name) : String(row.scopeUnitId),
      steps: row.steps.slice()
    });
  });

  var order = { sustain: 0, recover: 1, urgent: 2 };
  var sections = Object.keys(metrics).map(function (metricId) {
    var metric = metrics[metricId];
    var blocks = (byMetric[metricId] || []).slice().sort(function (a, b) {
      if (a.scopeType !== b.scopeType) { return a.scopeType === 'organization' ? -1 : 1; }
      return order[a.situation] - order[b.situation];
    });
    return {
      metricId: metricId,
      name: String(metric.name),
      retired: !perfActive_(metric.active),
      blocks: blocks,
      /* A problem is attached to the section it belongs to, so the screen marks
         that section rather than only shouting at the top of the page. It is
         matched on the section key the parser recorded, never on the heading
         text: the whole reason a heading is a problem is that somebody changed
         what it says, so the text is the one thing that cannot be relied on. */
      problems: problems.filter(function (problem) {
        return String(problem.sectionKey || '').split('|')[0] === metricId;
      }).map(playbookProblemView_)
    };
  }).filter(function (section) { return !section.retired || section.blocks.length; });
  sections.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

  var unattached = problems.filter(function (problem) {
    return !sections.some(function (section) { return String(problem.sectionKey || '').split('|')[0] === section.metricId; });
  });

  return {
    canManage: manage,
    generationId:playbookSnapshotRead_(docId).generationId,
    hasDoc: !!docId,
    doc: manage && health ? { docId: String(health.docId), name: String(health.docName), url: String(health.docUrl) } : null,
    health: manage && health ? {
      status: String(health.status),
      sectionCount: Number(health.sectionCount || 0),
      problemCount: Number(health.problemCount || 0),
      problems: problems.map(playbookProblemView_),
      lastCheckedAt: String(health.lastCheckedAt || ''),
      lastGoodAt: String(health.lastGoodAt || ''),
      lastEditor: String(health.lastEditor || ''),
      lastEditorEmail: String(health.lastEditorEmail || ''),
      lastEditorSource: String(health.lastEditorSource || ''),
      lastEditedAt: String(health.lastEditedAt || ''),
      alertsEnabled: playbookAlertsEnabled_()
    } : null,
    sections: sections,
    unattachedProblems: unattached.map(playbookProblemView_),
    situations: GUIDANCE_SITUATIONS.map(function (situation) { return { key: situation, label: SITUATION_LABELS[situation] }; })
  };
}

/**
 * The alert off switch and its trigger, mirroring the Performance reminder
 * settings so an administrator learns one pattern rather than two.
 */
function playbookSettings_(user, payload) {
  requirePermission_(user, 'admin.manage');
  payload = payload || {};
  if (payload.enabled !== undefined) {
    var next = payload.enabled === true ? 'true' : 'false';
    PropertiesService.getScriptProperties().setProperty('PLAYBOOK_ALERTS_ENABLED', next);
    if (next === 'true') { installPlaybookTrigger_(); }
    audit_('playbook', 'workspace', 'toggle-alerts', null, { enabled: next }, user.email);
  }
  var triggers = 0;
  try {
    triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === PLAYBOOK_TRIGGER_HANDLER_;
    }).length;
  } catch (ignore) { triggers = 0; }
  return { enabled: playbookAlertsEnabled_(), triggers: triggers, everyHours: PLAYBOOK_CHECK_HOURS_,delivery:notificationStateCounts_(['playbook-broken','playbook-remind']) };
}

function playbookEnsureDocRoute_(user) {
  var created = withLock_(function () { return playbookEnsureDoc_(user); });
  playbookCheck_({force:true});
  var board = playbookBoard_(user);
  board.created = created.created;
  return board;
}

function playbookRecheck_(user) {
  requirePlaybookMaintainer_(user);
  playbookResetCache_();
  var result = playbookCheck_({ force: true });
  playbookResetCache_();
  var board = playbookBoard_(user);
  board.checked = !!result.checked;
  return board;
}

/**
 * Ask the person who last edited the Doc to put the heading back.
 * A separate log type from the automatic alert, because this one is a person
 * deciding to send it and should go even when the automatic round already has.
 */
function playbookRemind_(user, payload) {
  requirePlaybookMaintainer_(user);
  payload = payload || {};
  var docId = playbookDocId_();
  var health = docId ? playbookHealthRow_(docId) : null;
  if (!health) { throw new Error('E_NOT_FOUND: there is no operating manual to report on yet.'); }
  if (String(health.status) !== 'broken') { throw new Error('E_VALIDATION: the manual reads cleanly right now, so there is nothing to report.'); }
  var recipient = String(health.lastEditorEmail || '').toLowerCase();
  if (!isPlaybookMaintainer_(resolveAccessUser_(recipient))) { throw new Error('E_VALIDATION: the last editor does not have current organization-wide manual access. Contact an authorized manual administrator.'); }

  // One intentional reminder per requester and break. Repeated clicks/retries
  // cannot resend an uncertain delivery; an explicit recovery UI is separate.
  var jobPayload = {type:'playbook-remind',docId:String(health.docId),signature:String(health.alertSignature || ''),recipient:recipient,requester:user.email};
  var job = outboxEnqueue_(operationCanonical_(jobPayload),jobPayload);
  notificationDrain_([job.jobId],nowIso_());
  job = operationUnique_('NotificationOutbox','jobId',job.jobId);
  var board = playbookBoard_(user);
  board.reminded = { recipient: recipient, sent: job.state === 'SENT', state:job.state, jobId:job.jobId };
  return board;
}
