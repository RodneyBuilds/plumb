/**
 * Performance.gs - the performance layer: the metric library, goals in
 * 3 kinds, monthly entry, corrections, the dashboard, and the region rollup.
 *
 * Every judgement lives in Logic.gs as a pure function. This file only reads
 * rows, checks permission and scope, and writes. Nothing here decides whether a
 * goal is on track.
 */

function perfActive_(value) { return value !== false && String(value).toUpperCase() !== 'FALSE'; }
function perfNow_() { return new Date(); }
function openPeriod_() { return openPeriodOn_(perfNow_()); }

/** Read surfaces open to anyone holding any performance permission. Each write
    is still gated on its own specific key further down. */
function requirePerformanceRead_(user) {
  if (!hasAnyPerformancePermission_(user && user.permissions)) {
    throw new Error('E_FORBIDDEN: your role does not include the performance layer.');
  }
}

/* ============================ metric library ============================ */

function metricRows_() { return performanceRows_('Metrics', 'metricId'); }
function metricIndex_(rows) {
  var index = {};
  (rows || []).forEach(function (row) { index[String(row.metricId)] = row; });
  return index;
}

function metricList_(user) {
  requirePerformanceRead_(user);
  var metrics = metricRows_(), goals = goalsVisibleTo_(user, goalRows_(), true);
  var usage = {};
  goals.forEach(function (goal) {
    if (!perfActive_(goal.active)) { return; }
    usage[String(goal.metricId)] = (usage[String(goal.metricId)] || 0) + 1;
  });
  metrics.forEach(function (metric) { metric.goalCount = usage[String(metric.metricId)] || 0; });
  metrics.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return {
    items: metrics,
    metricTypes: METRIC_TYPES.slice(),
    directions: METRIC_DIRECTIONS.slice(),
    canManage: hasPermission_(user, 'performance.metric.manage')
  };
}

function metricSave_(user, input) {
  requirePermission_(user, 'performance.metric.manage');
  input = input || {};
  return performanceRun_(user, input, 'metric.save', function (user, opId, at) {
    var steps = [];
    user = refreshUser_(user); requirePermission_(user, 'performance.metric.manage');
    var metricType = String(input.metricType || '');
    if (METRIC_TYPES.indexOf(metricType) === -1) { throw new Error('E_VALIDATION: choose what kind of measure this is.'); }
    var direction = String(input.direction || '');
    if (METRIC_DIRECTIONS.indexOf(direction) === -1) { throw new Error('E_VALIDATION: say whether a higher number or a lower number is better.'); }
    var existing = input.metricId ? findRow_('Metrics', 'metricId', String(input.metricId)) : null;
    if (input.metricId) { performanceAssertSettled_('Metrics', String(input.metricId), opId); }
    if (input.metricId && !existing) { throw new Error('E_NOT_FOUND: that metric no longer exists.'); }
    if (existing && String(existing.metricType) !== metricType) {
      throw new Error('E_VALIDATION: the kind of measure cannot change once numbers have been reported against it. Retire this metric and define a new one.');
    }
    if (existing && (input.updatedAt === undefined || String(input.updatedAt) !== String(existing.updatedAt))) { throw new Error('E_CONFLICT: this metric changed after it was opened. Reload before saving.'); }
    var name = validateText_(input.name, 'the metric name', 200, true);
    var clash = metricRows_().filter(function (row) {
      return String(row.name).trim().toLowerCase() === name.toLowerCase() && String(row.metricId) !== String(input.metricId || '');
    })[0];
    if (clash) { throw new Error('E_VALIDATION: a metric called "' + name + '" already exists.'); }

    var row = existing ? cleanRow_(existing) : {
      metricId: operationChildId_(opId, 'metric'), active: true, retiredAt: '', retiredBy: ''
    };
    row.name = name;
    row.metricType = metricType;
    row.direction = direction;
    row.description = validateText_(input.description, 'the description', 1000, false);
    if (metricType === 'percentage') {
      /* A percentage names both of its numbers, so a region total can add
         people rather than averaging percentages. */
      row.numeratorLabel = validateText_(input.numeratorLabel, 'the name of the first number', 120, true);
      row.denominatorLabel = validateText_(input.denominatorLabel, 'the name of the second number', 120, true);
      row.unit = '';
    } else {
      row.numeratorLabel = '';
      row.denominatorLabel = '';
      row.unit = validateText_(input.unit, 'the unit', 60, false);
    }
    row.updatedAt = new Date(Math.max(new Date(at).getTime(), existing && isFinite(new Date(existing.updatedAt).getTime()) ? new Date(existing.updatedAt).getTime() + 1 : 0)).toISOString();
    row.updatedBy = user.email;
    steps.push(operationStep_('Metrics', 'metricId', existing, row));
    steps.push(operationAuditStep_(opId, at, 'metric', row.metricId, existing ? 'update' : 'create', existing ? cleanRow_(existing) : null, row, user.email));
    return { steps: steps, result: { item: row, created: !existing } };
  });
}

