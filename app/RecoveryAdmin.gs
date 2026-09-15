/** Private editor-only recovery tools. No browser routes, activation, trigger
 * creation, sharing changes, credential exports, or overwrites of existing data.
 * Google APIs checked against official references on 2026-09-11:
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list
 * https://developers.google.com/apps-script/reference/drive/folder
 * https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet
 */
var RECOVERY_MAX_BYTES_ = 10 * 1024 * 1024;
var RECOVERY_PACKAGE_RELEASE_ = '0.1.0';
var RECOVERY_TEMPLATE_VERSION_ = '1';
var RECOVERY_CONFIG_KEYS_ = ['WORKSPACE_DOMAIN','CUSTOMER_NAME','CUSTOMER_SHORT_NAME','CUSTOMER_DESCRIPTOR','CUSTOMER_MARK','CUSTOMER_ACCENT','PLAYBOOK_DOC_ID'];
function recoveryRequireInstaller_() {
  var props=PropertiesService.getScriptProperties(), installer=normalizeEmail_(props.getProperty('DEPLOYMENT_ACCOUNT_EMAIL'));
  if (!installer || !internalEmail_(installer) || currentEmail_() !== installer || normalizeEmail_(Session.getEffectiveUser().getEmail()) !== installer) { throw new Error('E_FORBIDDEN: the configured deployment account must run recovery directly.'); }
  return installer;
}
function recoveryPrivateOwner_(fileId,installer) {
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(String(fileId))) { throw new Error('E_VALIDATION: valid Drive resource ID required.'); }
  var response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(fileId)+'/permissions?fields=nextPageToken,permissions(type,role,emailAddress)&supportsAllDrives=true&includePermissionsForView=published&pageSize=100',{
    method:'get',muteHttpExceptions:true,headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()}
  });
  if (Number(response.getResponseCode()) !== 200) { throw new Error('E_FORBIDDEN: recovery resource permissions could not be verified.'); }
  var data=JSON.parse(response.getContentText()), permissions=data.permissions;
  if (data.nextPageToken || !Array.isArray(permissions) || permissions.length !== 1 || permissions[0].type !== 'user' || permissions[0].role !== 'owner' || normalizeEmail_(permissions[0].emailAddress) !== installer) {
    throw new Error('E_FORBIDDEN: recovery requires an unshared resource owned by the deployment account.');
  }
}
function recoveryPolicy_() {
  var tables={};
  SHEETS.forEach(function(spec) { tables[spec.name]={key:spec.headers[0],headers:spec.headers.slice()}; });
  var refs=[
    ['OrganizationUnits','parentUnitId','OrganizationUnits','unitId',true],['Users','roleKey','Roles','roleKey'],
    ['RolePermissions','roleKey','Roles','roleKey'],['RolePermissions','permissionKey','Permissions','permissionKey'],
    ['UserScopes','userId','Users','userId'],['UserScopes','scopeId','OrganizationUnits','unitId'],
    ['Intake','site','Sites','site'],['IntakeHistory','intakeId','Intake','id'],['Goals','metricId','Metrics','metricId'],['Goals','site','Sites','site'],
    ['Goals','departmentUnitId','OrganizationUnits','unitId',true],['Actuals','goalId','Goals','goalId'],['Actuals','supersedesActualId','Actuals','actualId',true],
    ['Actions','goalId','Goals','goalId'],['Actions','metricId','Metrics','metricId'],['Actions','site','Sites','site'],
    ['OperationSteps','operationId','Operations','operationId'],['GuidanceSnapshots','generationId','PlaybookSnapshots','generationId'],['PlaybookPointers','generationId','PlaybookSnapshots','generationId']
  ].filter(function(ref) { return !!tables[ref[0]] && !!tables[ref[2]]; }).map(function(ref) { return {table:ref[0],column:ref[1],target:ref[2],targetKey:ref[3],optional:!!ref[4]}; });
  return {schemaVersion:String(PropertiesService.getScriptProperties().getProperty('SCHEMA_VERSION') || ''),tables:tables,configKeys:RECOVERY_CONFIG_KEYS_.slice(),references:refs,prepareTables:recoveryCompleteSnapshots_};
}
/** Incomplete unpublished generations are staging, not served recovery data. */
function recoveryCompleteSnapshots_(tables) {
  if (!tables.PlaybookSnapshots || !tables.GuidanceSnapshots || !tables.PlaybookPointers) { return tables; }
  var complete=Object.create(null), manifests=Object.create(null), blocksByGeneration=Object.create(null);
  tables.GuidanceSnapshots.forEach(function(row) { (blocksByGeneration[row.generationId] || (blocksByGeneration[row.generationId]=[])).push(row); });
  tables.PlaybookSnapshots.forEach(function(manifest) {
    if (manifests[manifest.generationId]) { throw new Error('E_RECOVERY: duplicate guidance generation in backup.'); }
    manifests[manifest.generationId]=true;
    try {
      var seen=Object.create(null), rows=blocksByGeneration[manifest.generationId] || [], health=JSON.parse(manifest.healthJson);
      var blocks=rows.map(function(row) {
        var block=JSON.parse(row.contentJson);
        if (seen[row.blockId] || row.docId !== manifest.docId || block.blockId !== row.blockId || block.sourceDocId !== manifest.docId || row.snapshotRowId !== operationChildId_(manifest.generationId,row.blockId)) { throw new Error('invalid staging'); }
        seen[row.blockId]=true;return block;
      }).sort(function(a,b) { return String(a.blockId).localeCompare(String(b.blockId)); });
      if (health.docId === manifest.docId && blocks.length === Number(manifest.blockCount) && operationHash_({blocks:blocks,health:health}) === manifest.contentHash) { complete[manifest.generationId]=true; }
    } catch(incompleteStaging) {}
  });
  tables.PlaybookPointers.forEach(function(pointer) { if (!complete[pointer.generationId]) { throw new Error('E_RECOVERY: active guidance snapshot is incomplete; backup needs review.'); } });
  tables.PlaybookSnapshots=tables.PlaybookSnapshots.filter(function(row) { return complete[row.generationId]; });
  tables.GuidanceSnapshots=tables.GuidanceSnapshots.filter(function(row) { return complete[row.generationId]; });
  return tables;
}
function recoveryExportConfigured_() { return recoveryExport_(PropertiesService.getScriptProperties().getProperty('BACKUP_FOLDER_ID')); }
function recoveryExport_(folderId) {
  var installer=recoveryRequireInstaller_(); recoveryPrivateOwner_(folderId,installer);
  var package_=withLock_(function() {
    var props=PropertiesService.getScriptProperties(),config={};
    RECOVERY_CONFIG_KEYS_.forEach(function(key) { var value=props.getProperty(key); if (value !== null && value !== undefined) { config[key]=value; } });
    var result=backupBuild_(recoveryPolicy_(),config);
    result.body.sourceSpreadsheetId=ss_().getId();
    result.body.releaseVersion=RECOVERY_PACKAGE_RELEASE_;result.body.templateVersion=RECOVERY_TEMPLATE_VERSION_;
    result.body.codeArtifactIncluded=false;result.body.snapshotStagingExcluded=true;
    result.hash=operationHash_(result.body); return result;
  });
  var blob=Utilities.newBlob(operationCanonical_(package_),'application/json','plumb-backup-'+package_.body.createdAt.replace(/[:.]/g,'-')+'.json');
  if (blob.getBytes().length > RECOVERY_MAX_BYTES_) { throw new Error('E_VALIDATION: backup exceeds the supported 10 MB package limit.'); }
  // Recheck immediately before creation. No permissions are changed by this tool.
  recoveryPrivateOwner_(folderId,installer);
  var file=DriveApp.getFolderById(folderId).createFile(blob);
  recoveryPrivateOwner_(file.getId(),installer);
  var stored=JSON.parse(file.getBlob().getDataAsString('UTF-8')); backupValidate_(stored,recoveryPolicy_());
  if (stored.hash !== package_.hash) { throw new Error('E_RECOVERY: exported backup verification failed.'); }
  var props=PropertiesService.getScriptProperties();props.setProperty('LAST_BACKUP_FILE_ID',file.getId());props.setProperty('LAST_BACKUP_HASH',stored.hash);
  return {exported:true,fileId:file.getId(),url:file.getUrl(),hash:stored.hash,bytes:blob.getBytes().length,logicalOnly:true};
}
function recoveryRestoreConfigured_() {
  var props=PropertiesService.getScriptProperties();
  return recoveryRestore_(props.getProperty('BACKUP_FILE_ID'),props.getProperty('RESTORE_SPREADSHEET_ID'));
}
function recoveryRestore_(backupFileId,targetId) {
  var installer=recoveryRequireInstaller_(); recoveryPrivateOwner_(backupFileId,installer); recoveryPrivateOwner_(targetId,installer);
  if (String(targetId) === String(ss_().getId())) { throw new Error('E_FORBIDDEN: the current datastore cannot be a restore target.'); }
  var file=DriveApp.getFileById(backupFileId);
  if (Number(file.getSize()) > RECOVERY_MAX_BYTES_) { throw new Error('E_VALIDATION: backup exceeds the supported 10 MB package limit.'); }
  var package_=JSON.parse(file.getBlob().getDataAsString('UTF-8')),policy=recoveryPolicy_();backupValidate_(package_,policy);
  if (package_.body.releaseVersion !== RECOVERY_PACKAGE_RELEASE_ || package_.body.templateVersion !== RECOVERY_TEMPLATE_VERSION_) { throw new Error('E_VALIDATION: this release cannot restore that code/template package without a reviewed migration.'); }
  if (String(package_.body.sourceSpreadsheetId) === String(targetId)) { throw new Error('E_FORBIDDEN: the source workbook cannot be overwritten.'); }
  var target=SpreadsheetApp.openById(targetId);
  if (!/^PLUMB RESTORE TEST(?:\b|$)/.test(target.getName())) { throw new Error('E_VALIDATION: name the empty destination PLUMB RESTORE TEST before restoring.'); }
  // Serialize this source's restore commands. This cannot lock manual edits or
  // another Apps Script project: the verified owner-only blank target is required.
  return withLock_(function() {
    recoveryPrivateOwner_(targetId,installer);
    var adapter={isIsolated:true,
      isEmpty:function() { return target.getSheets().every(function(sheet) { return sheet.getLastRow() === 0; }); },
      configure:function(config) {
        var sheet=target.getSheetByName('_RestoreControl') || target.insertSheet('_RestoreControl');
        var rows=[['setting','value']];Object.keys(config).sort().forEach(function(key) { rows.push([key,String(config[key])]); });
        rows.push(['SOURCE_BACKUP_HASH',package_.hash],['SOURCE_SCHEMA_VERSION',String(package_.body.schemaVersion)],['SOURCE_RELEASE_VERSION',String(package_.body.releaseVersion || 'unrecorded')],['SOURCE_TEMPLATE_VERSION',String(package_.body.templateVersion || 'unrecorded')]);
        Object.keys(package_.body.config).sort().forEach(function(key) { rows.push(['REVIEW_ONLY_'+key,String(package_.body.config[key])]); });
        recoveryWriteGrid_(sheet,rows);
      },
      writeTable:function(name,headers,rows) {
        var sheet=target.getSheetByName(name);
        if (sheet && sheet.getLastRow() > 0) { throw new Error('E_RECOVERY: restore destination changed or is incomplete.'); }
        sheet=sheet || target.insertSheet(name);
        recoveryWriteGrid_(sheet,[headers].concat(rows.map(function(row) { return headers.map(function(header) { return sheetValue_(row[header]); }); })));
      },
      readTable:function(name) {
        var values=target.getSheetByName(name).getDataRange().getValues(),headers=values.shift();
        return values.filter(function(row) { return row.join('') !== ''; }).map(function(row) { var out={};headers.forEach(function(header,index) { out[header]=row[index]; });return operationPlain_(out); });
      }
    };
    var result=backupRestoreIsolated_(package_,policy,adapter);
    result.spreadsheetId=targetId;result.url=target.getUrl();result.manualActivationRequired=true;return result;
  });
}
function recoveryWriteGrid_(sheet,values) {
  if (sheet.getMaxRows() < values.length) { sheet.insertRowsAfter(sheet.getMaxRows(),values.length-sheet.getMaxRows()); }
  if (sheet.getMaxColumns() < values[0].length) { sheet.insertColumnsAfter(sheet.getMaxColumns(),values[0].length-sheet.getMaxColumns()); }
  var range=sheet.getRange(1,1,values.length,values[0].length);range.setNumberFormat('@');range.setValues(values);
}
function recoveryCancelConfiguredPreparation_() {
  recoveryRequireInstaller_();
  var id=PropertiesService.getScriptProperties().getProperty('RECOVERY_OPERATION_ID');
  return operationCancelPreparation_(id,{authorize:function() { recoveryRequireInstaller_(); }});
}
function recoveryRecoverConfiguredOperation_() {
  recoveryRequireInstaller_();var keys={};SHEETS.forEach(function(spec) { keys[spec.name]=spec.headers[0]; });
  return operationRecover_(PropertiesService.getScriptProperties().getProperty('RECOVERY_OPERATION_ID'),{tableKeys:keys,authorize:function() { recoveryRequireInstaller_(); }});
}
