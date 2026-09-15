# Foundation TEST installation

Status: use only after local verification of the exact candidate.
This is the identity and recovery qualification package, not the finished customer product.
Customer/contact records, the improvement action lifecycle, final templates, and production handover are later stages.
No production data belongs in this installation.

## Prepare the isolated installation

Allow about 45-60 minutes for setup and the first identity checks, followed by a separate recovery session.
Use a Workspace domain and test accounts controlled by the business.
A personal Gmail account does not satisfy this candidate's domain-restricted model.
The deployment administrator needs permission to create a spreadsheet, an attached Apps Script project, a domain-restricted web app, and private Drive files.
Workspace administrator restrictions may prevent these actions; record a refusal instead of weakening the access boundary.

1. Create a new private spreadsheet named `Plumb Foundation TEST` as the intended deployment administrator.
   Do not share the spreadsheet with test staff.
2. Open **Extensions > Apps Script** and use the candidate's `editor-install` directory.
   Replace the default script contents with `Server.gs`; create the 5 HTML files named `ClientJs`, `ImproveUi`, `Index`, `PerformanceUi`, and `Styles`, copying their supplied contents.
   Show the manifest in project settings and replace `appsscript.json` with the supplied manifest.
   Use this consolidated installation or the separate `app` source files, never both.
3. In Script Properties, set `WORKSPACE_DOMAIN` to the exact test domain, `DEPLOYMENT_ACCOUNT_EMAIL` to the administrator's email, and `ENVIRONMENT` to `TEST`.
   Keep `REMINDERS_ENABLED` and `PLAYBOOK_ALERTS_ENABLED` unset or `false`.
   Adjust the manifest time zone to the business's intended reporting time zone before recording the candidate configuration.
4. Select and run `setupWorkspace_` in the script editor.
   Review the permission list against [the qualification checklist](google-test-plan.md).
   Confirm the managed tabs exist and Script Properties contain `INSTALLATION_STATE=ready`, `SCHEMA_VERSION=1`, and a nonempty installation ID.
5. Create a new web app deployment that executes as the deployment administrator and permits only users in the Workspace domain.
   Record its version and URL privately beside `PACKAGE.json` and its source digest.
   If the interface offers only broader access, stop; do not select anonymous or general public access.

The consolidated server bundle is generated from the exact listed source files.
The package inventory is an integrity record, not proof of actual Google behavior.
No deployment identifier or live account credential is included in the package.
The local `npm run demo` data uses a reserved example domain; do not run its synthetic-account seeding against your real domain.

## Set up test identities and records

1. Open the deployed app as its administrator, then add 2 synthetic sites in different regions through Admin.
   Add real internal test accounts using a regional grant, a site grant, and the Viewer role; leave one internal account unlisted.
2. Create a synthetic request at each site and a simple count metric with one goal per site.
   Use harmless operational examples, such as completed service requests, and no real customer information.
3. Open the app in separate browser profiles as each account.
   Follow the identity, direct-record, revocation, and direct-file checks in [the qualification checklist](google-test-plan.md).
4. Create the operating manual through the maintainer view only when ready to test its Google file and scheduled-check behavior.
   This action creates Google assets and can install the checking trigger; email alerts remain disabled until explicitly enabled.
5. Record each observed result with the account role, exact candidate, expected result, and actual result.
   Redact email addresses and file identifiers before sharing screenshots publicly.

Viewer is currently an account-information role, not an operational reporting role.
Administrators have organization-wide authority; restricted administrators are unsupported and rejected.
Staff cannot receive private-domain application authority merely by knowing its URL.
Do not promise a permanently branded hostname for this Apps Script deployment.

## Exercise interrupted-save recovery

Ordinary users retry the original command using the application's recovery panel.
Its review section shows the submitted values, and later form edits are not included in that retry.
Keep the page open until the original change is settled.
New business saves pause while any accepted operation is unfinished, protecting related records from inconsistent updates.

The initial live check should use 2 browsers attempting the same record version and a retried request after a lost response.
Do not delete rows or change source data to manufacture a failure.
Local tests already inject writes that fail before persistence and writes that persist before their acknowledgment is lost.
Google-specific fault experiments need an explicitly reviewed TEST harness; none is activated by installation.

For an operation that remains blocked, the deployment administrator inspects the `Operations` status and sets `RECOVERY_OPERATION_ID` to its ID.
Run `recoveryRecoverConfiguredOperation_` only for `PREPARED` operations with a complete verified plan.
Run `recoveryCancelConfiguredPreparation_` only for an abandoned `PREPARING` operation; no business step has started in that state.
After a confirmed cancellation, reopen the form or reload the entry screen to obtain a new submission key.
`NEEDS_REVIEW` can contain partial business writes and must not be cancelled or overwritten by guessing.
Preserve the workbook and receipt for investigation.
The datastore owner can edit both records and history directly, so these receipts are not tamper-proof evidence.

## Export and restore into a separate workbook

1. Create an unshared backup folder owned only by the deployment account.
   Set `BACKUP_FOLDER_ID` in the source script and run `recoveryExportConfigured_` in its editor.
   Record `LAST_BACKUP_FILE_ID` and `LAST_BACKUP_HASH` from Script Properties.
2. Create a separate, unshared, completely empty spreadsheet named `PLUMB RESTORE TEST`.
   Do not choose the source workbook or an earlier partial restore.
3. Set `BACKUP_FILE_ID` and `RESTORE_SPREADSHEET_ID` in the source script, then run `recoveryRestoreConfigured_`.
   This writes only the isolated destination and never activates it.
4. Inspect `_RestoreControl` and compare row counts, linked IDs, served guidance, source hash, schema, release, and template versions.
   Confirm TEST mode, disabled notifications, and `AWAITING_ADMIN_REVIEW`.
5. Keep the restored workbook isolated for review.
   Reconstructing its script, editable Google Docs, deployment, triggers, and reviewed properties is a separate activation procedure; do not run first-install setup over restored data.

The package contains logical application data, retained served guidance, operation history, and allowlisted configuration.
It does not contain the original editable manual, Google file permissions, credentials, application code, or deployment and trigger objects.
Keep the tested application package and a separately controlled copy of the editable manual alongside backups.
Shared Drives and shared backup folders are intentionally rejected by this first restore adapter.
The 10 MB package ceiling is an initial supported software limit; live size and timing qualification remains pending.

## Finish the session

Leave reminders and alerts disabled until separately approving test recipients and delivery checks.
Record installed triggers and remove or disable TEST triggers when their observation period ends.
Keep the deployment and files private.
Return the filled qualification results before advancing to business data, customer installation, or production use.

