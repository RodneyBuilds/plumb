/**
 * Logic.gs - pure domain rules for intake and the performance
 * layer. No Apps Script globals belong here, so every rule in this file is
 * testable offline in plain Node.
 */

/**
 * The product name lives here and nowhere else.
 * A static test fails if this literal appears anywhere else in the deployable
 * app, and an integration test fails if it is ever written into client data.
 * Renaming the product is meant to stay a one-line change plus a docs pass.
 */
var PRODUCT_NAME = 'Plumb';

var ROLES = ['admin', 'regional', 'site', 'viewer'];

var DEFAULT_ROLES = [
  { roleKey: 'admin', displayName: 'Administrator', description: 'Manages Intake, performance setup, access, sites, and workspace settings.', displayOrder: 10, defaultScopeType: 'organization', active: true },
  { roleKey: 'regional', displayName: 'Regional staff', description: 'Creates and manages Intake requests and performance goals in assigned regions and sites.', displayOrder: 20, defaultScopeType: 'region', active: true },
  { roleKey: 'site', displayName: 'Site staff', description: 'Creates and follows Intake requests and enters monthly numbers for assigned sites.', displayOrder: 30, defaultScopeType: 'site', active: true },
  { roleKey: 'viewer', displayName: 'Viewer', description: 'Can sign in and review their access, but cannot open operational records.', displayOrder: 40, defaultScopeType: 'organization', active: true }
];

var DEFAULT_PERMISSIONS = [
  { permissionKey: 'app.read', displayName: 'Open the app', description: 'Sign in and open the application.', category: 'Application' },
  { permissionKey: 'intake.read', displayName: 'View Intake', description: 'View Intake requests within assigned scope.', category: 'Intake' },
  { permissionKey: 'intake.create', displayName: 'Create Intake', description: 'Create Intake requests within assigned scope.', category: 'Intake' },
  { permissionKey: 'intake.manage', displayName: 'Manage Intake', description: 'Triage, assign, advance, resolve, and close Intake requests within assigned scope.', category: 'Intake' },
  { permissionKey: 'performance.enter', displayName: 'Enter monthly numbers', description: 'Enter and correct monthly numbers for assigned sites.', category: 'Performance' },
  { permissionKey: 'performance.goal.manage', displayName: 'Manage goals', description: 'Create, revise, and retire performance goals within assigned scope.', category: 'Performance' },
  { permissionKey: 'performance.metric.manage', displayName: 'Manage the metric library', description: 'Define and retire the metrics every site reports against.', category: 'Performance' },
  { permissionKey: 'admin.manage', displayName: 'Manage administration', description: 'Manage people, scopes, sites, and branding.', category: 'Administration' },
  { permissionKey: 'playbook.manage', displayName: 'Maintain the operating manual', description: 'Create and repair the maintained manual, and see whether the app can still read it.', category: 'Playbook' },
  { permissionKey: 'improvement.action.manage', displayName: 'Manage improvement actions', description: 'Confirm an action and record the number before and after it.', category: 'Improvement' },
  { permissionKey: 'improvement.action.own', displayName: 'Own and update an action', description: 'Start an action from the manual and move it to done within assigned scope.', category: 'Improvement' }
];

/** The 3 performance permissions. Holding any one of them opens the read-only
    performance surfaces; each write is still gated on its own specific key. */
var PERFORMANCE_PERMISSIONS = ['performance.enter', 'performance.goal.manage', 'performance.metric.manage'];

var DEFAULT_ROLE_PERMISSIONS = (function () {
  var rows = [];
  function allow(roleKey, ceiling, keys) {
    keys.forEach(function (key) { rows.push({ rolePermissionId: roleKey + ':' + key, roleKey: roleKey, permissionKey: key, scopeCeiling: ceiling, active: true }); });
  }
  allow('admin', 'organization', ['app.read', 'intake.read', 'intake.create', 'intake.manage', 'performance.enter', 'performance.goal.manage', 'performance.metric.manage', 'admin.manage', 'playbook.manage', 'improvement.action.manage', 'improvement.action.own']);
  allow('regional', 'region', ['app.read', 'intake.read', 'intake.create', 'intake.manage', 'performance.enter', 'performance.goal.manage', 'playbook.manage', 'improvement.action.manage', 'improvement.action.own']);
  /* Site staff read the manual and own the work; they never write either the
     manual or the verdict on whether an action moved the number. */
  allow('site', 'site', ['app.read', 'intake.read', 'intake.create', 'performance.enter', 'improvement.action.own']);
  allow('viewer', 'organization', ['app.read']);
  return rows;
}());

var INTAKE_STATUSES = ['New', 'Triaged', 'Assigned', 'In Progress', 'Waiting', 'Resolved', 'Closed'];
var INTAKE_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
var INTAKE_TYPES = ['Program support', 'Performance concern', 'Staffing or coverage', 'Data and reporting', 'Process improvement', 'Training or coaching', 'Other'];
var INTAKE_TRANSITIONS = {
  'New': ['Triaged', 'Closed'], 'Triaged': ['Assigned', 'Waiting', 'Closed'],
  'Assigned': ['In Progress', 'Waiting', 'Closed'], 'In Progress': ['Waiting', 'Resolved', 'Closed'],
  'Waiting': ['Assigned', 'In Progress', 'Resolved', 'Closed'], 'Resolved': ['In Progress', 'Closed'], 'Closed': ['Triaged']
};

/* ============================ Performance constants ============================ */

var METRIC_TYPES = ['count', 'percentage', 'average'];
var METRIC_DIRECTIONS = ['higher', 'lower'];
var GOAL_KINDS = ['period', 'journey', 'hold'];
var GOAL_STATUSES = ['Not yet measured', 'Insufficient data', 'Not reported', 'On track', 'At risk', 'Off track'];
var TREND_DIRECTIONS = ['Improving', 'Declining', 'Flat', 'Unknown'];

/** a trend needs 2 consecutive moves in one direction, and the run
    length is always stated on screen rather than hidden behind the word trend. */
var TREND_MIN_RUN = 2;

/** Default pacing thresholds are configurable for each goal and visible to readers. */
var DEFAULT_THRESHOLDS = { onTrackPace: 0.9, atRiskPace: 0.6 };

/** The signature element draws the last 6 periods. */
var TRAJECTORY_PERIODS = 6;

/** Entry for a month closes on this day of the following month. Late entry is
    still accepted, because refusing it would lose real data; it is labelled
    late instead of blocked. */
var PERIOD_CLOSE_DAY = 5;

/** the original author may correct their own number freely for 48
    hours. After that a correction needs manager approval. The original row
    always survives either way. */
var CORRECTION_FREE_HOURS = 48;

var CORRECTION_REASONS = ['Data entry error', 'Source system backfill', 'Definition changed', 'Something else'];

/** 2 reminder rounds per period to owners with something missing. */
var REMINDER_ROUNDS = [
  { type: 'data-due-1', dayOfMonth: 1, label: 'Numbers are due' },
  { type: 'data-due-2', dayOfMonth: 4, label: 'Numbers are due tomorrow' }
];

