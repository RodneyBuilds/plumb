/**
 * Rbac.gs - server-side access enforcement. Uses the pure allow-matrix and
 * scoping in Logic.gs, plus the Sites lookup for region membership.
 */

var _regionCache = null;

/** Region for a site, from the Sites sheet (cached per execution). */
function regionOfSite_(site) {
  var row = readTable_('Sites').filter(function (item) { return item.site === site && accessActive_(item.active); })[0];
  return row ? row.region : undefined;
}

function regionOfFn_() {
  return function (site) { return regionOfSite_(site); };
}

/** Throw E_FORBIDDEN unless the user's role is in allowedRoles. */
function requireRole_(user, allowedRoles) {
  if (allowedRoles.indexOf(user.role) === -1) {
    throw new Error('E_FORBIDDEN: your role (' + user.role + ') is not allowed here.');
  }
}

/** True when the resolved role has an active permission mapping. */
function hasPermission_(user, permissionKey) {
  if (!user || !user.known) { return false; }
  return Array.isArray(user.permissions) && user.permissions.indexOf(permissionKey) !== -1;
}

function requirePermission_(user, permissionKey) {
  if (!hasPermission_(user, permissionKey)) {
    throw new Error('E_FORBIDDEN: your role does not include ' + permissionKey + '.');
  }
}

/** Throw unless the user may write. */
function requireWrite_(user, permissionKey) {
  if (permissionKey) { return requirePermission_(user, permissionKey); }
  if (!roleCanWrite_(user.role)) {
    throw new Error('E_FORBIDDEN: your role is read-only.');
  }
}

/** Throw unless the user may act on a row within their scope. */
function requireRowScope_(user, row, permissionKey) {
  if (permissionKey) { requirePermission_(user, permissionKey); }
  else { requireWrite_(user); }
  if (!rowInScope_(user.role, user, row, regionOfFn_())) {
    throw new Error('E_FORBIDDEN: that site is outside your scope.');
  }
}

/** The sites a user is allowed to score or view, in scope order. */
function sitesInScope_(user) {
  var pending = operationPendingKeys_('Sites');
  var all = readTable_('Sites').filter(function (s) {
    if (pending[String(s.site)]) { return false; }
    return String(s.active).toUpperCase() !== 'FALSE' && s.active !== false;
  });
  if (!user || !user.known || !Array.isArray(user.scopeSites)) { return []; }
  var active = {};
  all.forEach(function (site) { active[String(site.site)] = true; });
  var sites = user.scopeSites.filter(function (site) { return active[String(site)]; });
  return sites.sort(function (a, b) { return String(a).localeCompare(String(b)); });
}