/**
 * A metric with history is never deleted. Retiring stops new goals using it and
 * leaves every number already reported against it exactly where it is.
 */
function metricRetire_(user, input) {
  requirePermission_(user, 'performance.metric.manage');
  input = input || {};
  return performanceRun_(user, input, 'metric.retire', function (user, opId, at) {
    var steps = [];
    user = refreshUser_(user); requirePermission_(user, 'performance.metric.manage');
    var existing = findRow_('Metrics', 'metricId', String(input.metricId || ''));
    if (existing) { performanceAssertSettled_('Metrics', existing.metricId, opId); }
    if (!existing) { throw new Error('E_NOT_FOUND: that metric no longer exists.'); }
    if (existing && (input.updatedAt === undefined || String(input.updatedAt) !== String(existing.updatedAt))) { throw new Error('E_CONFLICT: this metric changed after it was opened. Reload before saving.'); }
    var before = cleanRow_(existing), row = cleanRow_(existing);
    var reinstate = input.active === true;
    row.active = reinstate;
    row.retiredAt = reinstate ? '' : at;
    row.retiredBy = reinstate ? '' : user.email;
    row.updatedAt = new Date(Math.max(new Date(at).getTime(), existing && isFinite(new Date(existing.updatedAt).getTime()) ? new Date(existing.updatedAt).getTime() + 1 : 0)).toISOString();
    row.updatedBy = user.email;
    steps.push(operationStep_('Metrics', 'metricId', existing, row));
    steps.push(operationAuditStep_(opId, at, 'metric', row.metricId, reinstate ? 'reinstate' : 'retire', before, row, user.email));
    return { steps: steps, result: { item: row } };
  });
}

/* ============================ goals ============================ */

function goalRows_() { var metricPending = operationPendingKeys_('Metrics'); return performanceRows_('Goals', 'goalId').filter(function (goal) { return !metricPending[String(goal.metricId)] && !performancePendingGoal_(goal.goalId, ''); }); }
function goalsVisibleTo_(user, rows, includeRetired) {
  return (rows || []).filter(function (goal) {
    if (!includeRetired && !perfActive_(goal.active)) { return false; }
    return rowInScope_(user.role, user, goal, regionOfFn_());
  });
}
function goalPublic_(goal, metric) {
  var out = cleanRow_(goal);
  out.target = numberOrNull_(out.target);
  out.baseline = numberOrNull_(out.baseline);
  out.onTrackPace = goalThresholds_(goal).onTrackPace;
  out.atRiskPace = goalThresholds_(goal).atRiskPace;
  out.metricName = metric ? metric.name : 'A retired metric';
  out.metricType = metric ? metric.metricType : '';
  out.direction = metric ? metric.direction : 'higher';
  out.unit = metric ? metric.unit : '';
  out.numeratorLabel = metric ? metric.numeratorLabel : '';
  out.denominatorLabel = metric ? metric.denominatorLabel : '';
  out.metricRetired = metric ? !perfActive_(metric.active) : true;
  out.commitment = goalCommitmentText_(out, metric);
  out.kindLabel = String(out.goalKind) === 'period' ? 'Target each period'
    : String(out.goalKind) === 'hold' ? 'Hold a level'
      : 'Journey to ' + niceDate_(out.targetDate);
  return out;
}

function goalList_(user) {
  requirePerformanceRead_(user);
  var metrics = metricIndex_(metricRows_());
  /* The setup list shows retired goals too, greyed out. A goal that vanished
     when it was retired could never be reinstated, and its history would look
     as though it had never existed. */
  var goals = goalsVisibleTo_(user, goalRows_(), true);
  var period = openPeriod_(), now = perfNow_();
  var actualsByGoal = actualsByGoal_(performanceRows_('Actuals', 'actualId'));
  var items = goals.map(function (goal) {
    var metric = metrics[String(goal.metricId)];
    var view = goalPublic_(goal, metric);
    view.retired = !perfActive_(goal.active);
    view.result = statusView_(computeGoalStatus_(view, actualsByGoal[String(goal.goalId)] || [], period, metric, now));
    return view;
  });
  items.sort(function (a, b) { return String(a.site + a.metricName).localeCompare(String(b.site + b.metricName)); });
  return {
    items: items,
    period: period,
    periodLabel: periodLabel_(period),
    metrics: metricRows_().filter(function (row) { return perfActive_(row.active); }),
    sites: sitesInScope_(user),
    goalKinds: GOAL_KINDS.slice(),
    defaultThresholds: DEFAULT_THRESHOLDS,
    canManage: hasPermission_(user, 'performance.goal.manage')
  };
}

