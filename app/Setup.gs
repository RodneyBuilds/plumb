/** Idempotent workspace setup. Existing unrelated tabs are preserved. */
function ensureManagedSheet_(spec) {
  var book = ss_(), sheet = book.getSheetByName(spec.name);
  if (!sheet) { sheet = book.insertSheet(spec.name); }
  var existing = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].filter(String) : [];
  var headers = existing.slice(); spec.headers.forEach(function (header) { if (headers.indexOf(header) === -1) { headers.push(header); } });
  if (!headers.length) { headers = spec.headers.slice(); }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]); sheet.setFrozenRows(1);
  ensureTextColumns_(sheet, spec, headers);
  return sheet;
}

/**
 * Force declared columns to plain text so the sheet stores "2026-07" as the
 * text it is rather than parsing it into a date. Reading is defended separately
 * by normalizePeriod_, so this is the tidy half of the fix and never the only
 * half. Formatting failure prevents installation from becoming ready.
 */
function ensureTextColumns_(sheet, spec, headers) {
  (spec.textColumns || []).forEach(function (name) {
    var index = headers.indexOf(name);
    if (index === -1) { throw new Error('E_CONFIG: declared text column is missing.'); }
    var rows = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, index + 1, rows, 1).setNumberFormat('@');
  });
}

/** Provision an empty workspace only for the configured deployment administrator. */
function setupWorkspace_() {
  var props = PropertiesService.getScriptProperties(), email = currentEmail_();
  var installer = normalizeEmail_(props.getProperty('DEPLOYMENT_ACCOUNT_EMAIL'));
  var effective = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (!installer || !internalEmail_(installer) || email !== installer || effective !== installer) {
    throw new Error('E_FORBIDDEN: only the configured deployment account can provision this workspace.');
  }
  return withLock_(function () {
    var state = props.getProperty('INSTALLATION_STATE'), version = props.getProperty('SCHEMA_VERSION');
    var receiptText = props.getProperty('INSTALLATION_RECEIPT'), receipt = null;
    if (receiptText) { try { receipt = JSON.parse(receiptText); } catch (invalid) { throw new Error('E_CONFIG: invalid installation receipt.'); }
      if (receipt.installer !== installer || !receipt.id || !receipt.userId) { throw new Error('E_CONFIG: installation receipt does not match the configured installer.'); }
    }
    if (state === 'ready') {
      if (version !== '1' || !props.getProperty('INSTALLATION_ID')) { throw new Error('E_CONFIG: explicit schema migration is required.'); }
      requirePermission_(resolveUser_(), 'admin.manage');
      return { ok: true, managedSheets: SHEETS.length, existingExtraSheetsPreserved: true };
    }
    if (!state) {
      if (!receipt && (props.getProperty('INSTALLATION_ID') || SHEETS.some(function (spec) { var sheet = ss_().getSheetByName(spec.name); return sheet && sheet.getLastRow() > 0; }))) {
        throw new Error('E_CONFIG: existing data requires an explicit migration.');
      }
      if (!receipt) { receipt = { id: newId_('installation'), userId: newId_('user'), installer: installer }; props.setProperty('INSTALLATION_RECEIPT', JSON.stringify(receipt)); }
      props.setProperty('INSTALLATION_ID', receipt.id);
      props.setProperty('INSTALLER_EMAIL', receipt.installer);
      props.setProperty('INSTALLER_USER_ID', receipt.userId);
      props.setProperty('INSTALLATION_STATE', 'provisioning');
    } else if (state !== 'provisioning' || props.getProperty('INSTALLER_EMAIL') !== installer || !props.getProperty('INSTALLATION_ID') || !props.getProperty('INSTALLER_USER_ID')) {
      throw new Error('E_CONFIG: ambiguous installation state requires review.');
    }
    SHEETS.forEach(ensureManagedSheet_);
    var userId = props.getProperty('INSTALLER_USER_ID'), users = readTable_('Users');
    if (users.some(function (row) { return row.userId !== userId || normalizeEmail_(row.email) !== installer; }) || users.length > 1) {
      throw new Error('E_CONFIG: unexpected users in an incomplete installation.');
    }
    seedAccessCatalogs_(installer); syncOrganizationUnitsFromSites_(installer);
    var now = nowIso_();
    mergeMissingByKey_('Users', 'userId', { userId: userId, email: installer, name: displayNameFromEmail_(installer), roleKey: 'admin', active: true, updatedAt: now, updatedBy: installer });
    mergeMissingByKey_('UserScopes', 'userScopeId', { userScopeId: 'initial-' + userId, userId: userId, scopeType: 'organization', scopeId: ACCESS_ROOT_UNIT_ID_, primary: true, assignmentType: 'Primary', startsOn: '', endsOn: '', status: 'active', reason: 'Initial workspace administrator', approvedBy: installer, assignedBy: installer, updatedAt: now });
    props.setProperty('SCHEMA_VERSION', '1');
    props.setProperty('INSTALLATION_STATE', 'ready');
    return { ok: true, managedSheets: SHEETS.length, existingExtraSheetsPreserved: true };
  });
}

