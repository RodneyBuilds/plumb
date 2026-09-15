/** Logical data package, not a Google file/permission backup.
 * policy = {schemaVersion, tables:{name:{key,headers}}, configKeys:[], references:
 * [{table,column,target,targetKey,optional:true|false}]}. Policy is server-owned.
 * Export caller holds the script lock. Restore is an isolated, empty-target adapter;
 * it writes no current app tables, never activates, and never enables notifications.
 */
var BACKUP_FORMAT_VERSION_ = 1;
function backupBuild_(policy, config) {
  var tables = {};
  Object.keys(policy.tables).sort().forEach(function(name) { tables[name] = readTable_(name).map(operationPlain_); });
  if (typeof policy.prepareTables === 'function') { tables = policy.prepareTables(tables); }
  var safe = {};
  (policy.configKeys || []).forEach(function(key) { if (Object.prototype.hasOwnProperty.call(config,key)) { safe[key] = config[key]; } });
  var body = {formatVersion:BACKUP_FORMAT_VERSION_,schemaVersion:policy.schemaVersion,createdAt:nowIso_(),tables:tables,config:safe};
  var package_ = {body:body,hash:operationHash_(body)}; backupValidate_(package_,policy); return package_;
}
function backupValidate_(package_, policy) {
  if (!package_ || !package_.body || operationHash_(package_.body) !== package_.hash) { throw new Error('E_VALIDATION: backup integrity mismatch.'); }
  var body = package_.body;
  if (body.formatVersion !== BACKUP_FORMAT_VERSION_ || body.schemaVersion !== policy.schemaVersion) { throw new Error('E_VALIDATION: unsupported backup version.'); }
  var names = Object.keys(policy.tables).sort();
  if (operationCanonical_(Object.keys(body.tables).sort()) !== operationCanonical_(names)) { throw new Error('E_VALIDATION: backup table inventory mismatch.'); }
  if (Object.keys(body.config).some(function(k) { return (policy.configKeys || []).indexOf(k) < 0; })) { throw new Error('E_VALIDATION: backup contains unsupported configuration.'); }
  var indices = Object.create(null), counts = {};
  names.forEach(function(name) {
    var schema = policy.tables[name], index = Object.create(null), rows = body.tables[name];
    if (!Array.isArray(rows)) { throw new Error('E_VALIDATION: invalid backup table.'); }
    rows.forEach(function(row) {
      if (operationCanonical_(Object.keys(row).sort()) !== operationCanonical_(schema.headers.slice().sort())) { throw new Error('E_VALIDATION: backup row schema mismatch.'); }
      var id = row[schema.key];
      if (typeof id !== 'string' || !id || index[id]) { throw new Error('E_VALIDATION: duplicate or missing backup key.'); }
      index[id] = row;
    });
    indices[name] = index; counts[name] = rows.length;
  });
  (policy.references || []).forEach(function(ref) {
    if (!indices[ref.table] || !indices[ref.target] || policy.tables[ref.target].key !== ref.targetKey) { throw new Error('E_CONFIG: invalid backup reference policy.'); }
    body.tables[ref.table].forEach(function(row) {
      var value = row[ref.column];
      if (ref.optional && (value === '' || value === null)) { return; }
      if (!indices[ref.target][value]) { throw new Error('E_VALIDATION: dangling backup reference.'); }
    });
  });
  return {valid:true,counts:counts,hash:package_.hash};
}
function backupRestoreIsolated_(package_,policy,target) {
  backupValidate_(package_,policy);
  if (!target || target.isIsolated !== true || typeof target.isEmpty !== 'function' || !target.isEmpty() || typeof target.writeTable !== 'function' || typeof target.readTable !== 'function' || typeof target.configure !== 'function') { throw new Error('E_VALIDATION: an isolated empty restore target is required.'); }
  // No restore into an existing partially restored target. Discard that isolated
  // candidate and begin a fresh candidate if any adapter write or verification fails.
  target.configure({ENVIRONMENT:'TEST',REMINDERS_ENABLED:'false',PLAYBOOK_ALERTS_ENABLED:'false',RESTORE_STATE:'INCOMPLETE'});
  var body = JSON.parse(operationCanonical_(package_.body)), counts = {};
  Object.keys(body.tables).sort().forEach(function(name) {
    var rows = body.tables[name];
    if (name === 'NotificationOutbox') { rows.forEach(function(row) { if (row.state === 'SENDING') { row.state = 'UNKNOWN'; row.failureCode = 'RESTORED_UNCERTAIN'; } }); }
    target.writeTable(name,policy.tables[name].headers.slice(),rows);
    if (operationHash_(target.readTable(name)) !== operationHash_(rows)) { throw new Error('E_RECOVERY: restored data verification failed.'); }
    counts[name] = rows.length;
  });
  // Config is returned for administrator reconciliation, never silently applied.
  target.configure({ENVIRONMENT:'TEST',REMINDERS_ENABLED:'false',PLAYBOOK_ALERTS_ENABLED:'false',RESTORE_STATE:'AWAITING_ADMIN_REVIEW'});
  return {restored:true,activated:false,counts:counts,sourceHash:package_.hash,configurationForReview:body.config};
}