function goalSave_(user, input) {
  requirePermission_(user, 'performance.goal.manage');
  input = input || {};
  return performanceRun_(user, input, 'goal.save', function (user, opId, at) {
    var steps = [];
    user = refreshUser_(user); requirePermission_(user, 'performance.goal.manage');
    var metric = findRow_('Metrics', 'metricId', String(input.metricId || ''));
    if (metric) { performanceAssertSettled_('Metrics', metric.metricId, opId); }
    if (!metric) { throw new Error('E_VALIDATION: choose a metric for this goal.'); }
    var existing = input.goalId ? findRow_('Goals', 'goalId', String(input.goalId)) : null;
    if (input.goalId) { performanceAssertSettled_('Goals', String(input.goalId), opId); }
    if (input.goalId && !existing) { throw new Error('E_NOT_FOUND: that goal no longer exists.'); }
    if (!existing && !perfActive_(metric.active)) {
      throw new Error('E_VALIDATION: that metric has been retired, so no new goal can use it.');
    }
    var site = validateText_(input.site != null ? input.site : existing && existing.site, 'the site', 200, true);
    requireRowScope_(user, { site: site }, 'performance.goal.manage');
    if (existing) {
      requireRowScope_(user, existing, 'performance.goal.manage');
      if (!versionMatches_(existing.version, input.version)) {
        throw new Error('E_CONFLICT: this goal changed after you opened it. Reload the latest version before saving.');
      }
      if (String(existing.site) !== site) {
        throw new Error('E_VALIDATION: a goal cannot move between sites. Retire this one and set a new goal at the other site.');
      }
      if (String(existing.metricId) !== String(input.metricId)) {
        throw new Error('E_VALIDATION: a goal cannot change which metric it measures. Retire this one and set a new goal.');
      }
      if (String(existing.goalKind) !== String(input.goalKind)) {
        throw new Error('E_VALIDATION: the kind of goal decides how every past month was judged, so it cannot change. Retire this one and restate the goal.');
      }
    }

    /* one goal, one site. A network commitment is this same goal
       copied to each site and added up in the rollup, never a goal that floats
       above a region with nobody accountable for it. */
    var numbers = normalizeGoalNumbers_(input, metric);
    if (!existing) {
      var duplicate = goalRows_().filter(function (row) {
        return perfActive_(row.active) && String(row.metricId) === String(input.metricId) && String(row.site) === site;
      })[0];
      if (duplicate) {
        throw new Error('E_VALIDATION: ' + site + ' already has a live goal for that metric. Retire it before setting a new one.');
      }
    }

    var now = at, before = existing ? cleanRow_(existing) : null;
    var row = existing ? cleanRow_(existing) : {
      goalId: operationChildId_(opId, 'goal'), version: 0, active: true, retiredAt: '', createdBy: user.email, createdAt: now
    };
    row.metricId = String(input.metricId);
    row.site = site;
    row.goalKind = numbers.goalKind;
    row.target = numbers.target;
    row.baseline = numbers.baseline === null ? '' : numbers.baseline;
    row.startDate = numbers.startDate;
    row.targetDate = numbers.targetDate;
    row.onTrackPace = numbers.onTrackPace;
    row.atRiskPace = numbers.atRiskPace;
    row.owner = validateText_(input.owner, 'the owner name', 200, true);
    row.ownerEmail = String(validateText_(input.ownerEmail, 'the owner email', 200, false)).toLowerCase();
    if (row.ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.ownerEmail)) {
      throw new Error('E_VALIDATION: enter a valid owner email address, or leave it blank.');
    }
    row.version = existing ? nextVersion_(existing.version) : 1;
    row.updatedBy = user.email;
    row.updatedAt = now;
    steps.push(operationStep_('Goals', 'goalId', existing, row));
    steps.push(operationAuditStep_(opId, at, 'goal', row.goalId, existing ? 'update' : 'create', before, row, user.email));
    return { steps: steps, result: { item: goalPublic_(row, cleanRow_(metric)), created: !existing } };
  });
}

function goalRetire_(user, input) {
  requirePermission_(user, 'performance.goal.manage');
  input = input || {};
  return performanceRun_(user, input, 'goal.retire', function (user, opId, at) {
    var steps = [];
    user = refreshUser_(user); requirePermission_(user, 'performance.goal.manage');
    var existing = findRow_('Goals', 'goalId', String(input.goalId || ''));
    if (existing) { performanceAssertSettled_('Goals', existing.goalId, opId); }
    if (!existing) { throw new Error('E_NOT_FOUND: that goal no longer exists.'); }
    requireRowScope_(user, existing, 'performance.goal.manage');
    if (!versionMatches_(existing.version,input.version)) { throw new Error('E_CONFLICT: this goal changed after it was opened. Reload before changing its active state.'); }
    var before = cleanRow_(existing), row = cleanRow_(existing);
    var reinstate = input.active === true;
    row.active = reinstate;
    row.retiredAt = reinstate ? '' : at;
    row.version = nextVersion_(existing.version);
    row.updatedBy = user.email;
    row.updatedAt = at;
    steps.push(operationStep_('Goals', 'goalId', existing, row));
    steps.push(operationAuditStep_(opId, at, 'goal', row.goalId, reinstate ? 'reinstate' : 'retire', before, row, user.email));
    return { steps: steps, result: { item: row } };
  });
}

/* ============================ actuals ============================ */