function seedTestData_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DEMO_MODE') !== 'true' || props.getProperty('WORKSPACE_DOMAIN') !== 'example.org') { throw new Error('E_FORBIDDEN: synthetic seeding is available only in the isolated local example.org demonstration. Provision named test users separately.'); }
  var env = String(props.getProperty('ENVIRONMENT') || '').toUpperCase();
  if (env !== 'TEST' || String(ss_().getName()).toUpperCase().indexOf('TEST') === -1) { throw new Error('E_FORBIDDEN: test data can run only in a TEST workspace.'); }
  if (PropertiesService.getScriptProperties().getProperty('INSTALLATION_STATE') !== 'ready') { throw new Error('E_FORBIDDEN: complete provisioning before adding TEST data.'); } var user = resolveUser_(); requirePermission_(user, 'admin.manage');
  var result = withLock_(function () {
    /* North holds 3 sites on purpose. A region with 1 site cannot demonstrate
       the rollup, and the 3 have deliberately unequal sizes so that averaging
       their percentages gives a visibly wrong answer. */
    var sites = [['Harbor North', 'North'], ['Harbor East', 'North'], ['Harbor West', 'North'], ['Harbor Central', 'Central'], ['Harbor South', 'South']];
    sites.forEach(function (entry) { mergeMissingByKey_('Sites', 'site', { site: entry[0], region: entry[1], active: true }); }); syncOrganizationUnitsFromSites_(user.email);
    var demoUsers = [
      { email: 'regional@example.org', name: 'Regional Tester', role: 'regional', region: 'North', site: '' },
      { email: 'site@example.org', name: 'Site Tester', role: 'site', region: 'North', site: 'Harbor North' },
      { email: 'viewer@example.org', name: 'Viewer Tester', role: 'viewer', region: '', site: '' }
    ];
    demoUsers.forEach(function (item) { if (item.role === 'viewer') { item.scopes = [{ scopeId: ACCESS_ROOT_UNIT_ID_, primary: true, status: 'active' }]; } item.active = true; upsertUserAccess_(user, item); });
    return { ok: true, sites: sites.length, users: demoUsers.length };
  });
  if (!readTable_('Intake').length) { intakeSave_(user, { submissionKey: 'seed-intake-1', title: 'Review a reporting workflow', requestType: 'Data and reporting', site: 'Harbor North', description: 'The site needs help confirming how a monthly report is prepared and reviewed.', priority: 'Normal', impact: 'Monthly review is delayed.', desiredOutcome: 'A documented review process with clear ownership.', requestedSupport: 'Review the workflow and recommend next steps.', contactName: 'Test Contact', contactEmail: user.email }); }
  result.intake = readTable_('Intake').length;
  var performance = seedPerformanceTestData_(user);
  result.metrics = performance.metrics;
  result.goals = performance.goals;
  result.actuals = performance.actuals;
  return result;
}

var SEED_METRICS_ = [
  { metricId: 'metric-clients-served', name: 'Clients served', metricType: 'count', direction: 'higher', unit: 'clients', numeratorLabel: '', denominatorLabel: '', description: 'Distinct clients who received at least one service in the month.' },
  { metricId: 'metric-days-to-first', name: 'Days from intake to first appointment', metricType: 'average', direction: 'lower', unit: 'days', numeratorLabel: '', denominatorLabel: '', description: 'Mean days between intake and the first booked appointment.' },
  { metricId: 'metric-housing-screen', name: 'Clients screened for housing need', metricType: 'percentage', direction: 'higher', unit: '', numeratorLabel: 'Clients screened', denominatorLabel: 'Clients eligible for screening', description: 'Share of eligible clients who completed a housing screen.' },
  { metricId: 'metric-no-show', name: 'No-show rate', metricType: 'percentage', direction: 'lower', unit: '', numeratorLabel: 'Appointments missed', denominatorLabel: 'Appointments booked', description: 'Share of booked appointments the client did not attend.' },
  { metricId: 'metric-staff-certified', name: 'Staff certified, trauma-informed care', metricType: 'percentage', direction: 'higher', unit: '', numeratorLabel: 'Staff certified', denominatorLabel: 'Staff in post', description: 'Share of staff in post holding a current certification.' },
  { metricId: 'metric-follow-up', name: 'Follow-up within 30 days', metricType: 'percentage', direction: 'higher', unit: '', numeratorLabel: 'Clients followed up', denominatorLabel: 'Clients discharged', description: 'Share of discharged clients contacted within 30 days.' }
];

