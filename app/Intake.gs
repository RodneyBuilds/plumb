/** Concurrent-safe Intake operations. Every mutation re-reads inside the lock. */
function intakePublic_(row) { var item = cleanRow_(row); item.version = Number(item.version || 1); item.region = item.region || regionOfSite_(item.site) || ''; return item; }
function intakeInScope_(user, row) { return rowInScope_(user.role, user, row, regionOfFn_()); }

function nextIntakeNumberFrom_(rows) {
  var year = new Date().getFullYear(), prefix = 'INT-' + year + '-', highest = 0;
  (rows || []).forEach(function (row) { var value = String(row.requestNumber || ''); if (value.indexOf(prefix) === 0) { highest = Math.max(highest, Number(value.slice(prefix.length)) || 0); } });
  return prefix + String(highest + 1).padStart(4, '0');
}
function nextIntakeNumber_() { return nextIntakeNumberFrom_(readTable_('Intake')); }

function intakeList_(user, filters) {
  requirePermission_(user, 'intake.read'); filters = filters || {};
  var query = String(filters.query || '').trim().toLowerCase(), pending = operationPendingKeys_('Intake');
  var rows = readTable_('Intake').filter(function (row) {
    if (pending[String(row.id)] || truthy_(row.archived) || !intakeInScope_(user, row)) { return false; }
    if (filters.status && String(row.status) !== String(filters.status)) { return false; }
    if (filters.priority && String(row.priority) !== String(filters.priority)) { return false; }
    if (filters.site && String(row.site) !== String(filters.site)) { return false; }
    return !query || [row.requestNumber, row.title, row.description, row.requestType, row.site, row.owner, row.nextStep].join(' ').toLowerCase().indexOf(query) !== -1;
  });
  rows.sort(function (a, b) { return String(b.updatedAt || b.submittedAt).localeCompare(String(a.updatedAt || a.submittedAt)); });
  return { items: rows.map(intakePublic_), statuses: INTAKE_STATUSES.slice(), priorities: INTAKE_PRIORITIES.slice(), requestTypes: INTAKE_TYPES.slice(), canCreate: hasPermission_(user, 'intake.create'), canManage: hasPermission_(user, 'intake.manage') };
}

function intakeGet_(user, id) {
  requirePermission_(user, 'intake.read'); var row = findRow_('Intake', 'id', String(id || ''));
  if (!row || truthy_(row.archived)) { throw new Error('E_NOT_FOUND: Intake request not found.'); }
  if (!intakeInScope_(user, row)) { throw new Error('E_FORBIDDEN: that Intake request is outside your access area.'); }
  if (operationPending_('Intake', String(row.id))) { throw new Error('E_RECOVERY: this request has an incomplete save. Retry the original change or contact an administrator.'); }
  var history = readTable_('IntakeHistory').filter(function (item) { return String(item.intakeId) === String(row.id); });
  history.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  return { item: intakePublic_(row), history: history.map(cleanRow_), canManage: hasPermission_(user, 'intake.manage') };
}

function validatedIntakeFields_(input, existing) {
  var site = validateText_(input.site != null ? input.site : existing && existing.site, 'site', 200, true);
  var requestType = validateText_(input.requestType != null ? input.requestType : existing && existing.requestType || 'Other', 'request type', 100, true);
  if (INTAKE_TYPES.indexOf(requestType) === -1) { throw new Error('E_VALIDATION: choose a valid request type.'); }
  var priority = validateText_(input.priority != null ? input.priority : existing && existing.priority || 'Normal', 'priority', 20, true);
  if (INTAKE_PRIORITIES.indexOf(priority) === -1) { throw new Error('E_VALIDATION: choose a valid priority.'); }
  var email = validateText_(input.contactEmail != null ? input.contactEmail : existing && existing.contactEmail, 'contact email', 200, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { throw new Error('E_VALIDATION: enter a valid contact email address.'); }
  var sourceUrl = validateText_(input.sourceUrl != null ? input.sourceUrl : existing && existing.sourceUrl, 'supporting link', 2000, false);
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) { throw new Error('E_VALIDATION: supporting link must start with https://.'); }
  return { site: site, requestType: requestType, priority: priority, contactEmail: email, sourceUrl: sourceUrl };
}

