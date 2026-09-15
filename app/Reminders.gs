/**
 * Reminders.gs - data-due reminders, so that entering the month's numbers does
 * not depend on people remembering.
 *
 * 2 rounds per period, sent only to owners who still have
 * something missing. One email per person listing everything they owe, rather
 * than one email per goal, because a person with 6 goals should get 1 message.
 *
 * One durable outbox job per recipient, period, and round prevents repeats.
 * NotificationLog is a compatibility projection, never the retry boundary.
 *
 * Nothing here sends anything until REMINDERS_ENABLED is turned on. A build
 * that can email real people by default is a build that emails real people by
 * accident.
 */

var REMINDERS_TRIGGER_HANDLER_ = 'runDataDueReminders_';

function remindersEnabled_() {
  return String(PropertiesService.getScriptProperties().getProperty('REMINDERS_ENABLED') || '').toLowerCase() === 'true';
}

function reminderRoundForDay_(dayOfMonth) {
  return REMINDER_ROUNDS.filter(function (round) { return round.dayOfMonth === Number(dayOfMonth); })[0] || null;
}

/**
 * Who owes what, for a given period. Pure enough to preview safely: it reads
 * rows and sends nothing.
 */
function dataDueOutstanding_(period) {
  var goals = readTable_('Goals').map(cleanRow_).filter(function (goal) {
    return goal.active !== false && String(goal.active).toUpperCase() !== 'FALSE';
  });
  var metrics = metricIndex_(metricRows_());
  var byGoal = actualsByGoal_(readTable_('Actuals').map(cleanRow_));
  var outstanding = [];
  goals.forEach(function (goal) {
    var live = liveActualRows_(byGoal[String(goal.goalId)] || []);
    var reported = live.some(function (row) { return String(row.period) === String(period); });
    if (reported) { return; }
    var metric = metrics[String(goal.metricId)];
    outstanding.push({
      goalId: String(goal.goalId),
      site: String(goal.site),
      owner: String(goal.owner || ''),
      recipient: String(goal.ownerEmail || '').toLowerCase(),
      metricName: metric ? String(metric.name) : 'A retired metric'
    });
  });
  return outstanding;
}

function previewDataDueReminders_(user, payload) {
  requirePermission_(user, 'performance.goal.manage');
  payload = payload || {};
  var period = isValidPeriod_(payload.period) ? String(payload.period) : openPeriod_();
  var allowedSites = sitesInScope_(user);
  var outstanding = dataDueOutstanding_(period).filter(function (item) { return allowedSites.indexOf(item.site) !== -1; });
  var byRecipient = Object.create(null);
  var unaddressed = [];
  outstanding.forEach(function (item) {
    if (!item.recipient) { unaddressed.push(item); return; }
    if (!byRecipient[item.recipient]) { byRecipient[item.recipient] = []; }
    byRecipient[item.recipient].push(item);
  });
  return {
    period: period,
    periodLabel: periodLabel_(period),
    enabled: remindersEnabled_(),
    rounds: REMINDER_ROUNDS.map(function (round) {
      return { type: round.type, sendsOn: entryReminderDate_(period, round), label: round.label };
    }),
    recipients: Object.keys(byRecipient).sort().map(function (email) {
      return { recipient: email, items: byRecipient[email] };
    }),
    unaddressed: unaddressed
  };
}

function entryReminderDate_(period, round) {
  var next = periodFromIndex_(periodIndex_(period) + 1);
  return next + '-' + String(round.dayOfMonth).padStart(2, '0');
}

/**
 * The trigger entry point. Installed to run once a day; it decides for itself
 * whether today is a reminder day, which keeps the trigger count at 1.
 */
function runDataDueReminders_() {
  var now = new Date();
  var round = reminderRoundForDay_(now.getDate());
  if (!round) { return notificationDrain_(null, now.toISOString()); }
  return sendDataDueRound_(openPeriodOn_(now), round, now);
}