var NAV = [
  { id: 'home', label: 'Home', group: '', permission: 'app.read', roles: ROLES.slice() },
  { id: 'performance', label: 'Performance', group: 'This month', anyPermission: PERFORMANCE_PERMISSIONS.slice(), roles: ['admin', 'regional', 'site'] },
  { id: 'entry', label: 'Enter numbers', group: 'This month', permission: 'performance.enter', roles: ['admin', 'regional', 'site'] },
  /* The complete improvement action workflow is planned. Its permission and its table ship now,
     because the migration is additive and runs once, but a navigation item with
     no screen behind it is a broken promise on a live gate. */
  { id: 'rollup', label: 'Region rollup', group: 'This month', anyPermission: PERFORMANCE_PERMISSIONS.slice(), requiresMultiSite: true, roles: ['admin', 'regional'] },
  { id: 'intake', label: 'Intake', group: 'Work', permission: 'intake.read', roles: ['admin', 'regional', 'site'] },
  { id: 'goals', label: 'Goals', group: 'Set up', permission: 'performance.goal.manage', roles: ['admin', 'regional'] },
  { id: 'metrics', label: 'Metric library', group: 'Set up', permission: 'performance.metric.manage', roles: ['admin'] },
  /* The manual is readable by anyone who works the monthly cycle. Only a holder
     of playbook.manage sees its health or can repair it. */
  { id: 'playbook', label: 'Playbook', group: 'Set up', anyPermission: PERFORMANCE_PERMISSIONS.slice(), roles: ['admin', 'regional', 'site'] },
  { id: 'access', label: 'My access', group: 'Account', permission: 'app.read', roles: ROLES.slice() },
  { id: 'admin', label: 'Admin', group: 'System', permission: 'admin.manage', roles: ['admin'] }
];