function actualsByGoal_(rows) {
  var byGoal = {};
  (rows || []).forEach(function (row) {
    var key = String(row.goalId);
    if (!byGoal[key]) { byGoal[key] = []; }
    byGoal[key].push(actualPublic_(row));
  });
  return byGoal;
}
function actualPublic_(row) {
  var out = cleanRow_(row);
  out.numerator = numberOrNull_(out.numerator);
  out.denominator = numberOrNull_(out.denominator);
  out.value = numberOrNull_(out.value);
  out.noData = truthy_(out.noData);
  out.period = normalizePeriod_(out.period);
  return out;
}

/** The last N periods for one goal, with a null for every month nobody
    reported. The line is never bridged across a null. */
function trajectoryOf_(rows, period) {
  var live = liveActualRows_(rows);
  var byPeriod = {};
  live.forEach(function (row) { byPeriod[String(row.period)] = row; });
  return periodsEndingAt_(period, TRAJECTORY_PERIODS).map(function (p) {
    var hit = byPeriod[p];
    return {
      period: p,
      label: periodLabel_(p),
      short: periodShort_(p),
      value: hit && !hit.noData ? hit.value : null,
      numerator: hit ? hit.numerator : null,
      denominator: hit ? hit.denominator : null,
      noData: !!(hit && hit.noData),
      reported: !!hit
    };
  });
}

/** Trim the engine result down to what a screen needs, without the raw series. */
function statusView_(result) {
  return {
    status: result.status,
    trend: result.trend,
    trendMonths: result.trendMonths || 0,
    trendChange: result.trendChange || 0,
    ratio: result.ratio,
    progress: result.progress === undefined ? null : result.progress,
    elapsed: result.elapsed === undefined ? null : result.elapsed,
    stale: result.stale || 0,
    noData: !!result.noData,
    onTrackPace: result.thresholds.onTrackPace,
    atRiskPace: result.thresholds.atRiskPace,
    latestPeriod: result.latest ? result.latest.period : '',
    latestValue: result.latest ? result.latest.value : null,
    latestNumerator: result.latest ? result.latest.numerator : null,
    latestDenominator: result.latest ? result.latest.denominator : null
  };
}

/**
 * The whole dashboard in 1 round trip.
 * Every server call on this platform costs 400 to 1500ms, so the board is
 * assembled server side and sent once rather than fetched card by card.
 */
function performanceBoard_(user, payload) {
  requirePerformanceRead_(user);
  payload = payload || {};
  var period = isValidPeriod_(payload.period) ? String(payload.period) : openPeriod_();
  var now = perfNow_();
  var metrics = metricIndex_(metricRows_());
  var goals = goalsVisibleTo_(user, goalRows_());
  var actualsByGoal = actualsByGoal_(performanceRows_('Actuals', 'actualId'));
  /* The manual is checked once for the whole board, not once per card, and only
     when the Doc has actually changed. The context is built once for the same
     reason: 20 cards must not mean 20 reads of the same 2 tables. */
  playbookEnsureFresh_();
  var guidanceContext = { user: user, unitIndex: accessUnitIndex_(), health: playbookHealthRow_(playbookDocId_()) };

  var cards = goals.map(function (goal) {
    var metric = metrics[String(goal.metricId)];
    var rows = actualsByGoal[String(goal.goalId)] || [];
    var view = goalPublic_(goal, metric);
    view.result = statusView_(computeGoalStatus_(view, rows, period, metric, now));
    view.trajectory = trajectoryOf_(rows, period);
    /* The card only needs to know whether there is something to read and how
       much of it. The words themselves belong on the goal. */
    var guidance = guidanceForGoal_(view, view.result, guidanceContext);
    view.guidance = { situation: guidance.situation, missing: guidance.missing, stepCount: guidance.stepCount };
    return view;
  });
  cards.sort(function (a, b) { return statusRank_(a.result.status) - statusRank_(b.result.status) || String(a.site + a.metricName).localeCompare(String(b.site + b.metricName)); });

  var counts = { onTrack: 0, attention: 0, unreported: 0, total: cards.length };
  cards.forEach(function (card) {
    var status = card.result.status;
    if (status === 'On track') { counts.onTrack++; }
    else if (status === 'At risk' || status === 'Off track') { counts.attention++; }
    else { counts.unreported++; }
  });

  return {
    period: period,
    periodLabel: periodLabel_(period),
    periodMonth: periodMonthName_(period),
    entryClosesOn: entryClosesOn_(period),
    entryClosesOnLabel: niceDate_(entryClosesOn_(period)),
    late: periodIsLate_(period, now),
    items: cards,
    counts: counts,
    sites: sitesInScope_(user),
    canEnter: hasPermission_(user, 'performance.enter'),
    canManageGoals: hasPermission_(user, 'performance.goal.manage')
  };
}
/** Worst first, so the brief and the cards agree about what needs attention. */
function statusRank_(status) {
  return { 'Off track': 0, 'At risk': 1, 'Not reported': 2, 'Insufficient data': 3, 'Not yet measured': 4, 'On track': 5 }[String(status)];
}

