/** Durable notification state only. Callers supply current-recipient authorization
 * and message preparation. No automatic mail calls or triggers live in this module.
 * dispatch.send must return normally only on service acceptance. Any throw from it
 * is uncertain, never automatically retried. Optional preflight handles quota
 * before final locked authorization. Claims and settlement use separate locks.
 */
var OUTBOX_HEADERS_ = ['jobId','dedupeKey','payloadHash','payloadJson','state','attempts','nextAttemptAt','claimToken','claimedAt','acceptedAt','updatedAt','failureCode'];
var OUTBOX_MAX_ATTEMPTS_ = 3;
function outboxEnqueue_(key, payload) {
  return withLock_(function() {
    if (typeof key !== 'string' || !key || key.length > 500) { throw new Error('E_VALIDATION: notification key required.'); }
    var id = 'mail_' + operationHash_(key), existing = operationUnique_('NotificationOutbox','jobId',id), hash = operationHash_(payload), json = operationCanonical_(payload);
    if (json.length > 40000) { throw new Error('E_VALIDATION: notification payload too large.'); }
    if (existing) {
      if (existing.dedupeKey !== key || existing.payloadHash !== hash) { throw new Error('E_CONFLICT: notification key already has different content.'); }
      return operationPlain_(existing);
    }
    var row = {jobId:id,dedupeKey:key,payloadHash:hash,payloadJson:json,state:'PENDING',attempts:0,nextAttemptAt:'',claimToken:'',claimedAt:'',acceptedAt:'',updatedAt:nowIso_(),failureCode:''};
    operationPut_('NotificationOutbox','jobId',row); return row;
  });
}
function outboxClaim_(now, eligible) {
  return withLock_(function() {
    var timestamp = new Date(now).getTime();
    if (!isFinite(timestamp)) { throw new Error('E_VALIDATION: valid worker time required.'); }
    var rows = readTable_('NotificationOutbox'), seen = Object.create(null);
    rows.forEach(function(row) {
      if (seen[row.jobId]) { throw new Error('E_RECOVERY: duplicate notification jobs.'); } seen[row.jobId] = true;
      // An expired claim might already have delivered. It must never become retryable.
      if (row.state === 'SENDING' && timestamp - new Date(row.claimedAt).getTime() >= 15*60*1000) {
        row = operationPlain_(row); row.state = 'UNKNOWN'; row.failureCode = 'EXPIRED_CLAIM'; row.updatedAt = now; operationPut_('NotificationOutbox','jobId',row);
      }
    });
    var row = rows.filter(function(r) { return (r.state === 'PENDING' || r.state === 'RETRYABLE') && (!r.nextAttemptAt || new Date(r.nextAttemptAt).getTime() <= timestamp) && (!eligible || eligible(r)); })[0];
    if (!row) { return null; }
    row = operationPlain_(row);
    if (operationHash_(JSON.parse(row.payloadJson)) !== row.payloadHash) { throw new Error('E_RECOVERY: notification payload integrity failure.'); }
    if (Number(row.attempts) >= OUTBOX_MAX_ATTEMPTS_) { row.state = 'FAILED'; row.failureCode = 'ATTEMPT_LIMIT'; row.updatedAt = now; operationPut_('NotificationOutbox','jobId',row); return null; }
    row.attempts = Number(row.attempts)+1; row.state = 'SENDING'; row.claimToken = operationChildId_(row.jobId,String(row.attempts)); row.claimedAt = now; row.updatedAt = now; row.failureCode = '';
    operationPut_('NotificationOutbox','jobId',row); return row;
  });
}
function outboxFinish_(claim, outcome, now) {
  return withLock_(function() {
    if (['SENT','RETRYABLE','UNKNOWN','FAILED','CANCELLED'].indexOf(outcome) < 0) { throw new Error('E_VALIDATION: invalid delivery outcome.'); }
    var row = operationUnique_('NotificationOutbox','jobId',claim.jobId);
    if (!row || row.claimToken !== claim.claimToken) { throw new Error('E_CONFLICT: delivery claim changed.'); }
    if (row.state === outcome) { return operationPlain_(row); }
    if (row.state !== 'SENDING') { throw new Error('E_CONFLICT: delivery attempt is already settled.'); }
    row = operationPlain_(row); row.state = outcome; row.updatedAt = now;
    if (outcome === 'SENT') { row.acceptedAt = now; }
    if (outcome === 'RETRYABLE') {
      row.state = Number(row.attempts) >= OUTBOX_MAX_ATTEMPTS_ ? 'FAILED' : 'RETRYABLE';
      row.nextAttemptAt = new Date(new Date(now).getTime() + (Number(row.attempts) === 1 ? 15 : 60)*60*1000).toISOString();
      row.failureCode = 'BEFORE_SEND_FAILURE';
    }
    if (outcome === 'UNKNOWN') { row.failureCode = 'DELIVERY_UNCERTAIN'; }
    operationPut_('NotificationOutbox','jobId',row); return row;
  });
}
function outboxDispatchOne_(dispatch, now) {
  if (!dispatch || typeof dispatch.prepare !== 'function' || typeof dispatch.send !== 'function') { throw new Error('E_CONFIG: notification adapters required.'); }
  var claim = outboxClaim_(now,dispatch.eligible); if (!claim) { return {sent:false,reason:'no eligible job'}; }
  try { if (dispatch.preflight) { dispatch.preflight(); } }
  catch (preflightError) { return outboxFinish_(claim,'RETRYABLE',now); }
  // Authorization and the external send intentionally share the app mutation
  // lock. App revocations cannot interleave after the final access check. Direct
  // datastore-owner edits are outside that lock and remain an ownership trust limit.
  var outcome = withLock_(function() {
    var current = operationUnique_('NotificationOutbox','jobId',claim.jobId);
    if (!current || current.state !== 'SENDING' || current.claimToken !== claim.claimToken) { throw new Error('E_CONFLICT: delivery claim changed before send.'); }
    var message;
    try { message = dispatch.prepare(JSON.parse(claim.payloadJson)); }
    catch (preparationError) { return 'RETRYABLE'; }
    // prepare MUST use fresh state and return null when disabled, obsolete,
    // or the current recipient/requester no longer has the required access.
    if (!message) { return 'CANCELLED'; }
    try { dispatch.send(message); }
    catch (sendError) { return 'UNKNOWN'; }
    return 'SENT';
  });
  // Final acknowledgment gets its own lock; it is never caught as a mail error.
  return outboxFinish_(claim,outcome,now);
}