var SHEETS = [
  { name: 'GuidanceSnapshots', headers: ['snapshotRowId','generationId','docId','blockId','contentJson'] },
  { name: 'PlaybookSnapshots', headers: ['generationId','docId','parentGeneration','createdAt','healthJson','blockCount','contentHash'] },
  { name: 'PlaybookPointers', headers: ['docId','generationId'] },
  { name: 'Operations', headers: ['operationId','actor','action','submissionKey','commandHash','planHash','stepCount','status','createdAt','updatedAt','failureCode'] },
  { name: 'OperationSteps', headers: ['stepId','operationId','position','table','recordKey','keyColumn','beforeHash','afterJson','afterHash'] },
  { name: 'NotificationOutbox', headers: ['jobId','dedupeKey','payloadHash','payloadJson','state','attempts','nextAttemptAt','claimToken','claimedAt','acceptedAt','updatedAt','failureCode'] },
  { name: 'OrganizationUnits', headers: ['unitId', 'unitType', 'parentUnitId', 'name', 'code', 'active', 'updatedAt', 'updatedBy'] },
  { name: 'Users', headers: ['userId', 'email', 'name', 'roleKey', 'active', 'updatedAt', 'updatedBy'] },
  { name: 'Roles', headers: ['roleKey', 'displayName', 'description', 'displayOrder', 'defaultScopeType', 'active', 'updatedAt', 'updatedBy'] },
  { name: 'Permissions', headers: ['permissionKey', 'displayName', 'description', 'category', 'active', 'updatedAt', 'updatedBy'] },
  { name: 'RolePermissions', headers: ['rolePermissionId', 'roleKey', 'permissionKey', 'scopeCeiling', 'active', 'updatedAt', 'updatedBy'] },
  { name: 'UserScopes', headers: ['userScopeId', 'userId', 'scopeType', 'scopeId', 'primary', 'assignmentType', 'startsOn', 'endsOn', 'status', 'reason', 'approvedBy', 'assignedBy', 'updatedAt'], textColumns: ['startsOn','endsOn','updatedAt'] },
  { name: 'Sites', headers: ['site', 'region', 'active'] },
  { name: 'Intake', headers: ['id', 'requestNumber', 'submissionKey', 'version', 'title', 'requestType', 'site', 'region', 'description', 'priority', 'impact', 'desiredOutcome', 'requestedSupport', 'contactName', 'contactEmail', 'sourceUrl', 'targetDate', 'status', 'owner', 'nextStep', 'dueDate', 'submittedBy', 'submittedAt', 'updatedBy', 'updatedAt', 'archived'] },
  { name: 'IntakeHistory', headers: ['id', 'intakeId', 'requestNumber', 'action', 'fromStatus', 'toStatus', 'fromVersion', 'toVersion', 'note', 'actor', 'at'] },
  { name: 'Metrics', headers: ['metricId', 'name', 'metricType', 'unit', 'direction', 'numeratorLabel', 'denominatorLabel', 'description', 'active', 'retiredAt', 'retiredBy', 'updatedAt', 'updatedBy'] },
  /* Department scope is reserved in the schema; department authoring is not exposed. */
  { name: 'Goals', headers: ['goalId', 'metricId', 'site', 'goalKind', 'target', 'baseline', 'startDate', 'targetDate', 'onTrackPace', 'atRiskPace', 'owner', 'ownerEmail', 'departmentUnitId', 'version', 'active', 'retiredAt', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'] },
  { name: 'Actuals', headers: ['actualId', 'goalId', 'site', 'period', 'numerator', 'denominator', 'value', 'noData', 'note', 'submissionKey', 'supersedesActualId', 'correctionReason', 'approvedBy', 'enteredBy', 'enteredAt'], textColumns: ['period'] },
  { name: 'NotificationLog', headers: ['notificationId', 'type', 'period', 'goalId', 'recipient', 'sentAt', 'result'], textColumns: ['period'] },
  /* The served copy of the manual. The app never parses the Doc while somebody
     is waiting for guidance; the checker writes these rows and serving is a
     lookup. It is also what keeps working when the Doc breaks. */
  { name: 'GuidanceBlocks', headers: ['blockId', 'scopeUnitId', 'scopeType', 'metricId', 'situation', 'stepsJson', 'sourceDocId', 'sourceHeading', 'parsedAt', 'ok'] },
  { name: 'PlaybookHealth', headers: ['docId', 'docName', 'docUrl', 'status', 'sectionCount', 'problemCount', 'problemsJson', 'lastCheckedAt', 'lastGoodAt', 'docModifiedAt', 'lastEditor', 'lastEditorEmail', 'lastEditorSource', 'lastEditedAt', 'alertSignature'] },
  { name: 'Actions', headers: ['actionId', 'goalId', 'site', 'metricId', 'submissionKey', 'title', 'steps', 'owner', 'ownerEmail', 'dueDate', 'status', 'sourceScope', 'sourceSituation', 'sourceBlockId', 'baselinePeriod', 'baselineValue', 'verifiedPeriod', 'verifiedValue', 'version', 'supersedesActionId', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'], textColumns: ['baselinePeriod', 'verifiedPeriod'] },
  { name: 'AuditLog', headers: ['id', 'entity', 'recordId', 'action', 'beforeJson', 'afterJson', 'actor', 'at'] }
];
SHEETS.forEach(function (spec) {
  var dateHeaders = spec.headers.filter(function (header) { return /(?:At|Date|On|Hash)$/.test(header) || ['period','baselinePeriod','verifiedPeriod'].indexOf(header) !== -1; });
  spec.textColumns = Array.from(new Set((spec.textColumns || []).concat(dateHeaders)));
});


/* ============================ Guidance constants ============================ */

/** The 3 situations guidance is written for. They are the status bands the
    engine already computes, renamed for the manual's voice. No new maths. */
var GUIDANCE_SITUATIONS = ['sustain', 'recover', 'urgent'];

/**
 * The heading labels a person may write in the Doc for each situation.
 *
 * Fixed in code and never extended at runtime. Forgiving enough that changing
 * "Off track, urgent" to "Off track" survives a reformat, strict enough that a
 * heading somebody actually broke is still caught. The application contract means the app
 * never guesses at meaning, so this table is the whole of the tolerance.
 */
var SITUATION_HEADINGS = {
  sustain: ['on track, sustain', 'on track', 'sustain'],
  recover: ['at risk, recover', 'at risk', 'recover'],
  urgent: ['off track, urgent', 'off track', 'urgent']
};

/** The label written into the Doc for each situation, and shown on screen. */
var SITUATION_LABELS = { sustain: 'On track, sustain', recover: 'At risk, recover', urgent: 'Off track, urgent' };

/** Most specific first. The resolution walk and the Doc's scope suffix share
    this list, so a level can never exist in one and not the other. */
var GUIDANCE_SCOPE_LEVELS = ['department', 'site', 'region', 'organization'];

/** Everything the checker can find wrong, and what each one means in words. */
var GUIDANCE_PROBLEM_KINDS = {
  'unknown-metric': 'names a metric the library does not have',
  'unknown-scope': 'names a place the organization does not have',
  'unknown-situation': 'does not name one of the 3 situations',
  'not-a-heading': 'is written as ordinary text instead of a heading',
  'orphan-steps': 'has steps that sit above any situation heading',
  'duplicate': 'repeats a section that is already written above',
  'missing-situation': 'was readable before and cannot be read now'
};

/* ============================ navigation ============================ */

function navItemAllowed_(item, permissions, siteCount) {
  var allowed = Array.isArray(permissions) ? permissions : [];
  if (item.permission && allowed.indexOf(item.permission) === -1) { return false; }
  if (item.anyPermission && !item.anyPermission.some(function (key) { return allowed.indexOf(key) !== -1; })) { return false; }
  if (item.requiresMultiSite && Number(siteCount || 0) < 2) { return false; }
  return true;
}
function navForRole_(role) { return NAV.filter(function (item) { return item.roles.indexOf(role) !== -1; }); }
function navForUser_(user) {
  var permissions = user && Array.isArray(user.permissions) ? user.permissions : [];
  var siteCount = user && Array.isArray(user.scopeSites) ? user.scopeSites.length : 0;
  return NAV.filter(function (item) {
    return item.roles.indexOf(user.role) !== -1 && navItemAllowed_(item, permissions, siteCount);
  });
}
function hasAnyPerformancePermission_(permissions) {
  var allowed = Array.isArray(permissions) ? permissions : [];
  return PERFORMANCE_PERMISSIONS.some(function (key) { return allowed.indexOf(key) !== -1; });
}
function roleHasPermission_(roleKey, permissionKey, mappings) {
  return (mappings || []).some(function (row) { return String(row.roleKey) === String(roleKey) && String(row.permissionKey) === String(permissionKey) && row.active !== false && String(row.active).toUpperCase() !== 'FALSE'; });
}
function roleCanWrite_(role) { return role === 'admin' || role === 'regional' || role === 'site'; }
function transitionAllowed_(fromStatus, toStatus) { return (INTAKE_TRANSITIONS[String(fromStatus)] || []).indexOf(String(toStatus)) !== -1; }
function nextVersion_(value) { var current = Number(value); return isFinite(current) && current >= 1 ? Math.floor(current) + 1 : 2; }
function versionMatches_(stored, expected) { return Number(stored || 1) === Number(expected || 0); }

/* ============================ scope ============================ */

function scopeAssignmentActive_(row, onDate) {
  row = row || {}; var status = String(row.status || '').toLowerCase();
  if (status !== 'active') { return false; }
  var today = String(onDate || new Date().toISOString().slice(0, 10)).slice(0, 10), starts = String(row.startsOn || '').slice(0, 10), ends = String(row.endsOn || '').slice(0, 10);
  return !(starts && starts > today) && !(ends && ends < today);
}
function activeScopeIds_(rows, onDate) {
  var seen = {};
  return (rows || []).filter(function (row) { return scopeAssignmentActive_(row, onDate); }).map(function (row) { return String(row.scopeId || ''); }).filter(function (id) { if (!id || seen[id]) { return false; } seen[id] = true; return true; });
}
function unitWithinScope_(unitId, ancestorId, unitById) {
  var current = String(unitId || ''), target = String(ancestorId || ''), visited = {};
  while (current && !visited[current]) { if (current === target) { return true; } visited[current] = true; current = unitById && unitById[current] ? String(unitById[current].parentUnitId || '') : ''; }
  return false;
}
function scopeCeilingAllows_(ceiling, unitType) {
  var rank = { organization: 5, program: 4, division: 3, region: 2, site: 1, self: 0 };
  return Object.prototype.hasOwnProperty.call(rank, String(ceiling)) && Object.prototype.hasOwnProperty.call(rank, String(unitType)) && rank[String(unitType)] <= rank[String(ceiling)];
}
function rowInScope_(role, user, row, regionOf) {
  if (role === 'admin') { return true; }
  if (role === 'viewer') { return false; }
  if (user && Array.isArray(user.scopeSites)) { return user.scopeSites.indexOf(String(row.site || '')) !== -1; }
  if (role === 'regional') { return regionOf(row.site) === user.region; }
  return role === 'site' && String(row.site || '') === String(user.site || '');
}
function scopeRows_(role, user, rows, regionOf) { return (rows || []).filter(function (row) { return rowInScope_(role, user, row, regionOf); }); }

/* ============================ small helpers ============================ */

function safeKey_(value) { return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function cleanRow_(row) { var out = {}; Object.keys(row || {}).forEach(function (key) { if (key !== '_row') { out[key] = row[key]; } }); return out; }
function truthy_(value) { return value === true || String(value).toUpperCase() === 'TRUE'; }
function validateText_(value, label, max, required) {
  var text = String(value == null ? '' : value).trim();
  if (required && !text) { throw new Error('E_VALIDATION: ' + label + ' is required.'); }
  if (text.length > max) { throw new Error('E_VALIDATION: ' + label + ' is too long.'); }
  return text;
}
/** Sheets hands numbers back as numbers and blanks as empty strings. This is the
    single place that decides whether a stored cell holds a real number. */
function numberOrNull_(value) {
  if (value === null || value === undefined || value === '') { return null; }
  var n = Number(value);
  return isFinite(n) ? n : null;
}
function requireNumber_(value, label) {
  var n = numberOrNull_(value);
  if (n === null) { throw new Error('E_VALIDATION: ' + label + ' must be a number.'); }
  return n;
}

/* ============================ period maths ============================ */

function isValidPeriod_(period) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || '')); }

/**
 * Google Sheets parses anything that looks like a date, and "2026-07" looks
 * exactly like one. A period written as text can come back from the sheet as a
 * Date object instead of the string that was sent, which would turn every
 * period comparison in the app into a silent mismatch.
 *
 * This is the single place that turns whatever the sheet hands back into the
 * YYYY-MM the rest of the code expects. The local emulator stores strings
 * verbatim and cannot reproduce the coercion, so this is guarded here rather
 * than discovered on a live deployment.
 */
function normalizePeriod_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) { return periodOfDate_(value); }
  var text = String(value == null ? '' : value).trim();
  if (isValidPeriod_(text)) { return text; }
  var iso = text.match(/^(\d{4})-(\d{1,2})/);
  if (iso) { return iso[1] + '-' + String(Number(iso[2])).padStart(2, '0'); }
  var parsed = new Date(text);
  if (text && !isNaN(parsed.getTime())) { return periodOfDate_(parsed); }
  return text;
}
function periodIndex_(period) { var parts = String(period || '').split('-'); return Number(parts[0]) * 12 + Number(parts[1]); }
function periodFromIndex_(index) {
  var year = Math.floor((index - 1) / 12), month = index - year * 12;
  return String(year) + '-' + String(month).padStart(2, '0');
}
function periodOfDate_(date) { return String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0'); }
/** The month people are reporting on. July's numbers are entered in early
    August, so the open period is always the previous calendar month. */
function openPeriodOn_(date) { return periodFromIndex_(periodIndex_(periodOfDate_(date)) - 1); }
function periodsEndingAt_(period, count) {
  var end = periodIndex_(period), out = [];
  for (var i = count - 1; i >= 0; i--) { out.push(periodFromIndex_(end - i)); }
  return out;
}
function entryClosesOn_(period) {
  var next = periodFromIndex_(periodIndex_(period) + 1);
  return next + '-' + String(PERIOD_CLOSE_DAY).padStart(2, '0');
}
function periodIsLate_(period, date) {
  return String(date.toISOString().slice(0, 10)) > entryClosesOn_(period);
}
var MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel_(period) {
  var parts = String(period || '').split('-');
  return (MONTH_NAMES_[Number(parts[1]) - 1] || '') + ' ' + parts[0];
}
function periodMonthName_(period) { return MONTH_NAMES_[Number(String(period || '').split('-')[1]) - 1] || ''; }
function periodShort_(period) { return String(periodMonthName_(period)).slice(0, 3); }
/** Dates are read by people, so they are written the way people write them. */
function niceDate_(iso) {
  var parts = String(iso || '').slice(0, 10).split('-');
  if (parts.length !== 3 || !MONTH_NAMES_[Number(parts[1]) - 1]) { return String(iso || ''); }
  return String(Number(parts[2])) + ' ' + MONTH_NAMES_[Number(parts[1]) - 1] + ' ' + parts[0];
}

/* ============================ metric and goal rules ============================ */

function metricIsPercentage_(metric) { return metric && String(metric.metricType) === 'percentage'; }
function metricPrefersHigher_(metric) { return !metric || String(metric.direction) !== 'lower'; }
function goalThresholds_(goal) {
  var on = numberOrNull_(goal && goal.onTrackPace), at = numberOrNull_(goal && goal.atRiskPace);
  return {
    onTrackPace: on === null ? DEFAULT_THRESHOLDS.onTrackPace : on,
    atRiskPace: at === null ? DEFAULT_THRESHOLDS.atRiskPace : at
  };
}

/** Format a stored number the way the product says it. Kept pure so the
    reminder emails and the screens cannot drift apart. */
function formatMetricValue_(metric, value) {
  var n = numberOrNull_(value);
  if (n === null) { return ''; }
  if (metricIsPercentage_(metric)) { return (Math.round(n * 10) / 10).toFixed(1) + '%'; }
  if (metric && String(metric.metricType) === 'average') { return (Math.round(n * 10) / 10).toFixed(1); }
  return String(Math.round(n));
}

function goalCommitmentText_(goal, metric) {
  if (String(goal.goalKind) === 'period') { return 'Target ' + formatMetricValue_(metric, goal.target) + ' each month'; }
  if (String(goal.goalKind) === 'hold') {
    return (metricPrefersHigher_(metric) ? 'Hold at or above ' : 'Hold at or below ') + formatMetricValue_(metric, goal.target);
  }
  return formatMetricValue_(metric, goal.baseline) + ' to ' + formatMetricValue_(metric, goal.target) + ' by ' + niceDate_(goal.targetDate);
}

/**
 * Reject a goal that cannot be judged before it is ever stored.
 * Returns the normalized numeric fields; throws E_VALIDATION otherwise.
 */
function normalizeGoalNumbers_(input, metric) {
  var kind = String(input.goalKind || '');
  if (GOAL_KINDS.indexOf(kind) === -1) { throw new Error('E_VALIDATION: choose which kind of goal this is.'); }
  var out = { goalKind: kind, target: null, baseline: null, startDate: '', targetDate: '' };
  out.target = requireNumber_(input.target, 'the goal number');
  if (metricIsPercentage_(metric) && (out.target < 0 || out.target > 100)) {
    throw new Error('E_VALIDATION: a percentage goal must be between 0 and 100.');
  }
  if (kind === 'journey') {
    out.baseline = requireNumber_(input.baseline, 'the baseline');
    if (out.baseline === out.target) {
      throw new Error('E_VALIDATION: a journey needs a baseline that differs from the target. If the number should simply stay where it is, choose "hold a level" instead.');
    }
    out.startDate = String(input.startDate || '').slice(0, 10);
    out.targetDate = String(input.targetDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(out.targetDate)) {
      throw new Error('E_VALIDATION: a journey needs a start date and a target date.');
    }
    if (out.targetDate <= out.startDate) { throw new Error('E_VALIDATION: the target date must be after the start date.'); }
  }
  var thresholds = {
    onTrackPace: input.onTrackPace === undefined || input.onTrackPace === '' ? DEFAULT_THRESHOLDS.onTrackPace : requireNumber_(input.onTrackPace, 'the on-track line'),
    atRiskPace: input.atRiskPace === undefined || input.atRiskPace === '' ? DEFAULT_THRESHOLDS.atRiskPace : requireNumber_(input.atRiskPace, 'the at-risk line')
  };
  if (thresholds.onTrackPace <= 0 || thresholds.atRiskPace <= 0) { throw new Error('E_VALIDATION: the thresholds must be above zero.'); }
  if (thresholds.atRiskPace > thresholds.onTrackPace) {
    throw new Error('E_VALIDATION: the at-risk line cannot be higher than the on-track line.');
  }
  out.onTrackPace = thresholds.onTrackPace;
  out.atRiskPace = thresholds.atRiskPace;
  return out;
}

/**
 * Turn what somebody typed into what gets stored.
 * A percentage metric stores both parts and never a bare percentage, so that
 * region rollups can add people instead of averaging percentages.
 */
function normalizeActualEntry_(metric, entry) {
  entry = entry || {};
  if (truthy_(entry.noData)) {
    return { numerator: null, denominator: null, value: null, noData: true };
  }
  if (metricIsPercentage_(metric)) {
    var numerator = numberOrNull_(entry.numerator), denominator = numberOrNull_(entry.denominator);
    if (numerator === null || denominator === null) {
      throw new Error('E_VALIDATION: both numbers are needed. Enter how many, out of how many.');
    }
    if (numerator < 0 || denominator < 0) { throw new Error('E_VALIDATION: numbers cannot be negative.'); }
    if (denominator === 0) {
      throw new Error('E_VALIDATION: the second number cannot be zero. If nobody was eligible this month, tick the no-data box instead.');
    }
    if (numerator > denominator) {
      throw new Error('E_VALIDATION: the first number cannot be larger than the second. You entered ' + numerator + ' out of ' + denominator + '.');
    }
    return { numerator: numerator, denominator: denominator, value: (numerator / denominator) * 100, noData: false };
  }
  var value = numberOrNull_(entry.value);
  if (value === null) { throw new Error('E_VALIDATION: enter a number.'); }
  if (value < 0) { throw new Error('E_VALIDATION: this number cannot be negative.'); }
  return { numerator: null, denominator: null, value: value, noData: false };
}

/* ============================ the status engine ============================ */

/**
 * Superseded rows are never rewritten. A row is superseded when some other row
 * points at it, so the original stays byte for byte as it was entered.
 */
function liveActualRows_(rows) {
  var supersededIds = {};
  (rows || []).forEach(function (row) {
    var target = String(row.supersedesActualId || '');
    if (target) { supersededIds[target] = true; }
  });
  return (rows || [])
    .filter(function (row) { return !supersededIds[String(row.actualId)]; })
    .sort(function (a, b) { return periodIndex_(a.period) - periodIndex_(b.period); });
}

/**
 * The run-chart trend, reported separately from status.
 * Counts consecutive moves in one direction from the newest end of the series.
 * A flat month breaks the run, and the run length is always returned so the
 * screen can state it rather than saying "improving" and leaving it there.
 */
function trendOfSeries_(series, metric) {
  if (!series || series.length < 3) { return { direction: 'Unknown', months: 0, change: 0 }; }
  var good = metricPrefersHigher_(metric) ? 1 : -1;
  var run = 0, sign = 0, firstIndex = series.length - 1;
  for (var i = series.length - 1; i > 0; i--) {
    var delta = Number(series[i].value) - Number(series[i - 1].value);
    if (Math.abs(delta) < 1e-9) { break; }
    var step = delta > 0 ? 1 : -1;
    if (sign === 0) { sign = step; run = 1; firstIndex = i - 1; }
    else if (step === sign) { run++; firstIndex = i - 1; }
    else { break; }
  }
  /* How far the number actually moved across the run. The direction alone can
     dress up a 0.2 wobble as a trend, so the screen states the movement too. */
  var change = run ? Number(series[series.length - 1].value) - Number(series[firstIndex].value) : 0;
  change = Math.round(change * 100) / 100;
  if (run < TREND_MIN_RUN) { return { direction: 'Flat', months: run, change: change }; }
  return { direction: sign === good ? 'Improving' : 'Declining', months: run, change: change };
}

/** How much of a journey's time has gone, from 0 to 1. Shared by the engine and
    by the live preview the entry worksheet shows while somebody types, so the
    two can never drift apart on the arithmetic. */
function journeyElapsed_(goal, asOfDate) {
  var start = new Date(String(goal.startDate).slice(0, 10) + 'T00:00:00Z');
  var end = new Date(String(goal.targetDate).slice(0, 10) + 'T00:00:00Z');
  var now = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  var window = end - start;
  if (!isFinite(window) || window <= 0) { return 1; }
  return Math.min(1, Math.max(0, (now - start) / window));
}

function capRatio_(value) {
  if (!isFinite(value)) { return 9.99; }
  return Math.max(-9.99, Math.min(9.99, Math.round(value * 1000) / 1000));
}

/**
 * The whole judgement, in one pure function.
 *
 * this recomputes on every read. There is no stored snapshot, so
 * correcting an old number moves that month's status too, which is the honest
 * behaviour when the number it was based on turned out to be wrong.
 *
 * The open period is judged on its own number. A goal with history but nothing
 * entered this month is not on track, it is unreported. Carrying last month's
 * green forward would let a month nobody looked at read as fine.
 */
function computeGoalStatus_(goal, rows, asOfPeriod, metric, asOfDate) {
  var thresholds = goalThresholds_(goal);
  var live = liveActualRows_(rows);
  var noDataThisPeriod = live.some(function (row) { return String(row.period) === String(asOfPeriod) && truthy_(row.noData); });
  var series = live.filter(function (row) { return !truthy_(row.noData) && numberOrNull_(row.value) !== null; });
  var base = { thresholds: thresholds, noData: noDataThisPeriod, series: series, ratio: null, latest: null, stale: 0 };

  if (!series.length) {
    return Object.assign(base, { status: 'Not yet measured', trend: 'Unknown', trendMonths: 0, trendChange: 0 });
  }

  var latest = series[series.length - 1];
  var age = periodIndex_(asOfPeriod) - periodIndex_(latest.period);
  var trend = trendOfSeries_(series, metric);
  base.latest = latest;
  base.stale = Math.max(0, age);
  base.trend = trend.direction;
  base.trendMonths = trend.months;
  base.trendChange = trend.change;

  /* Somebody confirmed there is genuinely nothing to report. That is a real
     answer, not a missing one, and it is not zero either. */
  if (noDataThisPeriod) { return Object.assign(base, { status: 'Not yet measured' }); }
  if (age > 2) { return Object.assign(base, { status: 'Insufficient data' }); }
  if (age > 0) { return Object.assign(base, { status: 'Not reported' }); }

  var ratio;
  if (String(goal.goalKind) === 'journey') {
    var span = Number(goal.target) - Number(goal.baseline);
    var progress = span === 0 ? 1 : (Number(latest.value) - Number(goal.baseline)) / span;
    var elapsed = journeyElapsed_(goal, asOfDate);
    ratio = elapsed === 0 ? (progress > 0 ? 1 : 0) : progress / elapsed;
    if (progress >= 1) { ratio = Math.max(ratio, 1); }
    base.progress = capRatio_(progress);
    base.elapsed = capRatio_(elapsed);
  } else {
    /* period and hold share the same arithmetic: this month's number against
       the line, read in the direction the metric improves */
    var value = Number(latest.value), target = Number(goal.target);
    if (metricPrefersHigher_(metric)) { ratio = target === 0 ? 1 : value / target; }
    else { ratio = value === 0 ? (target === 0 ? 1 : 9.99) : target / value; }
  }
  ratio = capRatio_(ratio);
  var status = ratio >= thresholds.onTrackPace ? 'On track' : (ratio >= thresholds.atRiskPace ? 'At risk' : 'Off track');
  return Object.assign(base, { status: status, ratio: ratio });
}

/* ============================ rollup arithmetic ============================ */

/**
 * How several sites add up.
 *
 * A percentage adds its numerators and its denominators and divides once.
 * Averaging site percentages is the classic wrong answer: it treats a site with
 * 12 people as equal to one with 404.
 *
 * A count adds.
 *
 * An average cannot be rolled up at all from what is stored, because an average
 * needs to know how many cases it covers and that number is not collected. The
 * Hub says so rather than inventing a figure.
 */
function rollupParts_(metric, parts) {
  var usable = (parts || []).filter(function (part) { return !truthy_(part.noData) && numberOrNull_(part.value) !== null; });
  var skipped = (parts || []).filter(function (part) { return truthy_(part.noData) || numberOrNull_(part.value) === null; });
  var result = { metric: metric, parts: usable, skipped: skipped, total: null, kind: '', naiveAverage: null, formula: '', caveat: '' };
  if (!usable.length) { result.kind = 'nothing-reported'; return result; }

  if (metricIsPercentage_(metric)) {
    var numerator = 0, denominator = 0, naive = 0;
    usable.forEach(function (part) {
      numerator += Number(part.numerator);
      denominator += Number(part.denominator);
      naive += Number(part.value);
    });
    result.kind = 'weighted';
    result.numerator = numerator;
    result.denominator = denominator;
    result.total = denominator === 0 ? null : (numerator / denominator) * 100;
    result.naiveAverage = naive / usable.length;
    result.formula = 'Add every first number, add every second number, then divide once. ('
      + usable.map(function (part) { return part.numerator; }).join(' + ') + ') divided by ('
      + usable.map(function (part) { return part.denominator; }).join(' + ') + ') = ' + formatMetricValue_(metric, result.total);
    return result;
  }

  if (String(metric.metricType) === 'average') {
    result.kind = 'not-aggregatable';
    result.caveat = 'An average cannot be added up. Rolling these into one regional figure would need to know how many cases each site average covers, and the Hub does not collect that. Every site is shown on its own instead of a number that would look precise and be wrong.';
    return result;
  }

  var sum = 0;
  usable.forEach(function (part) { sum += Number(part.value); });
  result.kind = 'sum';
  result.total = sum;
  result.formula = 'Add each site number. ' + usable.map(function (part) { return formatMetricValue_(metric, part.value); }).join(' + ') + ' = ' + formatMetricValue_(metric, sum);
  return result;
}

/* ============================ corrections ============================ */

/**
 * The person who entered a number may correct it freely for 48
 * hours. After that the correction needs someone with manage rights. Either
 * way the original row survives and both values stay visible.
 */
function correctionNeedsApproval_(original, actorEmail, nowDate) {
  var enteredBy = String(original && original.enteredBy || '').toLowerCase();
  if (enteredBy !== String(actorEmail || '').toLowerCase()) { return true; }
  var enteredAt = new Date(String(original && original.enteredAt || ''));
  if (isNaN(enteredAt.getTime())) { return true; }
  var hours = (nowDate.getTime() - enteredAt.getTime()) / 3600000;
  return hours > CORRECTION_FREE_HOURS;
}

/* ============================ guidance: the format contract ============================ */

/**
 * Pure functions validate and interpret the managed document structure.
 *
 * A person maintains the manual in Google Docs, which means the app depends on
 * formatting a human controls, and humans reformat. Everything here is written
 * to survive a well-meaning edit where it safely can, and to say plainly what
 * broke where it cannot. Nothing here ever invents or rewords a step.
 */

function normalizeGuidanceText_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}
function guidanceKey_(value) { return normalizeGuidanceText_(value).toLowerCase(); }

