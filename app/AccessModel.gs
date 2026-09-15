/**
 * AccessModel.gs - configurable one-role, multi-scope access foundation.
 *
 * A user owns exactly one roleKey in Users. UserScopes may grant several
 * organization units, including temporary cross-region coverage. Extra
 * scopes expand where the role operates; they never add role permissions.
 */

var ACCESS_ROOT_UNIT_ID_ = 'ORG-ROOT';
var ACCESS_ASSIGNMENT_TYPES_ = ['Primary', 'Additional', 'Temporary Coverage', 'Emergency Coverage', 'Project'];

function accessCacheVersion_() {
  try { return PropertiesService.getScriptProperties().getProperty('ACCESS_CACHE_VERSION') || '1'; } catch (ignore) { return '1'; }
}

function bumpAccessCacheVersion_() {
  try {
    var props = PropertiesService.getScriptProperties(), next = Number(props.getProperty('ACCESS_CACHE_VERSION') || 1) + 1;
    props.setProperty('ACCESS_CACHE_VERSION', String(next));
    return String(next);
  } catch (ignore) { return String(Date.now()); }
}

function accessModelReady_() {
  return hasSheet_('Users') && hasSheet_('Roles') && hasSheet_('Permissions') &&
    hasSheet_('RolePermissions') && hasSheet_('OrganizationUnits') && hasSheet_('UserScopes');
}

function accessActive_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'active';
}

function accessUnitId_(unitType, name) {
  var unit = findAccessUnitByName_(unitType, name);
  return unit ? unit.unitId : 'unit_' + Utilities.getUuid();
}

function accessUserId_(email) {
  var users = readTable_('Users').filter(function (row) { return normalizeEmail_(row.email) === normalizeEmail_(email); });
  if (users.length > 1) { throw new Error('E_CONFIG: duplicate user identities require repair.'); }
  return users.length ? users[0].userId : 'user_' + Utilities.getUuid();
}

function seedAccessCatalogs_(actor) {
  var at = nowIso_();
  DEFAULT_ROLES.forEach(function (item) {
    var row = Object.assign({}, item, { updatedAt: at, updatedBy: actor });
    mergeMissingByKey_('Roles', 'roleKey', row);
  });
  DEFAULT_PERMISSIONS.forEach(function (item) {
    var row = Object.assign({}, item, { active: true, updatedAt: at, updatedBy: actor });
    mergeMissingByKey_('Permissions', 'permissionKey', row);
  });
  DEFAULT_ROLE_PERMISSIONS.forEach(function (item) {
    var row = Object.assign({}, item, { updatedAt: at, updatedBy: actor });
    mergeMissingByKey_('RolePermissions', 'rolePermissionId', row);
  });
  mergeMissingByKey_('OrganizationUnits', 'unitId', {
    unitId: ACCESS_ROOT_UNIT_ID_, unitType: 'organization', parentUnitId: '', name: 'Organization', code: 'ORG',
    active: true, updatedAt: at, updatedBy: actor
  });
  bumpAccessCacheVersion_();
}

function syncOrganizationUnitsFromSites_(actor) {
  if (!hasSheet_('Sites') || !hasSheet_('OrganizationUnits')) { return; }
  var at = nowIso_();
  var regions = {};
  readTable_('Sites').forEach(function (siteRow) {
    var siteName = String(siteRow.site || '').trim();
    if (!siteName) { return; }
    var regionName = String(siteRow.region || '').trim();
    var parentId = ACCESS_ROOT_UNIT_ID_;
    if (regionName) {
      parentId = accessUnitId_('region', regionName);
      if (!regions[parentId]) {
        mergeMissingByKey_('OrganizationUnits', 'unitId', {
          unitId: parentId, unitType: 'region', parentUnitId: ACCESS_ROOT_UNIT_ID_, name: regionName,
          code: safeKey_(regionName).toUpperCase(), active: true, updatedAt: at, updatedBy: actor
        });
        regions[parentId] = true;
      }
    }
    mergeMissingByKey_('OrganizationUnits', 'unitId', {
      unitId: accessUnitId_('site', siteName), unitType: 'site', parentUnitId: parentId, name: siteName,
      code: safeKey_(siteName).toUpperCase(), active: accessActive_(siteRow.active), updatedAt: at, updatedBy: actor
    });
  });
  bumpAccessCacheVersion_();
}

