/** Recoverable, keyed row writes. A script lock is serialization, not a transaction.
 * Call operationRun_ outside an existing lock, or operationRunLocked_ inside it.
 * options.authorize(command) MUST recheck current permission/scope, including retries.
 * options.tableKeys is a server-owned allowlist. build(id, at) returns deterministic
 * [{table,key,before:null|completeRow,after:completeRow}]. No deletions are supported.
 * Readers/writers must fence entities with unresolved receipts using operationPending_.
 */
var OPERATION_SCHEMA_ = {
  Operations: ['operationId','actor','action','submissionKey','commandHash','planHash','stepCount','status','createdAt','updatedAt','failureCode'],
  OperationSteps: ['stepId','operationId','position','table','recordKey','keyColumn','beforeHash','afterJson','afterHash']
};
function operationCanonical_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && isFinite(value.getTime())) { return JSON.stringify(value.toISOString()); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { return JSON.stringify(value); }
  if (typeof value === 'number' && isFinite(value)) { return JSON.stringify(value); }
  if (Array.isArray(value)) { return '[' + value.map(operationCanonical_).join(',') + ']'; }
  if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
    return '{' + Object.keys(value).filter(function(k) { return k !== '_row'; }).sort().map(function(k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') { throw new Error('E_VALIDATION: unsafe object key.'); }
      return JSON.stringify(k) + ':' + operationCanonical_(value[k]);
    }).join(',') + '}';
  }
  throw new Error('E_VALIDATION: unsupported persisted value.');
}
function operationHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, operationCanonical_(value), Utilities.Charset.UTF_8)
    .map(function(n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
}
function operationChildId_(id, label) { return 'step_' + operationHash_([id, label]); }
function operationUnique_(table, key, value) {
  var matches = readTable_(table).filter(function(r) { return String(r[key]) === String(value); });
  if (matches.length > 1) { throw new Error('E_RECOVERY: duplicate stored record keys.'); }
  return matches[0] || null;
}
function operationPlain_(row) { return JSON.parse(operationCanonical_(row)); }
/** Normalize a business record to its declared columns before making a plan. */
function operationRow_(table,row) {
  var complete = {};
  headersOf_(table).forEach(function(header) {
    if (header === '_row' || header === '__proto__' || header === 'constructor' || header === 'prototype') { throw new Error('E_CONFIG: unsupported managed column.'); }
    complete[header] = row && Object.prototype.hasOwnProperty.call(row,header) && row[header] !== undefined ? row[header] : '';
  });
  return operationPlain_(complete);
}
function operationStep_(table,keyColumn,before,after) {
  var complete = operationRow_(table,after);
  return {table:table,key:String(complete[keyColumn]),before:before === null || before === undefined ? null : operationRow_(table,before),after:complete};
}
function operationAuditStep_(opId,at,entity,recordId,action,before,after,actor) {
  var id = operationChildId_(opId,'audit:'+entity+':'+recordId+':'+action);
  return operationStep_('AuditLog','id',null,{id:id,entity:entity,recordId:recordId,action:action,beforeJson:before ? operationCanonical_(before) : '',afterJson:after ? operationCanonical_(after) : '',actor:actor,at:at});
}
function operationPut_(table, key, row) {
  var old = operationUnique_(table, key, row[key]);
  if (old) { writeRowAt_(table, old._row, row); } else { appendRow_(table, row); }
  var actual = operationUnique_(table, key, row[key]);
  if (!actual || operationHash_(actual) !== operationHash_(row)) { throw new Error('E_RECOVERY: write verification failed.'); }
}
function operationPlan_(id, plan, tableKeys) {
  if (!Array.isArray(plan) || !plan.length || plan.length > 250) { throw new Error('E_VALIDATION: operation needs 1 to 250 rows.'); }
  var seen = Object.create(null);
  return plan.map(function(step, index) {
    var keyColumn = tableKeys[step.table];
    if (!Object.prototype.hasOwnProperty.call(tableKeys, step.table) || !keyColumn || OPERATION_SCHEMA_[step.table]) { throw new Error('E_VALIDATION: unsupported operation table.'); }
    var headers = headersOf_(step.table), after = operationPlain_(step.after), before = step.before === null ? null : operationPlain_(step.before);
    if (typeof step.key !== 'string' || !step.key || String(after[keyColumn]) !== step.key || (before && String(before[keyColumn]) !== step.key)) { throw new Error('E_VALIDATION: mismatched record key.'); }
    [before, after].forEach(function(row) {
      if (row && (Object.keys(row).length !== headers.length || headers.some(function(h) { return !Object.prototype.hasOwnProperty.call(row,h); }))) { throw new Error('E_VALIDATION: complete schema rows required.'); }
    });
    var token = step.table + '\n' + step.key;
    if (seen[token]) { throw new Error('E_VALIDATION: duplicate planned record.'); } seen[token] = true;
    var json = operationCanonical_(after);
    if (json.length > 40000) { throw new Error('E_VALIDATION: planned row exceeds supported size.'); }
    return { stepId: operationChildId_(id, String(index)), operationId:id, position:index, table:step.table, recordKey:step.key, keyColumn:keyColumn, beforeHash:operationHash_(before), afterJson:json, afterHash:operationHash_(after) };
  });
}
function operationPending_(table, key) {
  return !!operationPendingKeys_(table)[String(key)];
}
function operationPendingKeys_(table) {
  var pending = Object.create(null);
  readTable_('Operations').forEach(function(r) { if (['COMMITTED','CANCELLED'].indexOf(r.status) === -1) { pending[r.operationId] = true; } });
  var keys = Object.create(null);
  readTable_('OperationSteps').forEach(function(r) { if (pending[r.operationId] && r.table === table) { keys[String(r.recordKey)] = true; } });
  return keys;
}
function operationRun_(command, build, options) { return withLock_(function() { return operationRunLocked_(command, build, options); }); }
/** Administrator recovery of a complete accepted plan without the original browser.
 * authorize receives the stored receipt, not a caller-supplied actor identity.
 * PREPARING still needs the original deterministic command; never guess missing steps.
 */
function operationRecover_(operationId, options) {
  return withLock_(function() {
    if (!options || typeof options.authorize !== 'function' || !options.tableKeys) { throw new Error('E_CONFIG: recovery authorization required.'); }
    var receipt = operationUnique_('Operations','operationId',String(operationId));
    if (!receipt) { throw new Error('E_NOT_FOUND: operation not found.'); }
    options.authorize(operationPlain_(receipt));
    if (['PREPARED','COMMITTED'].indexOf(receipt.status) < 0) { throw new Error('E_RECOVERY: original command or administrator investigation required.'); }
    return operationApplyLocked_(receipt,options.tableKeys);
  });
}
/** Cancel only preparation: business writes cannot have started in this state. */
function operationCancelPreparation_(operationId, options) {
  return withLock_(function() {
    if (!options || typeof options.authorize !== 'function') { throw new Error('E_CONFIG: cancellation authorization required.'); }
    var receipt = operationUnique_('Operations','operationId',String(operationId));
    if (!receipt) { throw new Error('E_NOT_FOUND: operation not found.'); }
    options.authorize(operationPlain_(receipt));
    if (receipt.status === 'CANCELLED') { return {operationId:receipt.operationId,status:'CANCELLED'}; }
    if (receipt.status !== 'PREPARING') { throw new Error('E_RECOVERY: only an unapplied preparation can be cancelled.'); }
    receipt = operationPlain_(receipt); receipt.status = 'CANCELLED'; receipt.failureCode = 'PREPARATION_CANCELLED'; receipt.updatedAt = nowIso_();
    operationPut_('Operations','operationId',receipt); return {operationId:receipt.operationId,status:'CANCELLED'};
  });
}
function operationRunLocked_(command, build, options) {
  if (!options || typeof options.authorize !== 'function' || !options.tableKeys) { throw new Error('E_CONFIG: operation authorization and table policy required.'); }
  options.authorize(command);
  ['actor','action','submissionKey'].forEach(function(k) { if (typeof command[k] !== 'string' || !command[k] || command[k].length > 200) { throw new Error('E_VALIDATION: valid operation identity required.'); } });
  var id = 'op_' + operationHash_([command.actor,command.action,command.submissionKey]), hash = operationHash_(command.payload), receipt = operationUnique_('Operations','operationId',id);
  if (receipt && receipt.commandHash !== hash) { throw new Error('E_CONFLICT: this submission key was used for different content.'); }
  if (receipt && receipt.status === 'CANCELLED') { throw new Error('E_CONFLICT: this preparation was cancelled. Start a new submission.'); }
  if (receipt && receipt.status === 'NEEDS_REVIEW') { throw new Error('E_RECOVERY: operation requires administrator review.'); }
  if (!receipt || receipt.status === 'PREPARING') {
    var at = receipt ? receipt.createdAt : nowIso_(), steps = operationPlan_(id,build(id,at),options.tableKeys), digest = operationHash_(steps);
    if (receipt && (receipt.planHash !== digest || Number(receipt.stepCount) !== steps.length)) { throw new Error('E_RECOVERY: retry produced a different plan.'); }
    if (!receipt) {
      if (readTable_('Operations').some(function(r) { return ['COMMITTED','CANCELLED'].indexOf(r.status) === -1; })) { throw new Error('E_RECOVERY: unfinished operation needs recovery before another save.'); }
      steps.forEach(function(step) {
        if (operationPending_(step.table,step.recordKey)) { throw new Error('E_RECOVERY: a previous save needs recovery.'); }
        var row = operationUnique_(step.table,step.keyColumn,step.recordKey);
        if (operationHash_(row ? operationPlain_(row) : null) !== step.beforeHash) { throw new Error('E_CONFLICT: stored record changed before preparation.'); }
      });
      receipt = {operationId:id,actor:command.actor,action:command.action,submissionKey:command.submissionKey,commandHash:hash,planHash:digest,stepCount:steps.length,status:'PREPARING',createdAt:at,updatedAt:at,failureCode:''};
      operationPut_('Operations','operationId',receipt);
    }
    steps.forEach(function(step) {
      var old = operationUnique_('OperationSteps','stepId',step.stepId);
      if (old && operationHash_(old) !== operationHash_(step)) { throw new Error('E_RECOVERY: stored plan differs from retry.'); }
      if (!old) { operationPut_('OperationSteps','stepId',step); }
    });
    receipt = operationPlain_(receipt); receipt.status = 'PREPARED'; receipt.updatedAt = nowIso_(); operationPut_('Operations','operationId',receipt);
  }
  return operationApplyLocked_(receipt,options.tableKeys);
}
function operationApplyLocked_(receipt, tableKeys) {
  var id = receipt.operationId, steps = readTable_('OperationSteps').filter(function(r) { return r.operationId === id; }).map(operationPlain_).sort(function(a,b) { return a.position-b.position; });
  function review() {
    var next = operationPlain_(receipt); next.status = 'NEEDS_REVIEW'; next.failureCode = 'CONTENT_CONFLICT'; next.updatedAt = nowIso_();
    operationPut_('Operations','operationId',next); throw new Error('E_RECOVERY: operation content needs administrator review.');
  }
  if (steps.length !== Number(receipt.stepCount) || operationHash_(steps) !== receipt.planHash) { return review(); }
  if (receipt.status === 'COMMITTED') { return {operationId:id,status:'COMMITTED',duplicate:true}; }
  // Check every step before resuming any write. Never overwrite unexpected content.
  var pending = [];
  steps.forEach(function(step,index) {
    if (step.position !== index || step.stepId !== operationChildId_(id,String(index)) || !Object.prototype.hasOwnProperty.call(tableKeys,step.table) || tableKeys[step.table] !== step.keyColumn) { return review(); }
    var after;
    try { after = JSON.parse(step.afterJson); } catch (ignore) { return review(); }
    if (operationHash_(after) !== step.afterHash || String(after[step.keyColumn]) !== step.recordKey) { return review(); }
    var row;
    try { row = operationUnique_(step.table,step.keyColumn,step.recordKey); } catch (ignoreDuplicate) { return review(); }
    var actual = operationHash_(row ? operationPlain_(row) : null);
    if (actual !== step.afterHash) {
      if (receipt.status === 'COMMITTED' || actual !== step.beforeHash) { return review(); }
      pending.push({step:step,after:after});
    }
  });
  if (receipt.status === 'COMMITTED') { return {operationId:id,status:'COMMITTED',duplicate:true}; }
  pending.forEach(function(item) { operationPut_(item.step.table,item.step.keyColumn,item.after); });
  var next = operationPlain_(receipt); next.status = 'COMMITTED'; next.updatedAt = nowIso_(); operationPut_('Operations','operationId',next);
  return {operationId:id,status:'COMMITTED',duplicate:false};
}
