/**
 * Auth.gs - identity and role resolution. Runs server-side only.
 * Identity comes from the signed-in Google user, never from the client.
 */

/** The real signed-in email, lowercased. Empty if unavailable. */
function currentEmail_() {
  var email = Session.getActiveUser().getEmail();
  return normalizeEmail_(email);
}

/** Produce a readable, editable default without requesting Directory access. */
function displayNameFromEmail_(email) {
  var local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!local) { return ''; }
  return local.split(' ').map(function (part) {
    return part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : '';
  }).join(' ');
}

/**
 * Resolve the caller from Users, Roles, Permissions, and UserScopes.
 * Fails closed: blank or unknown or inactive identity gets no scope and a
 * flag the UI turns into an "ask your admin" message.
 */
function resolveUser_() {
  var email = currentEmail_();
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('INSTALLATION_STATE') !== 'ready') { email = ''; }
  if (!email) {
    return { email: '', name: 'Guest', role: 'viewer', roleKey: 'viewer', region: '', site: '', permissions: [], scopes: [], scopeSites: [], known: false };
  }
  if (accessModelReady_()) { var resolved = resolveAccessUser_(email); if (resolved) { return resolved; } }
  return { email: email, name: displayNameFromEmail_(email) || email, role: 'viewer', roleKey: 'viewer', region: '', site: '', permissions: [], scopes: [], scopeSites: [], known: false };
}

function normalizeEmail_(email) { return String(email || '').trim().toLowerCase(); }
function internalEmail_(email) {
  var normalized = normalizeEmail_(email), domain = String(PropertiesService.getScriptProperties().getProperty('WORKSPACE_DOMAIN') || '').trim().toLowerCase();
  return !!domain && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.split('@')[1] === domain;
}
function refreshUser_(user) {
  var fresh = resolveAccessUser_(user && user.email);
  requireKnown_(fresh);
  return fresh;
}