function findAccessUnitByName_(unitType, name) {
  var matches = readTable_('OrganizationUnits').filter(function (row) { return String(row.unitType).toLowerCase() === String(unitType).toLowerCase() && String(row.name).trim().toLowerCase() === String(name).trim().toLowerCase(); });
  if (matches.length > 1) { throw new Error('E_CONFIG: ambiguous organization units require repair.'); }
  return matches[0] || null;
}

function accessRole_(roleKey) {
  var matches = readTable_('Roles').filter(function (row) { return String(row.roleKey).toLowerCase() === String(roleKey || '').toLowerCase(); });
  var role = matches.length === 1 ? matches[0] : null;
  return role && accessActive_(role.active) ? role : null;
}

function accessPermissionsForRole_(roleKey) {
  var activePermissions = {};
  readTable_('Permissions').forEach(function (row) {
    if (accessActive_(row.active)) { activePermissions[String(row.permissionKey)] = true; }
  });
  var seen = {};
  return readTable_('RolePermissions').filter(function (row) {
    return String(row.roleKey) === String(roleKey) && accessActive_(row.active) && activePermissions[String(row.permissionKey)];
  }).map(function (row) { return String(row.permissionKey); }).filter(function (key) {
    if (seen[key]) { return false; }
    seen[key] = true;
    return true;
  });
}

function accessScopeCeilingForRole_(roleKey) {
  var rank = { organization: 5, program: 4, division: 3, region: 2, site: 1, self: 0 };
  var best = 'self', bestRank = 0;
  readTable_('RolePermissions').forEach(function (row) {
    var ceiling = String(row.scopeCeiling || 'self');
    if (String(row.roleKey) === String(roleKey) && accessActive_(row.active) && rank[ceiling] > bestRank) {
      best = ceiling;
      bestRank = rank[ceiling];
    }
  });
  return best;
}

function accessScopesForUser_(userId, includeInactive) {
  var rows = readTable_('UserScopes').filter(function (row) { return String(row.userId) === String(userId); });
  if (!includeInactive) { rows = rows.filter(function (row) { try { accessDate_(row.startsOn); accessDate_(row.endsOn); } catch (invalidDate) { return false; } return scopeAssignmentActive_(row); }); }
  rows.sort(function (a, b) {
    var ap = accessActive_(a.primary) ? 0 : 1, bp = accessActive_(b.primary) ? 0 : 1;
    return ap !== bp ? ap - bp : String(a.scopeId).localeCompare(String(b.scopeId));
  });
  return rows;
}

function accessUnitIndex_() {
  var map = {}, rows = readTable_('OrganizationUnits'), ids = {}, names = {};
  var pendingUnits = operationPendingKeys_('OrganizationUnits');
  rows.forEach(function (row) {
    var id = String(row.unitId), key = String(row.unitType).toLowerCase() + ':' + String(row.name).trim().toLowerCase();
    if (!id || ids[id] || names[key]) { throw new Error('E_CONFIG: duplicate organization identities require repair.'); }
    ids[id] = true; names[key] = true;
    if (accessActive_(row.active) && !pendingUnits[id]) { map[id] = row; }
  });
  Object.keys(map).forEach(function (id) {
    var cursor = id, seen = {}, valid = false;
    while (cursor && map[cursor] && !seen[cursor]) {
      if (cursor === ACCESS_ROOT_UNIT_ID_) { valid = true; break; }
      seen[cursor] = true; cursor = String(map[cursor].parentUnitId || '');
    }
    if (!valid) { delete map[id]; }
  });
  return map;
}