/** The status band, renamed for the manual. Anything the engine cannot judge
    gets no guidance at all rather than a guess. */
function situationOfStatus_(status) {
  if (String(status) === 'On track') { return 'sustain'; }
  if (String(status) === 'At risk') { return 'recover'; }
  if (String(status) === 'Off track') { return 'urgent'; }
  return null;
}

/** Deterministic, so re-parsing the same Doc updates rows instead of adding
    a second copy of every block. */
function guidanceBlockId_(scopeUnitId, metricId, situation) {
  return 'guid_' + safeKey_(scopeUnitId) + '_' + safeKey_(metricId) + '_' + safeKey_(situation);
}

/** A situation heading, matched through the fixed table and nothing else. */
function matchSituationHeading_(text) {
  var wanted = guidanceKey_(text).replace(/[.:;]+$/, '');
  if (!wanted) { return null; }
  var found = null;
  GUIDANCE_SITUATIONS.forEach(function (situation) {
    if (found) { return; }
    if (SITUATION_HEADINGS[situation].indexOf(wanted) !== -1) { found = situation; }
  });
  return found;
}

/**
 * `Metric: <name>` with an optional ` (Site: <name>)` style suffix.
 *
 * Returns `{ ok: true, metricId, scopeUnitId, scopeType }`, or `{ ok: false }`
 * for a line that is not a metric heading at all, or
 * `{ ok: false, looksLikeMetricHeading: true, kind }` for one that is trying to
 * be and cannot be resolved. The middle case is the one that matters: it is how
 * a renamed metric flags itself instead of silently disappearing.
 */