/** Versioned edits bind their receipt to actor, action, record, and prior version. */
function intakeCommand_(user, input, action) {
  var key = input.id ? String(input.id) + ':' + String(input.version) + (input.operationKey ? ':' + validateText_(input.operationKey, 'operation key', 100, true) : '') : validateText_(input.submissionKey, 'submission key', 120, true);
  return { actor: user.email, action: action, submissionKey: key, payload: input };
}
function intakeWriteOptions_(user, input, transition) {
  return { tableKeys: { Intake: 'id', IntakeHistory: 'id', AuditLog: 'id' }, authorize: function () {
    user = refreshUser_(user);
    var row = input.id ? operationUnique_('Intake', 'id', String(input.id)) : null;
    if (input.id && (!row || truthy_(row.archived))) { throw new Error('E_NOT_FOUND: Intake request not found.'); }
    if (transition) { requirePermission_(user, 'intake.manage'); requireRowScope_(user, row, 'intake.manage'); }
    else if (row) {
      requireRowScope_(user, row, 'intake.read');
      if (!hasPermission_(user, 'intake.manage') && (String(row.submittedBy) !== user.email || row.status !== 'New')) { throw new Error('E_FORBIDDEN: only Intake managers can edit a request after triage begins.'); }
    } else { requirePermission_(user, 'intake.create'); }
    if (!transition) { requireRowScope_(user, {site: input.site != null ? input.site : row && row.site}, row ? 'intake.read' : 'intake.create'); }
  }};
}
function intakePlan_(opId, at, row, before, action, note, actor) {
  var history = { id: operationChildId_(opId, 'history'), intakeId: row.id, requestNumber: row.requestNumber, action: action,
    fromStatus: before ? before.status : '', toStatus: row.status, fromVersion: before ? Number(before.version || 1) : 0,
    toVersion: row.version, note: note, actor: actor, at: at };
  return [operationStep_('Intake', 'id', before, row), operationStep_('IntakeHistory', 'id', null, history),
    operationAuditStep_(opId, at, 'intake', row.id, !before ? 'create' : action === 'Updated' ? 'update' : 'status', before, row, actor)];
}
function intakeSave_(user, input) {
  input = input || {};
  return withLock_(function () {
    user = refreshUser_(user);
    var command = intakeCommand_(user, input, 'intake.save');
    var result = operationRunLocked_(command, function (opId, now) {
      var intakeRows = readTable_('Intake'), existing = input.id ? operationUnique_('Intake', 'id', String(input.id)) : null;
      if (existing && !versionMatches_(existing.version, input.version)) { throw new Error('E_CONFLICT: this request changed after you opened it. Reload the latest version before saving.'); }
      var fields = validatedIntakeFields_(input, existing), before = existing ? cleanRow_(existing) : null;
      var row = existing ? cleanRow_(existing) : { id: operationChildId_(opId, 'intake'), requestNumber: nextIntakeNumberFrom_(intakeRows), submissionKey: command.submissionKey, version: 0, status: 'New', owner: '', nextStep: '', dueDate: '', submittedBy: user.email, submittedAt: now, archived: false };
      row.title = validateText_(input.title != null ? input.title : row.title, 'title', 200, true);
      row.requestType = fields.requestType; row.site = fields.site; row.region = regionOfSite_(fields.site) || '';
      row.description = validateText_(input.description != null ? input.description : row.description, 'description', 10000, true);
      row.priority = fields.priority; row.impact = validateText_(input.impact != null ? input.impact : row.impact, 'impact', 2000, false);
      row.desiredOutcome = validateText_(input.desiredOutcome != null ? input.desiredOutcome : row.desiredOutcome, 'desired outcome', 4000, false);
      row.requestedSupport = validateText_(input.requestedSupport != null ? input.requestedSupport : row.requestedSupport, 'requested support', 4000, false);
      row.contactName = validateText_(input.contactName != null ? input.contactName : row.contactName || user.name, 'contact name', 200, false);
      row.contactEmail = fields.contactEmail || row.contactEmail || user.email; row.sourceUrl = fields.sourceUrl;
      row.targetDate = accessDate_(input.targetDate != null ? input.targetDate : row.targetDate || '');
      if (hasPermission_(user, 'intake.manage')) {
        row.owner = validateText_(input.owner != null ? input.owner : row.owner, 'owner', 200, false);
        row.nextStep = validateText_(input.nextStep != null ? input.nextStep : row.nextStep, 'next step', 2000, false);
        row.dueDate = accessDate_(input.dueDate != null ? input.dueDate : row.dueDate || '');
      }
      var note = validateText_(input.note, 'note', 2000, false);
      row.version = existing ? nextVersion_(existing.version) : 1; row.updatedBy = user.email; row.updatedAt = now;
      return intakePlan_(opId, now, row, before, existing ? 'Updated' : 'Submitted', note, user.email);
    }, intakeWriteOptions_(user, input, false));
    var id = input.id || operationChildId_(result.operationId, 'intake');
    return {item: intakeGet_(refreshUser_(user), id).item, created: !input.id && !result.duplicate, duplicate: result.duplicate};
  });
}
function intakeTransition_(user, input) {
  input = input || {};
  return withLock_(function () {
    user = refreshUser_(user); requirePermission_(user, 'intake.manage');
    var command = intakeCommand_(user, input, 'intake.transition');
    var result = operationRunLocked_(command, function (opId, now) {
      var existing = operationUnique_('Intake', 'id', String(input.id || '')), row = cleanRow_(existing), before = cleanRow_(existing);
      if (!versionMatches_(row.version, input.version)) { throw new Error('E_CONFLICT: this request changed after you opened it. Reload the latest version before changing status.'); }
      var target = String(input.status || '');
      if (!transitionAllowed_(row.status, target)) { throw new Error('E_VALIDATION: that status change is not allowed from ' + row.status + '.'); }
      var from = String(row.status); row.status = target;
      if (input.owner != null) { row.owner = validateText_(input.owner, 'owner', 200, false); }
      if (input.nextStep != null) { row.nextStep = validateText_(input.nextStep, 'next step', 2000, false); }
      if (input.dueDate != null) { row.dueDate = accessDate_(input.dueDate || ''); }
      if ((target === 'Assigned' || target === 'In Progress') && !String(row.owner || '').trim()) { throw new Error('E_VALIDATION: assign an owner before moving this request forward.'); }
      if (target === 'In Progress' && !String(row.nextStep || '').trim()) { throw new Error('E_VALIDATION: add the next step before work begins.'); }
      var note = validateText_(input.note, 'note', 2000, false);
      row.version = nextVersion_(row.version); row.updatedBy = user.email; row.updatedAt = now;
      return intakePlan_(opId, now, row, before, target === 'Triaged' && from === 'Closed' ? 'Reopened' : 'Status changed', note, user.email);
    }, intakeWriteOptions_(user, input, true));
    return { item: intakeGet_(refreshUser_(user), input.id).item, duplicate: result.duplicate };
  });
}