function accessSitesForScopes_(scopeRows) {
  var unitById = accessUnitIndex_(), scopeIds = activeScopeIds_(scopeRows), seen = {};
  Object.keys(unitById).forEach(function (unitId) {
    var unit = unitById[unitId];
    if (String(unit.unitType) !== 'site') { return; }
    var site = findRow_('Sites', 'site', String(unit.name));
    if (!site || !accessActive_(site.active) || operationPending_('Sites',String(site.site))) { return; }
    if (scopeIds.some(function (scopeId) { return unitWithinScope_(unitId, scopeId, unitById); })) {
      seen[String(unit.name)] = true;
    }
  });
  return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
}

function resolveAccessUser_(email) {
  email = normalizeEmail_(email);
  var props = PropertiesService.getScriptProperties();
  if (!internalEmail_(email) || props.getProperty('INSTALLATION_STATE') !== 'ready') { return null; }
  var all = readTable_('Users'), ids = Object.create(null), emails = Object.create(null), invalid = false;
  all.forEach(function (row) { var normalized = normalizeEmail_(row.email), id = String(row.userId || ''); if (!id || ids[id] || emails[normalized]) { invalid = true; } ids[id] = true; emails[normalized] = true; });
  if (invalid) { return null; }
  var rec = all.filter(function (row) { return normalizeEmail_(row.email) === email; })[0];
  if (!rec || !accessActive_(rec.active) || accessPendingForUser_(rec)) { return null; }
  var role = accessRole_(rec.roleKey);
  if (!role) { return null; }
  var permissions = accessPermissionsForRole_(rec.roleKey);
  if (permissions.indexOf('app.read') === -1) { return null; }
  var unitIndex = accessUnitIndex_(), ceiling = accessScopeCeilingForRole_(rec.roleKey);
  var scopes = accessScopesForUser_(rec.userId, false).filter(function (scope) {
    var unit = unitIndex[String(scope.scopeId)];
    return unit && String(scope.scopeType) === String(unit.unitType) && scopeCeilingAllows_(ceiling, String(unit.unitType));
  });
  if (!scopes.length) { return null; }
  if (permissions.indexOf('admin.manage') !== -1 && !accessRootAdmin_(rec, scopes)) { return null; }
  var primary = scopes.filter(function (row) { return accessActive_(row.primary); })[0] || scopes[0];
  var primaryUnit = findRow_('OrganizationUnits', 'unitId', primary.scopeId);
  var resolved = {
    userId: rec.userId,
    email: email,
    name: rec.name,
    role: rec.roleKey,
    roleKey: rec.roleKey,
    roleName: role.displayName || rec.roleKey,
    known: true,
    permissions: permissions,
    scopes: scopes.map(cleanRow_),
    scopeSites: accessSitesForScopes_(scopes),
    primaryScopeId: primary.scopeId,
    primaryScopeType: primary.scopeType,
    primaryScopeName: primaryUnit ? primaryUnit.name : primary.scopeId,
    region: primaryUnit && String(primaryUnit.unitType) === 'region' ? primaryUnit.name : '',
    site: primaryUnit && String(primaryUnit.unitType) === 'site' ? primaryUnit.name : ''
  };
  return resolved;
}

function listUserAccess_(actorUser) {
  requirePermission_(actorUser, 'admin.manage');
  var roles = {};
  readTable_('Roles').forEach(function (row) { roles[String(row.roleKey)] = row; });
  var units = accessUnitIndex_();
  var items = readTable_('Users').map(function (row) {
    var scopes = accessScopesForUser_(row.userId, true).map(function (scope) {
      var unit = units[String(scope.scopeId)];
      var clean = cleanRow_(scope);
      clean.scopeName = unit ? unit.name : scope.scopeId;
      return clean;
    });
    var primary = scopes.filter(function (scope) { return accessActive_(scope.primary) && String(scope.status).toLowerCase() === 'active'; })[0] || scopes[0] || {};
    return {
      userId: row.userId, email: row.email, name: row.name, role: row.roleKey, roleKey: row.roleKey,
      roleName: roles[String(row.roleKey)] ? roles[String(row.roleKey)].displayName : row.roleKey,
      active: row.active, pending: accessPendingForUser_(row), scopes: scopes, region: primary.scopeType === 'region' ? primary.scopeName : '',
      site: primary.scopeType === 'site' ? primary.scopeName : ''
    };
  });
  items.sort(function (a, b) { return String(a.name || a.email).localeCompare(String(b.name || b.email)); });
  return { items: items, roles: readTable_('Roles').filter(function (row) { return accessActive_(row.active); }).map(cleanRow_), units: Object.keys(units).map(function (id) { return cleanRow_(units[id]); }) };
}


