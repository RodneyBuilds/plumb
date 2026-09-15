/** Web entry point and single allowlisted client API. */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate().setTitle(PRODUCT_NAME).addMetaTag('viewport', 'width=device-width, initial-scale=1').setSandboxMode(HtmlService.SandboxMode.IFRAME);
}
function include_(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }
function apiOk_(data) { return Object.assign({ ok: true }, apiSafe_(data || {}, '')); }
function apiSafe_(value, key) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) { return ''; }
    if (/date$/i.test(String(key || '')) || /^(startsOn|endsOn)$/i.test(String(key || ''))) { return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0'); }
    return value.toISOString();
  }
  if (Array.isArray(value)) { return value.map(function (item) { return apiSafe_(item, key); }); }
  if (value && typeof value === 'object') { var out = {}; Object.keys(value).forEach(function (child) { out[child] = apiSafe_(value[child], child); }); return out; }
  return value;
}
function apiErr_(error) {
  var message = error && error.message ? String(error.message) : 'E_INTERNAL: unexpected error.';
  var code = /^E_[A-Z_]+/.test(message) ? message.split(':')[0] : 'E_INTERNAL';
  return { ok: false, code: code, error: code === 'E_INTERNAL' ? 'E_INTERNAL: something went wrong. Try again.' : message };
}
function requireKnown_(user) { if (!user || !user.known) { throw new Error('E_FORBIDDEN: your account is not active in this workspace.'); } }

function api(request) {
  try {
    request = request || {}; var action = String(request.action || ''), payload = request.payload || {};
    throttle_(action);
    /* One request, one read of the served guidance. Apps Script would give this
       a fresh scope anyway; saying so here is what keeps the offline harness,
       which reuses one scope for a whole run, honest about staleness. */
    playbookResetCache_();
    if (action === 'bootstrap') { return withLock_(function () { return apiOk_(bootstrap_()); }); }
    var user = resolveUser_(); requireKnown_(user);
    var routes = {
      'theme.save': function () { return saveTheme_(payload.theme); },
      'intake.list': function () { return intakeList_(user, payload); },
      'intake.get': function () { return intakeGet_(user, payload.id); },
      'intake.save': function () { return intakeSave_(user, payload); },
      'intake.transition': function () { return intakeTransition_(user, payload); },
      'branding.save': function () { return saveBranding_(user, payload); },
      'site.list': function () { return listSitesAdmin_(user); },
      'site.save': function () { return saveSiteAdmin_(user, payload.item); },
      'access.list': function () { return listUserAccess_(user); },
      'access.save': function () { return withLock_(function () { return upsertUserAccess_(user, payload); }); },
      'access.scope.save': function () { return saveUserScopeAdmin_(user, payload); },
      'metric.list': function () { return metricList_(user); },
      'metric.save': function () { return metricSave_(user, payload); },
      'metric.retire': function () { return metricRetire_(user, payload); },
      'goal.list': function () { return goalList_(user); },
      'goal.get': function () { return goalGet_(user, payload); },
      'goal.save': function () { return goalSave_(user, payload); },
      'goal.retire': function () { return goalRetire_(user, payload); },
      'performance.board': function () { return performanceBoard_(user, payload); },
      'performance.entry': function () { return entrySheet_(user, payload); },
      'performance.rollup': function () { return performanceRollup_(user, payload); },
      'actual.saveMonth': function () { return actualSaveMonth_(user, payload); },
      'actual.correct': function () { return actualCorrect_(user, payload); },
      'reminders.preview': function () { return previewDataDueReminders_(user, payload); },
      'reminders.settings': function () { return reminderSettings_(user, payload); },
      'playbook.board': function () { return playbookBoard_(user); },
      'playbook.ensureDoc': function () { return playbookEnsureDocRoute_(user); },
      'playbook.recheck': function () { return playbookRecheck_(user); },
      'playbook.remind': function () { return playbookRemind_(user, payload); },
      'playbook.settings': function () { return playbookSettings_(user, payload); }
    };
    if (!Object.prototype.hasOwnProperty.call(routes,action)) { throw new Error('E_NOT_FOUND: unknown action.'); }
    var readOnly = /\.(list|get)$/.test(action) || ['performance.board','performance.entry','performance.rollup','reminders.preview','playbook.board'].indexOf(action) !== -1;
    if (readOnly) { return withLock_(function () { user = refreshUser_(user); return apiOk_(routes[action]()); }); }
    return apiOk_(routes[action]());
  } catch (error) { return apiErr_(error); }
}

