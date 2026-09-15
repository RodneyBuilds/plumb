/** Immutable served content. Only a verified generation becomes visible by changing
 * one pointer row last. Publication holds the script lock; parsing must occur before it.
 * No automatic deletion: retained generations keep requests and backups reproducible.
 */
var GUIDANCE_SNAPSHOT_SCHEMA_ = {
  GuidanceSnapshots:['snapshotRowId','generationId','docId','blockId','contentJson'],
  PlaybookSnapshots:['generationId','docId','parentGeneration','createdAt','healthJson','blockCount','contentHash'],
  PlaybookPointers:['docId','generationId']
};
var PLAYBOOK_SNAPSHOT_CACHE_ = Object.create(null);
function playbookSnapshotRead_(docId, fresh) {
  docId = String(docId || '');
  if (!fresh && Object.prototype.hasOwnProperty.call(PLAYBOOK_SNAPSHOT_CACHE_,docId)) { return PLAYBOOK_SNAPSHOT_CACHE_[docId]; }
  var pointer = operationUnique_('PlaybookPointers','docId',docId), snapshot = {generationId:'',blocks:[],health:null};
  if (pointer) {
    var manifest = operationUnique_('PlaybookSnapshots','generationId',pointer.generationId);
    if (!manifest || manifest.docId !== docId) { throw new Error('E_RECOVERY: guidance generation is missing.'); }
    var blocks = readTable_('GuidanceSnapshots').filter(function(row) { return row.generationId === pointer.generationId; }).map(function(row) {
      if (row.docId !== docId) { throw new Error('E_RECOVERY: guidance generation scope mismatch.'); }
      var block = JSON.parse(row.contentJson);
      if (block.blockId !== row.blockId || block.sourceDocId !== docId || row.snapshotRowId !== operationChildId_(pointer.generationId,row.blockId)) { throw new Error('E_RECOVERY: guidance block identity mismatch.'); }
      return block;
    }).sort(function(a,b) { return String(a.blockId).localeCompare(String(b.blockId)); });
    var health = JSON.parse(manifest.healthJson), seen = Object.create(null);
    blocks.forEach(function(block) { if (seen[block.blockId]) { throw new Error('E_RECOVERY: duplicate guidance block.'); } seen[block.blockId] = true; });
    if (health.docId !== docId || blocks.length !== Number(manifest.blockCount) || operationHash_({blocks:blocks,health:health}) !== manifest.contentHash) { throw new Error('E_RECOVERY: guidance snapshot integrity failure.'); }
    snapshot = {generationId:pointer.generationId,blocks:blocks,health:health};
  }
  if (!fresh) { PLAYBOOK_SNAPSHOT_CACHE_[docId] = snapshot; }
  return snapshot;
}
function playbookSnapshotPublish_(docId,baseGeneration,blocks,health) {
  docId = String(docId);
  if (!health || health.docId !== docId || !Array.isArray(blocks)) { throw new Error('E_VALIDATION: coherent guidance content required.'); }
  blocks = blocks.map(operationPlain_).sort(function(a,b) { return String(a.blockId).localeCompare(String(b.blockId)); });
  health = operationPlain_(health);
  var seen = Object.create(null);
  blocks.forEach(function(block) {
    if (!block.blockId || block.sourceDocId !== docId || seen[block.blockId] || operationCanonical_(block).length > 40000) { throw new Error('E_VALIDATION: invalid guidance snapshot block.'); }
    seen[block.blockId] = true;
  });
  if (operationCanonical_(health).length > 40000) { throw new Error('E_VALIDATION: guidance health exceeds supported size.'); }
  var digest = operationHash_({blocks:blocks,health:health}), generation = 'guide_' + operationHash_([docId,baseGeneration,digest]);
  return withLock_(function() {
    var pointer = operationUnique_('PlaybookPointers','docId',docId), active = pointer ? pointer.generationId : '';
    if (active === generation) { return {generationId:generation,written:0,duplicate:true}; }
    if (active !== baseGeneration) { throw new Error('E_CONFLICT: a newer guidance refresh was published. Recheck the manual.'); }
    function immutable(table,key,row) {
      var old = operationUnique_(table,key,row[key]);
      if (old && operationHash_(old) !== operationHash_(row)) { throw new Error('E_RECOVERY: immutable guidance content changed.'); }
      if (!old) { operationPut_(table,key,row); }
    }
    blocks.forEach(function(block) { immutable('GuidanceSnapshots','snapshotRowId',{snapshotRowId:operationChildId_(generation,block.blockId),generationId:generation,docId:docId,blockId:block.blockId,contentJson:operationCanonical_(block)}); });
    immutable('PlaybookSnapshots','generationId',{generationId:generation,docId:docId,parentGeneration:baseGeneration,createdAt:String(health.lastCheckedAt || ''),healthJson:operationCanonical_(health),blockCount:blocks.length,contentHash:digest});
    // Verify complete persisted content independently before making it visible.
    var stored = readTable_('GuidanceSnapshots').filter(function(row) { return row.generationId === generation; }).map(function(row) { return JSON.parse(row.contentJson); }).sort(function(a,b) { return String(a.blockId).localeCompare(String(b.blockId)); });
    if (stored.length !== blocks.length || operationHash_({blocks:stored,health:JSON.parse(operationUnique_('PlaybookSnapshots','generationId',generation).healthJson)}) !== digest) { throw new Error('E_RECOVERY: guidance publication verification failed.'); }
    operationPut_('PlaybookPointers','docId',{docId:docId,generationId:generation});
    return {generationId:generation,written:blocks.length,duplicate:false};
  });
}

/** Explicit one-time migration of historical tables. Never called by a reader. */
function playbookSnapshotImportLegacy_(docId) {
  var current = playbookSnapshotRead_(docId,true);
  if (current.generationId) { throw new Error('E_CONFLICT: this manual already has a served generation.'); }
  var health = operationUnique_('PlaybookHealth','docId',docId);
  if (!health) { throw new Error('E_VALIDATION: no legacy health record to migrate.'); }
  var blocks = readTable_('GuidanceBlocks').filter(function(row) { return row.sourceDocId === docId; }).map(operationPlain_);
  return playbookSnapshotPublish_(docId,'',blocks,operationPlain_(health));
}