/** Validate the entire access command before touching users, grants, or audit rows. */
function accessDate_(value) {
  var text = String(value || '');
  if (text && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !isFinite(new Date(text + 'T00:00:00Z').getTime()) || new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) !== text)) { throw new Error('E_VALIDATION: use a real date in YYYY-MM-DD format.'); }
  return text;
}
function validateUserScope_(actor, user, input, existingScopes, operationId, at) {
  input = input || {};
  var deactivating = input.status === 'inactive' && existingScopes.some(function (scope) { return input.userScopeId ? scope.userScopeId === input.userScopeId : scope.scopeId === input.scopeId; });
  var index = accessUnitIndex_(), unit = index[String(input.scopeId || '')] || (deactivating ? findRow_('OrganizationUnits', 'unitId', String(input.scopeId || '')) : null);
  if (!unit) { throw new Error('E_VALIDATION: choose an active organization scope.'); }
  if (!deactivating && !scopeCeilingAllows_(accessScopeCeilingForRole_(user.roleKey), unit.unitType)) { throw new Error('E_VALIDATION: that scope is broader than this role allows.'); }
  var existing = input.userScopeId ? findRow_('UserScopes', 'userScopeId', String(input.userScopeId)) : existingScopes.filter(function (row) { return String(row.scopeId) === String(unit.unitId); })[0];
  if (input.userScopeId && (!existing || String(existing.userId) !== String(user.userId))) { throw new Error('E_VALIDATION: scope assignment does not belong to this person.'); }
  var primary = input.primary === true || String(input.primary).toUpperCase() === 'TRUE';
  var assignmentType = String(input.assignmentType || (primary ? 'Primary' : 'Additional'));
  var status = String(input.status === undefined ? 'active' : input.status).toLowerCase();
  if (['active', 'inactive'].indexOf(status) === -1 || ACCESS_ASSIGNMENT_TYPES_.indexOf(assignmentType) === -1) { throw new Error('E_VALIDATION: invalid scope status or assignment type.'); }
  var starts = accessDate_(input.startsOn), ends = accessDate_(input.endsOn), reason = validateText_(input.reason, 'reason', 500, false), approved = validateText_(input.approvedBy, 'approved by', 200, false);
  if (starts && ends && ends < starts) { throw new Error('E_VALIDATION: coverage end date cannot precede start date.'); }
  if (['Temporary Coverage', 'Emergency Coverage'].indexOf(assignmentType) !== -1 && (!starts || !ends || !reason || !approved)) { throw new Error('E_VALIDATION: temporary coverage requires dates, reason and approver.'); }
  return { userScopeId: existing ? existing.userScopeId : accessStableId_(operationId, 'scope:' + unit.unitId, 'scope'), userId: user.userId, scopeType: unit.unitType, scopeId: unit.unitId, primary: primary, assignmentType: assignmentType, startsOn: starts, endsOn: ends, status: status, reason: reason, approvedBy: approved, assignedBy: actor, updatedAt: at };
}
function accessRootAdmin_(user, scopes, ignoredOperationId) {
  if (!user || !internalEmail_(user.email) || !accessActive_(user.active) || !accessRole_(user.roleKey) || accessPendingForUser_(user, ignoredOperationId)) { return false; }
  var permissions = accessPermissionsForRole_(user.roleKey), root = accessUnitIndex_()[ACCESS_ROOT_UNIT_ID_];
  if (!root || permissions.indexOf('app.read') === -1 || permissions.indexOf('admin.manage') === -1 || !scopeCeilingAllows_(accessScopeCeilingForRole_(user.roleKey), root.unitType)) { return false; }
  return scopes.some(function (scope) {
    try { accessDate_(scope.startsOn); accessDate_(scope.endsOn); } catch (invalidDate) { return false; }
    return scope.scopeId === ACCESS_ROOT_UNIT_ID_ && String(scope.scopeType) === String(root.unitType) && scopeAssignmentActive_(scope);
  });
}