function sendDataDueRound_(period, round, now) {
  if (!remindersEnabled_()) {
    return { ran: false, reason: 'reminders are switched off', period: period, type: round.type };
  }
  var outstanding = dataDueOutstanding_(period);
  if (!outstanding.length) { return { ran: true, sent: 0, skipped: 0, period: period, type: round.type }; }

  var byRecipient = Object.create(null), skipped = 0;
  outstanding.forEach(function (item) {
    if (!reminderRecipientAllowed_(item)) { skipped++; return; }
    if (!byRecipient[item.recipient]) { byRecipient[item.recipient] = []; }
    byRecipient[item.recipient].push(item);
  });

  var ids = [];
  Object.keys(byRecipient).forEach(function (recipient) {
    var payload = {type:'data-due',period:String(period),roundType:String(round.type),recipient:recipient};
    ids.push(outboxEnqueue_(operationCanonical_(payload),payload).jobId);
  });
  var delivered = notificationDrain_(ids,new Date(now || Date.now()).toISOString());
  return Object.assign(delivered,{ran:true,skipped:skipped,period:period,type:round.type});
}

/** Current applicability and authorization are resolved after each durable claim. */
function notificationPrepare_(payload, now) {
  var appUrl = '';
  try { appUrl = ScriptApp.getService().getUrl() || ''; } catch (ignore) {}
  if (payload.type === 'data-due') {
    if (!remindersEnabled_() || String(payload.period) !== openPeriodOn_(new Date(now))) { return null; }
    var round = REMINDER_ROUNDS.filter(function(r) { return r.type === payload.roundType; })[0];
    if (!round) { return null; }
    var items = dataDueOutstanding_(payload.period).filter(function(item) { return item.recipient === payload.recipient && reminderRecipientAllowed_(item); });
    if (!items.length) { return null; }
    return {message:{to:payload.recipient,subject:reminderSubject_(payload.period,round,items.length),body:reminderBody_(payload.period,round,items,appUrl)},logType:round.type,period:payload.period,recordIds:items.map(function(item) { return item.goalId; })};
  }
  if (payload.type === 'playbook-broken' || payload.type === 'playbook-remind') {
    if (payload.type === 'playbook-broken' && !playbookAlertsEnabled_()) { return null; }
    if (!isPlaybookMaintainer_(resolveAccessUser_(payload.recipient))) { return null; }
    if (payload.type === 'playbook-remind' && !isPlaybookMaintainer_(resolveAccessUser_(payload.requester))) { return null; }
    // Notification eligibility must follow the current pointer, not a screen's
    // request-pinned generation from before another refresh completed.
    var health = playbookSnapshotRead_(payload.docId,true).health;
    if (!health || String(health.status) !== 'broken' || String(health.alertSignature) !== payload.signature || String(playbookDocId_()) !== payload.docId) { return null; }
    var problems = JSON.parse(String(health.problemsJson || '[]'));
    return {message:{to:payload.recipient,subject:playbookAlertSubject_(problems),body:playbookAlertBody_(health,problems,appUrl)},logType:payload.type,period:payload.signature,recordIds:[payload.docId]};
  }
  return null;
}

/** At most 20 claims per invocation. No job is sent without a fresh preparation. */
function notificationDrain_(jobIds, now) {
  var result = {ran:true,sent:0,logged:0,unknown:0,retryable:0,failed:0,cancelled:0,jobs:[]};
  for (var count=0;count<20;count++) {
    var prepared = null;
    var delivery = outboxDispatchOne_({
      eligible:function(row) { return !jobIds || jobIds.indexOf(row.jobId) !== -1; },
      preflight:function() {
        if (MailApp.getRemainingDailyQuota && MailApp.getRemainingDailyQuota() < 1) { throw new Error('E_BUSY: daily mail allowance is exhausted.'); }
      },
      prepare:function(payload) {
        prepared = notificationPrepare_(payload,now);
        return prepared ? prepared.message : null;
      },
      send:function(message) { MailApp.sendEmail(message); }
    },now);
    if (!delivery.jobId) { break; }
    result.jobs.push({jobId:delivery.jobId,state:delivery.state});
    if (delivery.state === 'SENT') {
      result.sent++;
      // A failed projection cannot revert confirmed delivery or cause another send.
      try {
        withLock_(function() {
          prepared.recordIds.forEach(function(id) {
            var log = {notificationId:operationChildId_(delivery.jobId,'log:'+id),type:prepared.logType,period:prepared.period,goalId:id,recipient:prepared.message.to,sentAt:delivery.acceptedAt,result:'sent'};
            operationPut_('NotificationLog','notificationId',operationRow_('NotificationLog',log)); result.logged++;
          });
        });
      } catch (projectionError) { result.projectionIncomplete = true; }
    } else if (delivery.state === 'UNKNOWN') { result.unknown++; }
    else if (delivery.state === 'RETRYABLE') { result.retryable++; }
    else if (delivery.state === 'FAILED') { result.failed++; }
    else if (delivery.state === 'CANCELLED') { result.cancelled++; }
  }
  return result;
}