function parseMetricHeading_(text, index) {
  var match = String(text == null ? '' : text).trim()
    .match(/^Metric\s*:\s*(.+?)\s*(?:\(\s*(Organization|Region|Site|Department)\s*:\s*(.+?)\s*\)\s*)?$/i);
  if (!match) { return { ok: false, looksLikeMetricHeading: false }; }
  var metricName = normalizeGuidanceText_(match[1]);
  var metric = index.metricsByName[guidanceKey_(metricName)];
  if (!metric) {
    return { ok: false, looksLikeMetricHeading: true, kind: 'unknown-metric', detail: metricName };
  }
  if (!match[2]) {
    return { ok: true, metricId: String(metric.metricId), scopeUnitId: index.rootUnitId, scopeType: 'organization' };
  }
  var scopeType = String(match[2]).toLowerCase();
  var unit = index.unitsByTypeAndName[scopeType + '|' + guidanceKey_(match[3])];
  if (!unit) {
    return { ok: false, looksLikeMetricHeading: true, kind: 'unknown-scope', detail: match[2] + ': ' + normalizeGuidanceText_(match[3]) };
  }
  return { ok: true, metricId: String(metric.metricId), scopeUnitId: String(unit.unitId), scopeType: scopeType };
}

/**
 * Build the lookup a parse needs. Kept separate so the parser stays pure and
 * the caller can hand it fixtures in a plain Node test.
 */