var ACCESS_OPERATION_TABLES_ = { Users: 'userId', UserScopes: 'userScopeId', AuditLog: 'id' };

function accessStableId_(operationId, label, prefix) {
  var hex = operationHash_([operationId, label]);
  return prefix + '_' + hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}
function accessTargetPrefix_(email) { return operationHash_(normalizeEmail_(email)) + ':'; }

/** Receipt identity fences the target even before its first plan row exists. */
function accessPendingForUser_(user, ignoredOperationId) {
  if (!user) { return false; }
  var prefix = accessTargetPrefix_(user.email), pending = Object.create(null), blocked = false;
  readTable_('Operations').forEach(function (receipt) {
    if (['COMMITTED', 'CANCELLED'].indexOf(receipt.status) !== -1 || receipt.operationId === ignoredOperationId) { return; }
    pending[receipt.operationId] = true;
    if (receipt.action === 'access.save' && String(receipt.submissionKey).indexOf(prefix) === 0) { blocked = true; }
  });
  if (blocked) { return true; }
  var scopes = accessScopesForUser_(user.userId, true).map(function (scope) { return String(scope.userScopeId); });
  return readTable_('OperationSteps').some(function (step) {
    return pending[step.operationId] && ((step.table === 'Users' && String(step.recordKey) === String(user.userId)) ||
      (step.table === 'UserScopes' && scopes.indexOf(String(step.recordKey)) !== -1));
  });
}
function accessReceiptStillCurrent_(receipt) {
  var steps = readTable_('OperationSteps').filter(function (step) { return step.operationId === receipt.operationId && (step.table === 'Users' || step.table === 'UserScopes'); });
  return steps.length > 0 && steps.every(function (step) {
    var row = operationUnique_(step.table, ACCESS_OPERATION_TABLES_[step.table], step.recordKey);
    return row && operationHash_(row) === step.afterHash;
  });
}
function upsertUserAccess_(actorUser, input) {
  actorUser = refreshUser_(actorUser); requirePermission_(actorUser, 'admin.manage');
  var payload = operationPlain_(input || {}), email = normalizeEmail_(payload.email);
  if (!internalEmail_(email)) { throw new Error('E_VALIDATION: use an email in the configured Workspace domain.'); }
  payload.email = email;
  var prefix = accessTargetPrefix_(email), hash = operationHash_(payload), receipts = readTable_('Operations').filter(function (receipt) {
    return receipt.action === 'access.save' && String(receipt.submissionKey).indexOf(prefix) === 0;
  });
  var pending = receipts.filter(function (receipt) { return ['COMMITTED', 'CANCELLED'].indexOf(receipt.status) === -1; });
  if (pending.length > 1) { throw new Error('E_RECOVERY: ambiguous pending access changes require review.'); }
  var prior = pending[0];
  if (prior && (prior.actor !== actorUser.email || prior.commandHash !== hash)) { throw new Error('E_RECOVERY: finish the previous access change before replacing it.'); }
  if (!prior) { prior = receipts.filter(function (receipt) { return receipt.status === 'COMMITTED' && receipt.actor === actorUser.email && receipt.commandHash === hash && accessReceiptStillCurrent_(receipt); })[0]; }
  var existing = readTable_('Users').filter(function (row) { return normalizeEmail_(row.email) === email; })[0] || null;
  var revision = existing ? { user: existing, scopes: accessScopesForUser_(existing.userId, true) } : null;
  var cancelled = receipts.filter(function (receipt) { return receipt.status === 'CANCELLED' && receipt.actor === actorUser.email; }).map(function (receipt) { return receipt.operationId; }).sort();
  var command = { actor: actorUser.email, action: 'access.save', submissionKey: prior ? prior.submissionKey : prefix + operationHash_([payload, revision, cancelled]), payload: payload };
  var result = operationRunLocked_(command, function (id, at) { return accessBuildChange_(command.actor, payload, id, at); }, {
    tableKeys: ACCESS_OPERATION_TABLES_, authorize: function () { actorUser = refreshUser_(actorUser); requirePermission_(actorUser, 'admin.manage'); }
  });
  var record = readTable_('Users').filter(function (row) { return normalizeEmail_(row.email) === email; })[0];
  return { item: Object.assign({}, cleanRow_(record), { role: record.roleKey, scopes: accessScopesForUser_(record.userId, true).map(cleanRow_) }), operationId: result.operationId, duplicate: result.duplicate };
}