var SEED_GOALS_ = [
  { goalId: 'goal-north-served', metricId: 'metric-clients-served', site: 'Harbor North', goalKind: 'period', target: 40, owner: 'Sample Site Manager', ownerEmail: 'site@example.org' },
  { goalId: 'goal-north-days', metricId: 'metric-days-to-first', site: 'Harbor North', goalKind: 'journey', baseline: 11.4, target: 7, monthsToTarget: 12, owner: 'Sample Site Manager', ownerEmail: 'site@example.org' },
  { goalId: 'goal-north-screen', metricId: 'metric-housing-screen', site: 'Harbor North', goalKind: 'period', target: 80, owner: 'Sample Site Manager', ownerEmail: 'site@example.org' },
  { goalId: 'goal-north-noshow', metricId: 'metric-no-show', site: 'Harbor North', goalKind: 'journey', baseline: 22, target: 12, monthsToTarget: 12, owner: 'Sample Regional Manager', ownerEmail: 'regional@example.org' },
  { goalId: 'goal-north-certified', metricId: 'metric-staff-certified', site: 'Harbor North', goalKind: 'hold', target: 95, onTrackPace: 0.98, atRiskPace: 0.9, owner: 'Sample Regional Manager', ownerEmail: 'regional@example.org' },
  { goalId: 'goal-north-followup', metricId: 'metric-follow-up', site: 'Harbor North', goalKind: 'period', target: 75, owner: 'Sample Site Manager', ownerEmail: 'site@example.org' },
  { goalId: 'goal-east-screen', metricId: 'metric-housing-screen', site: 'Harbor East', goalKind: 'period', target: 80, owner: 'Sample East Manager', ownerEmail: 'regional@example.org' },
  { goalId: 'goal-west-screen', metricId: 'metric-housing-screen', site: 'Harbor West', goalKind: 'period', target: 80, owner: 'Sample West Manager', ownerEmail: 'regional@example.org' }
];

/* offset 0 is the oldest of the 6 periods on the trajectory. A missing entry is
   a month nobody reported, which is exactly what the hatched gap is for. */
var SEED_ACTUALS_ = [
  { goalId: 'goal-north-served', values: [[null, null, 25], [null, null, 28], [null, null, 23], [null, null, 30], [null, null, 33], [null, null, 38]] },
  { goalId: 'goal-north-days', values: [[null, null, 11.2], [null, null, 10.9], [null, null, 10.4], [null, null, 10.1], [null, null, 10.0], [null, null, 9.8]] },
  { goalId: 'goal-north-screen', values: [[41, 52], [38, 53], [34, 50], [36, 51], [31, 50], [34, 51]] },
  { goalId: 'goal-north-noshow', values: [[44, 200], [42, 201], [40, 198], [39, 199], [37, 202], [37, 201]] },
  { goalId: 'goal-north-certified', values: [[24, 25], [24, 25], [24, 25], [23, 25], [23, 25], [23, 25]] },
  { goalId: 'goal-north-followup', values: [[38, 50], [40, 51], null, [39, 52], [38, 50], null] },
  { goalId: 'goal-east-screen', values: [null, null, null, [310, 402], [318, 405], [322, 404]] },
  { goalId: 'goal-west-screen', values: [null, null, null, [7, 12], [8, 12], [8, 12]] }
];

/**
 * Seed a performance layer that exercises every state the design has to draw:
 * all 3 goal kinds, both metric directions, a month nobody reported, a goal
 * with no number for the open period, a corrected number with its original
 * still visible, and a region whose sites differ enough in size that averaging
 * their percentages is visibly the wrong answer.
 */