function guidanceIndex_(metrics, units, rootUnitId) {
  var index = { metricsByName: {}, unitsByTypeAndName: {}, rootUnitId: String(rootUnitId || 'ORG-ROOT') };
  (metrics || []).forEach(function (metric) {
    var key = guidanceKey_(metric.name);
    /* First definition wins. Two metrics with the same name are already refused
       by metricSave_, so this only guards a hand-edited library. */
    if (key && !index.metricsByName[key]) { index.metricsByName[key] = metric; }
  });
  (units || []).forEach(function (unit) {
    var key = String(unit.unitType || '').toLowerCase() + '|' + guidanceKey_(unit.name);
    if (!index.unitsByTypeAndName[key]) { index.unitsByTypeAndName[key] = unit; }
  });
  return index;
}

/**
 * Doc lines in, blocks and problems out. Pure, so every failure mode is a
 * fixture in plain Node rather than something discovered on a live Doc.
 *
 * Lines arrive as `{ kind: 'heading2' | 'heading3' | 'body', text }`. The
 * reader in Playbook.gs is the only part that knows about Google Docs.
 *
 * The contract that matters: one bad section never costs a good one. Every
 * problem is recorded and parsing carries on with the next heading.
 */
function parseGuidanceLines_(lines, index, docId) {
  var blocks = [], problems = [], byId = {};
  var section = null, situation = null, steps = null, sourceHeading = '', flaggedOrphan = false;

  /* Which section a problem belongs to, where that is knowable. It is what
     lets the checker say "this section broke" once instead of once for the
     heading and again for each block that heading used to serve. */
  function sectionKey() { return section ? section.metricId + '|' + section.scopeUnitId : ''; }
  function flag(kind, heading, detail) {
    var key = sectionKey();
    problems.push({ kind: kind, heading: heading, detail: detail || '', sectionKey: key });
    /* Once a section has told somebody something is wrong, it stops telling
       them the consequences. A renamed situation heading leaves its steps
       stranded, and reporting the stranding as well turns one mistake into two
       items on a list that a person then has to work out are the same thing. */
    if (key) { flaggedOrphan = true; }
  }

  function closeBlock() {
    /* A heading with nothing under it produces no block at all. An empty list
       on screen would read as "the manual says do nothing", which is a claim
       the manual did not make. The missing-situation diff reports it instead. */
    if (!section || !situation || !steps || !steps.length) { situation = null; steps = null; return; }
    var blockId = guidanceBlockId_(section.scopeUnitId, section.metricId, situation);
    if (byId[blockId]) {
      flag('duplicate', sourceHeading, SITUATION_LABELS[situation]);
      situation = null; steps = null; return;
    }
    var block = {
      blockId: blockId, scopeUnitId: section.scopeUnitId, scopeType: section.scopeType,
      metricId: section.metricId, situation: situation, steps: steps.slice(),
      sourceDocId: String(docId || ''), sourceHeading: sourceHeading,
      sectionKey: section.metricId + '|' + section.scopeUnitId
    };
    byId[blockId] = block;
    blocks.push(block);
    situation = null; steps = null;
  }
  function closeSection() { closeBlock(); section = null; flaggedOrphan = false; }

  (lines || []).forEach(function (line) {
    var kind = String(line && line.kind || 'body');
    var text = normalizeGuidanceText_(line && line.text);

    if (kind === 'heading2') {
      closeSection();
      if (!text) { return; }
      var parsed = parseMetricHeading_(text, index);
      if (parsed.ok) { section = { metricId: parsed.metricId, scopeUnitId: parsed.scopeUnitId, scopeType: parsed.scopeType, heading: text }; return; }
      if (parsed.looksLikeMetricHeading) { flag(parsed.kind, text, parsed.detail); }
      return;
    }

    if (kind === 'heading3') {
      closeBlock();
      var matched = matchSituationHeading_(text);
      if (!section) {
        /* A situation heading with no metric heading above it. The metric
           heading was probably the thing that broke, and that is already
           recorded, so this is not double-reported. */
        return;
      }
      /* It is a heading, it is just not one of the 3 the app knows. Saying
         "written as ordinary text" here would send somebody hunting for a
         formatting problem that is not there. */
      if (!matched) { flag('unknown-situation', text, section.heading); return; }
      situation = matched; steps = []; sourceHeading = section.heading + ' / ' + text;
      return;
    }

    if (!text) { return; }

    /* The likeliest human error by a distance: a heading that got pasted, or
       had its style stripped, and is now ordinary text. It is called out by
       name because "your section vanished" is not a useful thing to be told.

       The block above it is closed here rather than left open, because the
       steps that follow belong to the situation whose heading just broke. Left
       open, they would be served under the previous heading, and a site at risk
       would be shown the urgent steps under the words "at risk". Wrong steps
       under a confident label is worse than a section that says it is broken. */
    if (/^Metric\s*:/i.test(text) || matchSituationHeading_(text)) {
      closeBlock();
      flag('not-a-heading', text, section ? section.heading : '');
      flaggedOrphan = true;
      return;
    }
    if (section && situation) { steps.push(text); return; }
    if (section && !flaggedOrphan) {
      flag('orphan-steps', section.heading, text.slice(0, 80));
      flaggedOrphan = true;
    }
  });
  closeSection();
  return { blocks: blocks, problems: problems };
}