/** Everything one goal has ever reported, corrections included. */
function goalGet_(user, payload) {
  requirePerformanceRead_(user);
  payload = payload || {};
  var goal = findRow_('Goals', 'goalId', String(payload.goalId || ''));
  if (!goal) { throw new Error('E_NOT_FOUND: that goal no longer exists.'); }
  if (!rowInScope_(user.role, user, goal, regionOfFn_())) {
    throw new Error('E_FORBIDDEN: that goal is outside your access area.');
  }
  if (operationPending_('Goals',goal.goalId) || operationPending_('Metrics',goal.metricId) || performancePendingGoal_(goal.goalId,'')) { throw new Error('E_RECOVERY: this goal has an unfinished save.'); }
  var metric = findRow_('Metrics', 'metricId', String(goal.metricId));
  metric = metric ? cleanRow_(metric) : null;
  var period = isValidPeriod_(payload.period) ? String(payload.period) : openPeriod_();
  var all = readTable_('Actuals').filter(function (row) { return String(row.goalId) === String(goal.goalId); }).map(actualPublic_);
  var supersededBy = {};
  all.forEach(function (row) {
    if (row.supersedesActualId) { supersededBy[String(row.supersedesActualId)] = row; }
  });
  var history = all.slice().sort(function (a, b) {
    return periodIndex_(b.period) - periodIndex_(a.period) || String(b.enteredAt).localeCompare(String(a.enteredAt));
  }).map(function (row) {
    var replacement = supersededBy[String(row.actualId)];
    return Object.assign({}, row, {
      superseded: !!replacement,
      replacedOn: replacement ? replacement.enteredAt : '',
      replacedReason: replacement ? replacement.correctionReason : '',
      periodLabel: periodLabel_(row.period)
    });
  });
  var view = goalPublic_(goal, metric);
  view.result = statusView_(computeGoalStatus_(view, all, period, metric, perfNow_()));
  view.trajectory = trajectoryOf_(all, period);
  /* The guidance panel arrives with the goal. A second round trip for it would
     cost another 400 to 1500ms on a platform where that is the whole budget,
     and the panel is the reason somebody opened this screen. */
  playbookEnsureFresh_();
  var guidance = guidanceForGoal_(view, view.result, { user: user });
  return {
    item: view,
    metric: metric,
    period: period,
    periodLabel: periodLabel_(period),
    periodMonth: periodMonthName_(period),
    history: history,
    guidance: guidance,
    correctionReasons: CORRECTION_REASONS.slice(),
    canEnter: hasPermission_(user, 'performance.enter'),
    canManageGoals: hasPermission_(user, 'performance.goal.manage'),
    canManagePlaybook: isPlaybookMaintainer_(user),
    canOwnActions: hasPermission_(user, 'improvement.action.own')
  };
}

/** The month's worksheet for 1 site: every goal, with whatever is already in. */
function entrySheet_(user, payload) {
  requirePermission_(user, 'performance.enter');
  payload = payload || {};
  var sites = sitesInScope_(user);
  if (!sites.length) { throw new Error('E_FORBIDDEN: no site is assigned to your account.'); }
  var site = payload.site ? String(payload.site) : sites[0];
  if (sites.indexOf(site) === -1) { throw new Error('E_FORBIDDEN: that site is outside your access area.'); }
  var period = isValidPeriod_(payload.period) ? String(payload.period) : openPeriod_();
  var now = perfNow_();
  var metrics = metricIndex_(metricRows_());
  var goals = goalRows_().filter(function (goal) { return perfActive_(goal.active) && String(goal.site) === site; });
  var actualsByGoal = actualsByGoal_(performanceRows_('Actuals', 'actualId'));

  var bands = goals.map(function (goal) {
    var metric = metrics[String(goal.metricId)];
    var rows = actualsByGoal[String(goal.goalId)] || [];
    var live = liveActualRows_(rows);
    var current = live.filter(function (row) { return String(row.period) === period; })[0] || null;
    var previous = live.filter(function (row) { return periodIndex_(row.period) < periodIndex_(period) && !row.noData; }).slice(-1)[0] || null;
    var view = goalPublic_(goal, metric);
    view.current = current;
    view.previous = previous ? { period: previous.period, label: periodLabel_(previous.period), month: periodMonthName_(previous.period), value: previous.value } : null;
    view.result = statusView_(computeGoalStatus_(view, rows, period, metric, now));
    /* Everything the worksheet needs to show a live reading while somebody
       types, without the browser owning a second copy of the status rules. The
       time-elapsed fraction is computed here by the same function the engine
       uses, and a test asserts the browser's last step agrees with the engine. */
    view.preview = {
      goalKind: view.goalKind,
      target: view.target,
      baseline: view.baseline,
      direction: view.direction,
      onTrackPace: view.onTrackPace,
      atRiskPace: view.atRiskPace,
      elapsed: String(view.goalKind) === 'journey' ? journeyElapsed_(view, now) : 1
    };
    return view;
  });
  bands.sort(function (a, b) { return String(a.metricName).localeCompare(String(b.metricName)); });

  return {
    site: site,
    sites: sites,
    region: regionOfSite_(site) || '',
    period: period,
    periodLabel: periodLabel_(period),
    periodMonth: periodMonthName_(period),
    entryClosesOn: entryClosesOn_(period),
    entryClosesOnLabel: niceDate_(entryClosesOn_(period)),
    late: periodIsLate_(period, now),
    items: bands,
    filled: bands.filter(function (band) { return !!band.current; }).length
  };
}