function seedPerformanceTestData_(user) {
  var now = nowIso_(), period = openPeriod_();
  var periods = periodsEndingAt_(period, TRAJECTORY_PERIODS);

  SEED_METRICS_.forEach(function (metric) {
    mergeMissingByKey_('Metrics', 'metricId', Object.assign({}, metric, { active: true, retiredAt: '', retiredBy: '', updatedAt: now, updatedBy: user.email }));
  });

  SEED_GOALS_.forEach(function (goal) {
    var row = {
      goalId: goal.goalId, metricId: goal.metricId, site: goal.site, goalKind: goal.goalKind,
      target: goal.target, baseline: goal.baseline === undefined ? '' : goal.baseline,
      startDate: '', targetDate: '',
      onTrackPace: goal.onTrackPace === undefined ? DEFAULT_THRESHOLDS.onTrackPace : goal.onTrackPace,
      atRiskPace: goal.atRiskPace === undefined ? DEFAULT_THRESHOLDS.atRiskPace : goal.atRiskPace,
      owner: goal.owner, ownerEmail: goal.ownerEmail, version: 1, active: true, retiredAt: '',
      createdBy: user.email, createdAt: now, updatedBy: user.email, updatedAt: now
    };
    if (goal.goalKind === 'journey') {
      /* A journey is anchored to the oldest period on the trajectory so the
         elapsed fraction is meaningful whenever the seed is run. */
      row.startDate = periods[0] + '-01';
      row.targetDate = periodFromIndex_(periodIndex_(periods[0]) + Number(goal.monthsToTarget || 12)) + '-28';
    }
    mergeMissingByKey_('Goals', 'goalId', row);
  });

  if (readTable_('Actuals').length) {
    return { metrics: SEED_METRICS_.length, goals: SEED_GOALS_.length, actuals: readTable_('Actuals').length };
  }

  var goalsById = {};
  readTable_('Goals').forEach(function (goal) { goalsById[String(goal.goalId)] = goal; });
  var rows = [];
  SEED_ACTUALS_.forEach(function (spec) {
    var goal = goalsById[spec.goalId];
    if (!goal) { return; }
    spec.values.forEach(function (entry, index) {
      if (!entry) { return; }
      var numerator = entry[0], denominator = entry[1];
      var value = entry.length > 2 ? entry[2] : (numerator / denominator) * 100;
      rows.push({
        actualId: 'seed-' + spec.goalId + '-' + periods[index],
        goalId: spec.goalId, site: goal.site, period: periods[index],
        numerator: numerator === null ? '' : numerator,
        denominator: denominator === null ? '' : denominator,
        value: value, noData: false, note: '',
        submissionKey: 'seed-' + spec.goalId + '-' + periods[index],
        supersedesActualId: '', correctionReason: '', approvedBy: '',
        enteredBy: String(goal.ownerEmail || user.email),
        enteredAt: periodFromIndex_(periodIndex_(periods[index]) + 1) + '-02T09:00:00.000Z'
      });
    });
  });

  /* One corrected number, so the append-only trail has something to show.
     The original stays in the record; the correction sits on top of it. */
  var correctedPeriod = periods[3];
  rows.push({
    actualId: 'seed-correction-original',
    goalId: 'goal-north-served', site: 'Harbor North', period: correctedPeriod,
    numerator: '', denominator: '', value: 26, noData: false, note: '',
    submissionKey: 'seed-correction-original',
    supersedesActualId: '', correctionReason: '', approvedBy: '',
    enteredBy: 'site@example.org',
    enteredAt: periodFromIndex_(periodIndex_(correctedPeriod) + 1) + '-02T09:00:00.000Z'
  });
  rows.forEach(function (row) {
    if (row.actualId === 'seed-goal-north-served-' + correctedPeriod) {
      row.supersedesActualId = 'seed-correction-original';
      row.correctionReason = 'Data entry error, 4 clients were counted twice';
      row.approvedBy = 'regional@example.org';
      row.enteredAt = periodFromIndex_(periodIndex_(correctedPeriod) + 1) + '-11T14:20:00.000Z';
    }
  });

  /* One month declared as genuinely having no data, which is a real answer and
     is not the same as reporting zero. */
  rows.push({
    actualId: 'seed-nodata-west',
    goalId: 'goal-west-screen', site: 'Harbor West', period: periods[2],
    numerator: '', denominator: '', value: '', noData: true,
    note: 'The screening clinic did not run this month.',
    submissionKey: 'seed-nodata-west',
    supersedesActualId: '', correctionReason: '', approvedBy: '',
    enteredBy: 'regional@example.org',
    enteredAt: periodFromIndex_(periodIndex_(periods[2]) + 1) + '-02T09:00:00.000Z'
  });

  appendRows_('Actuals', rows);
  return { metrics: SEED_METRICS_.length, goals: SEED_GOALS_.length, actuals: rows.length };
}