function bootstrap_() {
  var user = resolveUser_(), theme = 'light';
  try { theme = PropertiesService.getUserProperties().getProperty('theme') || 'light'; } catch (ignore) {}
  var canEnter = user.known && hasPermission_(user, 'performance.enter');
  var period = openPeriod_();
  return {
    user: { name: user.name, email: user.email, role: user.role, roleName: user.roleName || user.role, region: user.region, site: user.site, primaryScopeName: user.primaryScopeName || '', primaryScopeType: user.primaryScopeType || '', scopes: user.scopes || [], known: user.known },
    branding: brandingConfig_(), nav: user.known ? navForUser_(user) : [], sites: user.known ? sitesInScope_(user) : [], theme: theme,
    intakeStatuses: INTAKE_STATUSES, intakePriorities: INTAKE_PRIORITIES, intakeTypes: INTAKE_TYPES,
    canCreateIntake: user.known && hasPermission_(user, 'intake.create'), canManageIntake: user.known && hasPermission_(user, 'intake.manage'),
    performance: {
      period: period,
      periodLabel: periodLabel_(period),
      periodMonth: periodMonthName_(period),
      entryClosesOn: entryClosesOn_(period),
      entryClosesOnLabel: niceDate_(entryClosesOn_(period)),
      late: periodIsLate_(period, new Date()),
      canRead: user.known && hasAnyPerformancePermission_(user.permissions),
      canEnter: canEnter,
      canManageGoals: user.known && hasPermission_(user, 'performance.goal.manage'),
      canManageMetrics: user.known && hasPermission_(user, 'performance.metric.manage'),
      /* The sidebar count reports missing monthly entries. It rides on the
         boot call that already happens, so it costs no extra round trip. */
      missingThisPeriod: canEnter ? missingCountForUser_(user, period) : 0,
      metricTypes: METRIC_TYPES, directions: METRIC_DIRECTIONS, goalKinds: GOAL_KINDS,
      correctionReasons: CORRECTION_REASONS, defaultThresholds: DEFAULT_THRESHOLDS,
      trajectoryPeriods: TRAJECTORY_PERIODS, trendMinRun: TREND_MIN_RUN
    },
    improve: {
      canReadPlaybook: user.known && hasAnyPerformancePermission_(user.permissions),
      canManagePlaybook: user.known && isPlaybookMaintainer_(user),
      canOwnActions: user.known && hasPermission_(user, 'improvement.action.own'),
      canManageActions: user.known && hasPermission_(user, 'improvement.action.manage'),
      situations: GUIDANCE_SITUATIONS.map(function (situation) { return { key: situation, label: SITUATION_LABELS[situation] }; })
    }
  };
}