/**
 * Most-specific-wins, with layering.
 *
 * `chain` is the goal's scope path, most specific first: its department if one
 * is set, then its site, then each parent up to the organization. Every level
 * that has a block for this metric and situation contributes one, and the list
 * comes back least specific first, so a reader sees the organization's position
 * and then what their own place adds to it.
 *
 * `winner` is the most specific block. It leads the pre-fill when somebody
 * starts an action and is what gets recorded as where that action came from.
 */
function resolveGuidanceBlocks_(rows, chain, metricId, situation) {
  if (!situation) { return { situation: null, blocks: [], winner: null, missing: true }; }
  var wantedMetric = String(metricId), byScope = {};
  (rows || []).forEach(function (row) {
    if (String(row.metricId) !== wantedMetric || String(row.situation) !== String(situation)) { return; }
    var scopeId = String(row.scopeUnitId);
    if (!byScope[scopeId]) { byScope[scopeId] = row; }
  });
  var picked = [];
  (chain || []).forEach(function (step) {
    var row = byScope[String(step.unitId)];
    if (row) { picked.push({ row: row, unitType: String(step.unitType), unitName: String(step.name || '') }); }
  });
  var winner = picked.length ? picked[0] : null;
  return {
    situation: situation,
    winner: winner,
    blocks: picked.slice().reverse(),
    missing: picked.length === 0
  };
}