/**
 * the entire month leaves the browser as 1 request and lands as 1
 * write inside 1 lock. Per-field autosave was the conventional alternative and
 * was rejected because Sheets serialises writes, so 12 autosaves would be 12
 * turns in the same queue.
 *
 * The write is idempotent on a submission key, so a retry after E_BUSY can
 * never double-insert.
 */
function actualSaveMonth_(user, payload) {
  requirePermission_(user, 'performance.enter');
  payload = payload || {};
  var site = validateText_(payload.site, 'the site', 200, true);
  var period = String(payload.period || '');
  if (!isValidPeriod_(period)) { throw new Error('E_VALIDATION: that is not a month the Hub recognises.'); }
  var submissionKey = validateText_(payload.submissionKey, 'the submission key', 120, true);
  if (!Array.isArray(payload.entries)) { throw new Error('E_VALIDATION: provide the worksheet entries as a list.'); }
  var entries = payload.entries;
  requireRowScope_(user, { site: site }, 'performance.enter');

  return performanceRun_(user, payload, 'actual.saveMonth', function (user, opId, at) {
    var steps = [];
    user = refreshUser_(user); requireRowScope_(user, { site: site }, 'performance.enter');
    var stored = performanceRows_('Actuals', 'actualId');
    var metrics = metricIndex_(metricRows_());
    var goalsById = {};
    readTable_('Goals').forEach(function (goal) { goalsById[String(goal.goalId)] = cleanRow_(goal); });
    var byGoal = actualsByGoal_(stored);

    var now = at, nowDate = new Date(at);
    var pending = [], skipped = 0, corrected = 0;
    var seenGoals = {};
    entries.forEach(function (entry) {
      if (seenGoals[String(entry.goalId)]) { throw new Error('E_VALIDATION: a goal appears more than once in this submission.'); } seenGoals[String(entry.goalId)] = true;
      var goal = goalsById[String(entry.goalId || '')];
      if (!goal || !perfActive_(goal.active)) { throw new Error('E_NOT_FOUND: one of these goals no longer exists. Reload the worksheet.'); }
      if (performancePendingGoal_(goal.goalId, opId)) { throw new Error('E_RECOVERY: this goal has an unfinished save.'); }
      if (String(goal.site) !== site) { throw new Error('E_FORBIDDEN: one of these goals belongs to another site.'); }
      var metric = metrics[String(goal.metricId)];
      if (metric) { performanceAssertSettled_('Metrics', metric.metricId, opId); }
    if (!metric) { throw new Error('E_CONFIG: a goal points at a metric that is missing. Ask an administrator to check the metric library.'); }
      var normalized = normalizeActualEntry_(metric, entry);

      var live = liveActualRows_(byGoal[String(goal.goalId)] || []);
      var existing = live.filter(function (row) { return String(row.period) === period; })[0] || null;
      if (existing) {
        var same = existing.noData === normalized.noData
          && numberOrNull_(existing.value) === normalized.value
          && numberOrNull_(existing.numerator) === normalized.numerator
          && numberOrNull_(existing.denominator) === normalized.denominator;
        if (same) { skipped++; return; }
        /* A changed number is a correction, never an overwrite. Inside the free
           window the author supplies no reason because the month is still open;
           outside it, the correction dialog is the only way through. */
        if (correctionNeedsApproval_(existing, user.email, nowDate)) {
          throw new Error('E_VALIDATION: ' + (metric.name || 'one of these numbers') + ' was already reported for ' + periodLabel_(period) + '. Use "Correct a number" on the goal so the change carries a reason.');
        }
        corrected++;
        pending.push(actualRow_(goal, period, normalized, submissionKey, user, now, {
          actualId: operationChildId_(opId, 'actual:' + goal.goalId),
          supersedesActualId: existing.actualId,
          correctionReason: 'Changed before the month was submitted',
          approvedBy: ''
        }));
        return;
      }
      /* Every row from one save carries the same submission key. That is what
         makes a retry after E_BUSY safe: the second attempt finds the key
         already stored and writes nothing. Rows stay distinct by actualId. */
      pending.push(actualRow_(goal, period, normalized, submissionKey, user, now, { actualId: operationChildId_(opId, 'actual:' + goal.goalId) }));
    });

    pending.forEach(function (row) { steps.push(operationStep_('Actuals', 'actualId', null, row)); });
    steps.push(operationAuditStep_(opId, at, 'actualMonth', site + '|' + period, 'save', null, { rows: pending.length, corrected: corrected, skipped: skipped, submissionKey: submissionKey }, user.email));
    return { steps: steps, result: { saved: pending.length, skipped: skipped, corrected: corrected, duplicate: false, period: period, site: site } };
  });
}