/** How many goals in this person's own sites still have no number this month. */
function missingCountForUser_(user, period) {
  try {
    var sites = sitesInScope_(user);
    if (!sites.length) { return 0; }
    var byGoal = actualsByGoal_(readTable_('Actuals').map(cleanRow_));
    return goalRows_().filter(function (goal) {
      if (goal.active === false || String(goal.active).toUpperCase() === 'FALSE') { return false; }
      if (sites.indexOf(String(goal.site)) === -1) { return false; }
      return !liveActualRows_(byGoal[String(goal.goalId)] || []).some(function (row) { return String(row.period) === String(period); });
    }).length;
  } catch (ignore) { return 0; }
}
function saveTheme_(theme) { theme = theme === 'dark' ? 'dark' : 'light'; PropertiesService.getUserProperties().setProperty('theme', theme); return { theme: theme }; }
function brandingConfig_() {
  var props = PropertiesService.getScriptProperties(), name = String(props.getProperty('CUSTOMER_NAME') || 'Your Organization').trim(), shortName = String(props.getProperty('CUSTOMER_SHORT_NAME') || name).trim(), descriptor = String(props.getProperty('CUSTOMER_DESCRIPTOR') || 'Program improvement intake').trim(), mark = String(props.getProperty('CUSTOMER_MARK') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3), accent = String(props.getProperty('CUSTOMER_ACCENT') || '#19713F').trim();
  if (!mark) { mark = name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part.charAt(0); }).join('').toUpperCase() || 'PI'; }
  if (!/^#[0-9a-f]{6}$/i.test(accent)) { accent = '#19713F'; }
  return { customerName: name.slice(0, 120), customerShortName: shortName.slice(0, 60), customerDescriptor: descriptor.slice(0, 100), customerMark: mark, accent: accent.toUpperCase(), productName: PRODUCT_NAME };
}
function saveBranding_(user, input) {
  requirePermission_(user, 'admin.manage'); input = input || {}; var before = brandingConfig_();
  var next = { customerName: validateText_(input.customerName, 'customer name', 120, true), customerShortName: validateText_(input.customerShortName || input.customerName, 'short customer name', 60, true), customerDescriptor: validateText_(input.customerDescriptor || 'Program improvement intake', 'customer descriptor', 100, true), customerMark: validateText_(input.customerMark, 'customer mark', 3, true).toUpperCase().replace(/[^A-Z0-9]/g, ''), accent: String(input.accent || '#19713F').trim().toUpperCase() };
  if (!/^[A-Z0-9]{1,3}$/.test(next.customerMark)) { throw new Error('E_VALIDATION: customer mark must use 1 to 3 letters or numbers.'); }
  if (!/^#[0-9A-F]{6}$/.test(next.accent)) { throw new Error('E_VALIDATION: accent color must be a 6-digit hex color such as #19713F.'); }
  var props = PropertiesService.getScriptProperties(); props.setProperty('CUSTOMER_NAME', next.customerName); props.setProperty('CUSTOMER_SHORT_NAME', next.customerShortName); props.setProperty('CUSTOMER_DESCRIPTOR', next.customerDescriptor); props.setProperty('CUSTOMER_MARK', next.customerMark); props.setProperty('CUSTOMER_ACCENT', next.accent);
  /* The product name is never part of what a customer stores. It is stamped on
     the way out, so renaming the product never has to touch client data. */
  audit_('branding', 'workspace', 'update', before, next, user.email); next.productName = PRODUCT_NAME; return { branding: next };
}
function listSitesAdmin_(user) { requirePermission_(user, 'admin.manage'); var pending = operationPendingKeys_('Sites'); var items = readTable_('Sites').filter(function (site) { return !pending[String(site.site)]; }).map(cleanRow_); items.sort(function (a, b) { return String(a.site).localeCompare(String(b.site)); }); return { items: items }; }
function saveSiteAdmin_(user, input) {
  input = input || {};
  return withLock_(function () {
    var command = {actor:user.email,action:'site.save',submissionKey:validateText_(input.submissionKey,'submission key',120,true),payload:input};
    var result = operationRunLocked_(command,function (opId,at) {
      var site = validateText_(input.site,'site',200,true), original = String(input.originalSite || site), existing = findRow_('Sites','site',original);
      if (existing && original !== site) { throw new Error('E_VALIDATION: site names cannot be renamed. Add the new site and deactivate the old one.'); }
      if (input.active !== undefined && typeof input.active !== 'boolean') { throw new Error('E_VALIDATION: active must be true or false.'); }
      var regionName = validateText_(input.region,'region',200,false);
      if (existing && String(existing.region || '') !== regionName) { throw new Error('E_VALIDATION: moving a site requires a reviewed hierarchy migration.'); }
      if (readTable_('Sites').some(function (row) { return row.site !== original && String(row.site).trim().toLowerCase() === site.toLowerCase(); })) { throw new Error('E_VALIDATION: site name already exists.'); }
      var row = {site:site,region:regionName,active:input.active !== false}, steps = [], parentId = ACCESS_ROOT_UNIT_ID_;
      if (regionName) {
        var region = findAccessUnitByName_('region',regionName);
        if (region && !accessActive_(region.active)) { throw new Error('E_VALIDATION: region is inactive.'); }
        parentId = region ? region.unitId : operationChildId_(opId,'region');
        if (!region) { steps.push(operationStep_('OrganizationUnits','unitId',null,{unitId:parentId,unitType:'region',parentUnitId:ACCESS_ROOT_UNIT_ID_,name:regionName,code:safeKey_(regionName).toUpperCase(),active:true,updatedAt:at,updatedBy:user.email})); }
      }
      var oldUnit = findAccessUnitByName_('site',site), unitId = oldUnit ? oldUnit.unitId : operationChildId_(opId,'site');
      if (oldUnit && String(oldUnit.parentUnitId) !== parentId) { throw new Error('E_CONFIG: inconsistent site hierarchy requires repair.'); }
      steps.push(operationStep_('OrganizationUnits','unitId',oldUnit,{unitId:unitId,unitType:'site',parentUnitId:parentId,name:site,code:safeKey_(site).toUpperCase(),active:row.active,updatedAt:at,updatedBy:user.email}));
      steps.push(operationStep_('Sites','site',existing,row));
      steps.push(operationAuditStep_(opId,at,'site',site,existing?'update':'create',existing,row,user.email));
      return steps;
    },{tableKeys:{Sites:'site',OrganizationUnits:'unitId',AuditLog:'id'},authorize:function () { user = refreshUser_(user); requirePermission_(user,'admin.manage'); }});
    return {item:cleanRow_(findRow_('Sites','site',String(input.site).trim())),created:!!findRow_('AuditLog','id',operationChildId_(result.operationId,'audit:site:'+String(input.site).trim()+':create')),duplicate:result.duplicate};
  });
}

function throttle_(action) {
  var cache = CacheService.getScriptCache(), key = 'rate:' + (currentEmail_() || 'unknown') + ':' + new Date().toISOString().slice(0, 16), count = Number(cache.get(key) || 0) + 1;
  if (count > 120) { throw new Error('E_RATE_LIMIT: too many actions. Wait 1 minute and try again.'); }
  cache.put(key, String(count), 90);
}