/** Editor-only recovery, including an accepted self-demotion whose actor is fenced.
 * A PREPARING receipt needs the original full input; a partial plan is never guessed.
 */
function recoverAccessOperation_(operationId, originalInput) {
  function authorize(receipt) {
    var props = PropertiesService.getScriptProperties(), installer = normalizeEmail_(props.getProperty('DEPLOYMENT_ACCOUNT_EMAIL'));
    if (props.getProperty('INSTALLATION_STATE') !== 'ready' || !internalEmail_(installer) || currentEmail_() !== installer ||
        normalizeEmail_(Session.getEffectiveUser().getEmail()) !== installer) { throw new Error('E_FORBIDDEN: only the configured deployment account may recover access.'); }
    if (!receipt || receipt.action !== 'access.save') { throw new Error('E_FORBIDDEN: this helper recovers access operations only.'); }
  }
  var receipt = operationUnique_('Operations', 'operationId', String(operationId));
  authorize(receipt);
  if (receipt.status !== 'PREPARING') { return operationRecover_(operationId, { tableKeys: ACCESS_OPERATION_TABLES_, authorize: authorize }); }
  if (!originalInput) { throw new Error('E_RECOVERY: retry preparation with the original complete access command.'); }
  var payload = operationPlain_(originalInput); payload.email = normalizeEmail_(payload.email);
  if (operationHash_(payload) !== receipt.commandHash || String(receipt.submissionKey).indexOf(accessTargetPrefix_(payload.email)) !== 0) { throw new Error('E_CONFLICT: original access command does not match the receipt.'); }
  return operationRun_({ actor: receipt.actor, action: receipt.action, submissionKey: receipt.submissionKey, payload: payload },
    function (id, at) { return accessBuildChange_(receipt.actor, payload, id, at); },
    { tableKeys: ACCESS_OPERATION_TABLES_, authorize: function () { authorize(receipt); } });
}