function actualRow_(goal, period, normalized, submissionKey, user, now, extra) {
  return Object.assign({
    actualId: newId_('actual'),
    goalId: String(goal.goalId),
    site: String(goal.site),
    period: period,
    numerator: normalized.numerator === null ? '' : normalized.numerator,
    denominator: normalized.denominator === null ? '' : normalized.denominator,
    value: normalized.value === null ? '' : normalized.value,
    noData: !!normalized.noData,
    note: '',
    submissionKey: submissionKey,
    supersedesActualId: '',
    correctionReason: '',
    approvedBy: '',
    enteredBy: user.email,
    enteredAt: now
  }, extra || {});
}

/**
 * A correction appends a superseding row with a reason. The
 * original is never touched, so both values stay visible in the history for as
 * long as the goal exists.
 */
function actualCorrect_(user, payload) {
  requirePermission_(user, 'performance.enter');
  payload = payload || {};
  var reason = validateText_(payload.correctionReason, 'the reason', 500, true);
  return performanceRun_(user, payload, 'actual.correct', function (user, opId, at) {
    var steps = [];
    user = refreshUser_(user); requirePermission_(user, 'performance.enter');
    var original = findRow_('Actuals', 'actualId', String(payload.actualId || ''));
    if (original) { performanceAssertSettled_('Actuals', original.actualId, opId); }
    if (!original) { throw new Error('E_NOT_FOUND: that entry no longer exists.'); }
    var alreadyReplaced = readTable_('Actuals').filter(function (row) {
      return String(row.supersedesActualId) === String(original.actualId);
    })[0];
    if (alreadyReplaced) {
      throw new Error('E_CONFLICT: that entry has already been corrected. Reload the goal and correct the current number instead.');
    }
    var goal = findRow_('Goals', 'goalId', String(original.goalId));
    if (!goal) { throw new Error('E_NOT_FOUND: that goal no longer exists.'); }
    requireRowScope_(user, goal, 'performance.enter');
    var metric = findRow_('Metrics', 'metricId', String(goal.metricId));
    if (metric) { performanceAssertSettled_('Metrics', metric.metricId, opId); }
    if (!metric) { throw new Error('E_CONFIG: that goal points at a metric that is missing.'); }

    var nowDate = new Date(at), now = at;
    var needsApproval = correctionNeedsApproval_(cleanRow_(original), user.email, nowDate);
    if (needsApproval && !hasPermission_(user, 'performance.goal.manage')) {
      throw new Error('E_FORBIDDEN: a number can be changed freely by the person who entered it for ' + CORRECTION_FREE_HOURS + ' hours. After that a manager has to make the correction. Ask whoever manages goals for this site.');
    }
    var normalized = normalizeActualEntry_(cleanRow_(metric), payload);
    var replacement = actualRow_(cleanRow_(goal), String(original.period), normalized, opId, user, now, {
      actualId: operationChildId_(opId, 'actual'),
      supersedesActualId: String(original.actualId),
      correctionReason: reason,
      approvedBy: needsApproval ? user.email : ''
    });
    steps.push(operationStep_('Actuals', 'actualId', null, replacement));
    steps.push(operationAuditStep_(opId, at, 'actual', replacement.actualId, 'correct', cleanRow_(original), replacement, user.email));
    return { steps: steps, result: { item: replacement, replaced: cleanRow_(original), approved: needsApproval } };
  });
}

/* ============================ region rollup ============================ */

/**
 * The rollup shows its working. Every figure lists the sites it came from and
 * states the arithmetic in words, because a regional number nobody can check is
 * a number nobody should act on.
 */
function performanceRollup_(user, payload) {
  requirePerformanceRead_(user);
  payload = payload || {};
  var period = isValidPeriod_(payload.period) ? String(payload.period) : openPeriod_();
  var metrics = metricIndex_(metricRows_());
  var goals = goalsVisibleTo_(user, goalRows_());
  var actualsByGoal = actualsByGoal_(performanceRows_('Actuals', 'actualId'));

  var grouped = {};
  goals.forEach(function (goal) {
    var metric = metrics[String(goal.metricId)];
    if (!metric) { return; }
    var live = liveActualRows_(actualsByGoal[String(goal.goalId)] || []);
    var current = live.filter(function (row) { return String(row.period) === period; })[0] || null;
    var key = String(goal.metricId);
    if (!grouped[key]) { grouped[key] = { metric: cleanRow_(metric), parts: [], missing: [] }; }
    if (current) {
      grouped[key].parts.push({
        site: String(goal.site), goalId: String(goal.goalId),
        numerator: current.numerator, denominator: current.denominator,
        value: current.value, noData: current.noData
      });
    } else {
      grouped[key].missing.push(String(goal.site));
    }
  });

  var blocks = Object.keys(grouped).map(function (key) {
    var group = grouped[key];
    var rolled = rollupParts_(group.metric, group.parts);
    return {
      metric: group.metric,
      kind: rolled.kind,
      parts: rolled.parts,
      skipped: rolled.skipped,
      missing: group.missing,
      total: rolled.total,
      numerator: rolled.numerator === undefined ? null : rolled.numerator,
      denominator: rolled.denominator === undefined ? null : rolled.denominator,
      naiveAverage: rolled.naiveAverage,
      formula: rolled.formula,
      caveat: rolled.caveat
    };
  });
  blocks.sort(function (a, b) { return String(a.metric.name).localeCompare(String(b.metric.name)); });

  return {
    period: period,
    periodLabel: periodLabel_(period),
    periodMonth: periodMonthName_(period),
    scopeName: user.primaryScopeName || 'your access area',
    siteCount: sitesInScope_(user).length,
    blocks: blocks
  };
}