/**
 * Which blocks the app used to be able to read and now cannot.
 *
 * Deleting a section and breaking a section look identical from outside the
 * Doc, so a partial parse never treats an absence as a deletion. Only a parse
 * with no problems at all is trusted to remove anything.
 */
function missingGuidanceBlocks_(servedRows, parsedBlocks) {
  var parsedIds = {};
  (parsedBlocks || []).forEach(function (block) { parsedIds[String(block.blockId)] = true; });
  return (servedRows || []).filter(function (row) { return !parsedIds[String(row.blockId)]; });
}

/**
 * One human error should be reported once.
 *
 * A block can vanish for two quite different reasons. Its own section broke,
 * in which case some problem already names the heading that broke and saying
 * "and this block is gone" as well would turn one mistake into four. Or the
 * section read perfectly and one situation quietly disappeared, which nothing
 * else would report and which is exactly the prototype's broken case.
 *
 * So a missing block is only reported when its section parsed cleanly this run
 * and produced no problem of its own.
 */
function guidanceMissingProblems_(servedRows, parsed) {
  var parsedSections = {}, reportedSections = {};
  ((parsed && parsed.blocks) || []).forEach(function (block) { parsedSections[String(block.sectionKey)] = true; });
  ((parsed && parsed.problems) || []).forEach(function (problem) {
    if (problem.sectionKey) { reportedSections[String(problem.sectionKey)] = true; }
  });
  return missingGuidanceBlocks_(servedRows, (parsed && parsed.blocks) || []).filter(function (row) {
    var key = String(row.metricId) + '|' + String(row.scopeUnitId);
    return parsedSections[key] && !reportedSections[key];
  }).map(function (row) {
    return {
      kind: 'missing-situation',
      heading: String(row.sourceHeading || row.blockId),
      detail: SITUATION_LABELS[String(row.situation)] || String(row.situation),
      sectionKey: String(row.metricId) + '|' + String(row.scopeUnitId)
    };
  });
}

/** A stable fingerprint of the current problem set, so the same break alerts
    once and a new break alerts again. */
function guidanceAlertSignature_(problems) {
  var parts = (problems || []).map(function (problem) {
    return String(problem.kind) + ':' + guidanceKey_(problem.heading);
  });
  parts.sort();
  if (!parts.length) { return ''; }
  var joined = parts.join('|'), hash = 0;
  for (var i = 0; i < joined.length; i++) { hash = ((hash << 5) - hash + joined.charCodeAt(i)) | 0; }
  return parts.length + '-' + Math.abs(hash).toString(36);
}

if (typeof module !== 'undefined') {
  module.exports = {
    PRODUCT_NAME: PRODUCT_NAME,
    ROLES: ROLES, DEFAULT_ROLES: DEFAULT_ROLES, DEFAULT_PERMISSIONS: DEFAULT_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS: DEFAULT_ROLE_PERMISSIONS,
    PERFORMANCE_PERMISSIONS: PERFORMANCE_PERMISSIONS,
    INTAKE_STATUSES: INTAKE_STATUSES, INTAKE_PRIORITIES: INTAKE_PRIORITIES, INTAKE_TYPES: INTAKE_TYPES, INTAKE_TRANSITIONS: INTAKE_TRANSITIONS,
    METRIC_TYPES: METRIC_TYPES, METRIC_DIRECTIONS: METRIC_DIRECTIONS, GOAL_KINDS: GOAL_KINDS, GOAL_STATUSES: GOAL_STATUSES,
    TREND_DIRECTIONS: TREND_DIRECTIONS, TREND_MIN_RUN: TREND_MIN_RUN, DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    TRAJECTORY_PERIODS: TRAJECTORY_PERIODS, PERIOD_CLOSE_DAY: PERIOD_CLOSE_DAY, CORRECTION_FREE_HOURS: CORRECTION_FREE_HOURS,
    CORRECTION_REASONS: CORRECTION_REASONS, REMINDER_ROUNDS: REMINDER_ROUNDS,
    NAV: NAV, SHEETS: SHEETS, navForRole: navForRole_, navForUser: navForUser_, navItemAllowed: navItemAllowed_,
    hasAnyPerformancePermission: hasAnyPerformancePermission_,
    roleHasPermission: roleHasPermission_, roleCanWrite: roleCanWrite_,
    transitionAllowed: transitionAllowed_, nextVersion: nextVersion_, versionMatches: versionMatches_, scopeAssignmentActive: scopeAssignmentActive_,
    activeScopeIds: activeScopeIds_, unitWithinScope: unitWithinScope_, scopeCeilingAllows: scopeCeilingAllows_, rowInScope: rowInScope_, scopeRows: scopeRows_,
    safeKey: safeKey_, cleanRow: cleanRow_, truthy: truthy_, validateText: validateText_,
    numberOrNull: numberOrNull_, requireNumber: requireNumber_,
    isValidPeriod: isValidPeriod_, normalizePeriod: normalizePeriod_, periodIndex: periodIndex_, periodFromIndex: periodFromIndex_, periodOfDate: periodOfDate_,
    openPeriodOn: openPeriodOn_, periodsEndingAt: periodsEndingAt_, entryClosesOn: entryClosesOn_, periodIsLate: periodIsLate_,
    periodLabel: periodLabel_, periodMonthName: periodMonthName_, periodShort: periodShort_, niceDate: niceDate_,
    metricIsPercentage: metricIsPercentage_, metricPrefersHigher: metricPrefersHigher_, goalThresholds: goalThresholds_,
    formatMetricValue: formatMetricValue_, goalCommitmentText: goalCommitmentText_,
    normalizeGoalNumbers: normalizeGoalNumbers_, normalizeActualEntry: normalizeActualEntry_,
    liveActualRows: liveActualRows_, trendOfSeries: trendOfSeries_, computeGoalStatus: computeGoalStatus_, journeyElapsed: journeyElapsed_,
    rollupParts: rollupParts_, correctionNeedsApproval: correctionNeedsApproval_,
    GUIDANCE_SITUATIONS: GUIDANCE_SITUATIONS, SITUATION_HEADINGS: SITUATION_HEADINGS, SITUATION_LABELS: SITUATION_LABELS,
    GUIDANCE_SCOPE_LEVELS: GUIDANCE_SCOPE_LEVELS, GUIDANCE_PROBLEM_KINDS: GUIDANCE_PROBLEM_KINDS,
    normalizeGuidanceText: normalizeGuidanceText_, situationOfStatus: situationOfStatus_,
    guidanceBlockId: guidanceBlockId_, matchSituationHeading: matchSituationHeading_,
    parseMetricHeading: parseMetricHeading_, guidanceIndex: guidanceIndex_,
    parseGuidanceLines: parseGuidanceLines_, resolveGuidanceBlocks: resolveGuidanceBlocks_,
    missingGuidanceBlocks: missingGuidanceBlocks_, guidanceMissingProblems: guidanceMissingProblems_,
    guidanceAlertSignature: guidanceAlertSignature_
  };
}