function accessBuildChange_(actorEmail, input, operationId, at) {
  input = input || {};
  var email = normalizeEmail_(input.email);
  if (!internalEmail_(email)) { throw new Error('E_VALIDATION: use an email in the configured Workspace domain.'); }
  var roleKey = String(input.roleKey || input.role || '').toLowerCase();
  if (!accessRole_(roleKey)) { throw new Error('E_VALIDATION: choose an active role.'); }
  if (input.active !== undefined && typeof input.active !== 'boolean') { throw new Error('E_VALIDATION: active must be true or false.'); }
  var existing = readTable_('Users').filter(function (row) { return normalizeEmail_(row.email) === email; })[0];
  var userId = existing ? existing.userId : accessStableId_(operationId, 'user:' + email, 'user'), oldScopes = existing ? accessScopesForUser_(userId, true) : [];
  var record = { userId: userId, email: email, name: validateText_(input.name || email, 'name', 200, true), roleKey: roleKey, active: input.active === undefined ? (existing ? accessActive_(existing.active) : true) : input.active, updatedAt: at, updatedBy: actorEmail };
  var requested = input.scopes;
  if (requested !== undefined && !Array.isArray(requested)) { throw new Error('E_VALIDATION: scopes must be a list.'); }
  if (requested === undefined && !existing) {
    var unit = input.site ? findAccessUnitByName_('site', input.site) : input.region ? findAccessUnitByName_('region', input.region) : null;
    if (unit) { requested = [{ scopeId: unit.unitId, primary: true, status: 'active' }]; }
    else { throw new Error('E_VALIDATION: explicitly choose an access area.'); }
  }
  var scopes = oldScopes.map(cleanRow_), seen = {};
  (requested || []).forEach(function (item) {
    var valid = validateUserScope_(actorEmail, record, item, oldScopes, operationId, at);
    if (seen[valid.userScopeId] || scopes.some(function (other) { return other.scopeId === valid.scopeId && other.userScopeId !== valid.userScopeId; })) { throw new Error('E_VALIDATION: duplicate scope assignment.'); }
    seen[valid.userScopeId] = true;
    scopes = scopes.filter(function (other) { return other.userScopeId !== valid.userScopeId; });
    scopes.push(valid);
  });
  var requestedPrimaries = scopes.filter(function (scope) { return seen[scope.userScopeId] && scope.primary && scope.status === 'active'; });
  if (requestedPrimaries.length > 1) { throw new Error('E_VALIDATION: choose only 1 primary access area.'); }
  if (requestedPrimaries.length) { scopes.forEach(function (scope) { if (scope.userScopeId !== requestedPrimaries[0].userScopeId && scope.primary) { scope.primary = false; if (scope.assignmentType === 'Primary') { scope.assignmentType = 'Additional'; } } }); }
  var index = accessUnitIndex_(), ceiling = accessScopeCeilingForRole_(roleKey);
  scopes.forEach(function (scope) { accessDate_(scope.startsOn); accessDate_(scope.endsOn); if (scopeAssignmentActive_(scope) && (!index[scope.scopeId] || !scopeCeilingAllows_(ceiling, index[scope.scopeId].unitType))) { throw new Error('E_VALIDATION: deactivate incompatible scopes explicitly before changing this role.'); } });
  if (record.active && !scopes.some(function (scope) { return scopeAssignmentActive_(scope); })) { throw new Error('E_VALIDATION: an active person needs a currently usable scope.'); }
  if (record.active && accessPermissionsForRole_(roleKey).indexOf('admin.manage') !== -1 && !accessRootAdmin_(record, scopes, operationId)) { throw new Error('E_VALIDATION: administrative roles require a currently usable organization root scope.'); }
  var admins = readTable_('Users').filter(function (row) { return row.userId !== userId && accessDurableRootAdmin_(row, accessScopesForUser_(row.userId, true)); });
  if (!admins.length && !accessDurableRootAdmin_(record, scopes, operationId)) { throw new Error('E_VALIDATION: at least 1 nonexpiring organization administrator is required.'); }
  var steps = [operationStep_('Users', 'userId', existing || null, record)];
  scopes.forEach(function (scope) { var before = oldScopes.filter(function (old) { return old.userScopeId === scope.userScopeId; })[0] || null; steps.push(operationStep_('UserScopes', 'userScopeId', before, scope)); });
  steps.push(operationAuditStep_(operationId, at, 'access', userId, existing ? 'update' : 'create', existing ? { user: existing, scopes: oldScopes } : null, { user: record, scopes: scopes }, actorEmail));
  return steps;
}
function saveUserScopeAdmin_(actorUser, input) {
  return withLock_(function () {
    actorUser = refreshUser_(actorUser); requirePermission_(actorUser, 'admin.manage');
    input = input || {};
    var target = findRow_('Users', 'userId', String(input.userId || ''));
    if (!target) { throw new Error('E_NOT_FOUND: user not found.'); }
    var result = upsertUserAccess_(actorUser, { email: target.email, name: target.name, roleKey: target.roleKey, active: accessActive_(target.active), scopes: [input] });
    return { item: result.item.scopes.filter(function (scope) { return scope.scopeId === input.scopeId; })[0] };
  });
}

function accessDurableRootAdmin_(user,scopes,ignoredOperationId) {
  return accessRootAdmin_(user,scopes.filter(function (scope) { return !String(scope.endsOn || '') && ['Temporary Coverage','Emergency Coverage'].indexOf(String(scope.assignmentType)) === -1; }),ignoredOperationId);
}