/** One accepted command stores its full row plan before any business write. */
function performanceRun_(user, payload, action, build) {
  return withLock_(function () {
    var key = validateText_(payload.submissionKey, 'submission key', 120, true);
    var command = {actor:user.email,action:action,submissionKey:key,payload:payload};
    var operation = operationRunLocked_(command, function (opId, at) {
      var plan = build(user, opId, at);
      plan.steps.push(operationAuditStep_(opId,at,'performanceCommand',opId,action,null,plan.result,user.email));
      return plan.steps;
    }, {tableKeys:{Metrics:'metricId',Goals:'goalId',Actuals:'actualId',AuditLog:'id'},authorize:function () {
      user = refreshUser_(user);
      var permission = action.indexOf('metric.') === 0 ? 'performance.metric.manage' : action.indexOf('goal.') === 0 ? 'performance.goal.manage' : 'performance.enter';
      requirePermission_(user,permission);
      if (payload.site) { requireRowScope_(user,{site:payload.site},permission); }
      var goal = payload.goalId ? findRow_('Goals','goalId',String(payload.goalId)) : null;
      if (payload.goalId && !goal) { throw new Error('E_NOT_FOUND: this goal no longer exists.'); }
      if (payload.metricId && !findRow_('Metrics','metricId',String(payload.metricId))) { throw new Error('E_NOT_FOUND: this metric no longer exists.'); }
      if (payload.actualId) {
        var actual = findRow_('Actuals','actualId',String(payload.actualId));
        if (!actual) { throw new Error('E_NOT_FOUND: this entry no longer exists.'); }
        goal = findRow_('Goals','goalId',String(actual.goalId));
        if (!goal) { throw new Error('E_NOT_FOUND: this goal no longer exists.'); }
        if (correctionNeedsApproval_(cleanRow_(actual),user.email,perfNow_())) { requirePermission_(user,'performance.goal.manage'); }
      }
      if (goal) { requireRowScope_(user,goal,permission); }
      if (action === 'actual.saveMonth') {
        (payload.entries || []).forEach(function (entry) {
          var entryGoal = findRow_('Goals','goalId',String(entry.goalId));
          if (!entryGoal) { throw new Error('E_NOT_FOUND: one of these goals no longer exists.'); }
          requireRowScope_(user,entryGoal,permission);
          if (String(entryGoal.site) !== String(payload.site)) { throw new Error('E_FORBIDDEN: a goal belongs to another site.'); }
        });
      }

    }});
    var resultId = operationChildId_(operation.operationId,'audit:performanceCommand:'+operation.operationId+':'+action);
    var receiptResult = operationUnique_('AuditLog','id',resultId);
    if (!receiptResult) { throw new Error('E_RECOVERY: completed command result is missing.'); }
    var result = JSON.parse(receiptResult.afterJson);
    result.duplicate = operation.duplicate;
    return result;
  });
}
function performanceAssertSettled_(table, id, ownOperation) {
  var pending = {};
  readTable_('Operations').forEach(function (row) { if (row.status !== 'COMMITTED' && row.status !== 'CANCELLED' && row.operationId !== ownOperation) { pending[row.operationId] = true; } });
  if (readTable_('OperationSteps').some(function (step) { return pending[step.operationId] && step.table === table && String(step.recordKey) === String(id); })) { throw new Error('E_RECOVERY: a previous save of this record needs recovery.'); }
}
function performanceRows_(table, key) {
  var pending = operationPendingKeys_(table);
  return readTable_(table).filter(function (row) { return !pending[String(row[key])]; }).map(cleanRow_);
}

function performancePendingGoal_(goalId, ownOperation) {
  var pending = {};
  readTable_('Operations').forEach(function (row) { if (row.status !== 'COMMITTED' && row.status !== 'CANCELLED' && row.operationId !== ownOperation) { pending[row.operationId] = true; } });
  return readTable_('OperationSteps').some(function (step) {
    if (!pending[step.operationId] || step.table !== 'Actuals') { return false; }
    try { return String(JSON.parse(step.afterJson).goalId) === String(goalId); } catch (invalid) { return true; }
  });
}