function notificationStateCounts_(types) {
  var counts = {PENDING:0,SENDING:0,RETRYABLE:0,SENT:0,UNKNOWN:0,FAILED:0,CANCELLED:0};
  readTable_('NotificationOutbox').forEach(function(row) {
    var payload; try { payload = JSON.parse(row.payloadJson); } catch(ignore) { return; }
    if (types.indexOf(payload.type) !== -1 && Object.prototype.hasOwnProperty.call(counts,row.state)) { counts[row.state]++; }
  });
  return counts;
}

function reminderSubject_(period, round, count) {
  return round.label + ': ' + count + ' ' + (count === 1 ? 'number' : 'numbers') + ' for ' + periodLabel_(period);
}

function reminderBody_(period, round, items, appUrl) {
  var lines = [];
  lines.push('Hello,');
  lines.push('');
  lines.push(round.type === 'data-due-2'
    ? 'Entry for ' + periodLabel_(period) + ' closes tomorrow, ' + niceDate_(entryClosesOn_(period)) + '.'
    : 'The numbers for ' + periodLabel_(period) + ' are due. Entry closes on ' + niceDate_(entryClosesOn_(period)) + '.');
  lines.push('');
  lines.push(items.length === 1 ? 'One goal still has no number:' : items.length + ' goals still have no number:');
  lines.push('');
  items.forEach(function (item) { lines.push('  - ' + item.metricName + ' at ' + item.site); });
  lines.push('');
  lines.push('If there is genuinely nothing to report for a month, say so in the worksheet. That is recorded as a real answer and is not the same as reporting zero.');
  if (appUrl) {
    lines.push('');
    lines.push('Open the worksheet: ' + appUrl);
  }
  lines.push('');
  lines.push('This is an automatic message from ' + PRODUCT_NAME + '. You are receiving it because you own these goals.');
  return lines.join('\n');
}

/**
 * Installed once, by an administrator, from Setup. Removing and recreating
 * keeps the trigger count at exactly 1 however many times this is run.
 */
function installReminderTrigger_() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return [REMINDERS_TRIGGER_HANDLER_, 'runDataDueReminders'].indexOf(trigger.getHandlerFunction()) !== -1;
  });
  existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger(REMINDERS_TRIGGER_HANDLER_).timeBased().atHour(8).everyDays(1).create();
  return { installed: 1, removed: existing.length };
}

function reminderSettings_(user, payload) {
  requirePermission_(user, 'admin.manage');
  payload = payload || {};
  if (payload.enabled !== undefined) {
    var next = payload.enabled === true ? 'true' : 'false';
    PropertiesService.getScriptProperties().setProperty('REMINDERS_ENABLED', next);
    if (next === 'true') { installReminderTrigger_(); }
    audit_('reminders', 'workspace', 'toggle', null, { enabled: next }, user.email);
  }
  var triggers = 0;
  try {
    triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === REMINDERS_TRIGGER_HANDLER_;
    }).length;
  } catch (ignore) { triggers = 0; }
  return { enabled: remindersEnabled_(), triggers: triggers, rounds: REMINDER_ROUNDS.slice(),delivery:notificationStateCounts_(['data-due']) };
}

/** A configured address never grants access to a goal or its notification. */
function reminderRecipientAllowed_(item) {
  var user = resolveAccessUser_(String(item.recipient || '').trim().toLowerCase());
  return !!user && hasPermission_(user, 'performance.enter') && sitesInScope_(user).indexOf(String(item.site)) !== -1;
}
