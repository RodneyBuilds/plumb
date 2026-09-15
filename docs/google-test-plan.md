# Isolated Google qualification

Status: preparation only, blocked until the local security and recovery candidate is accepted.
This checklist does not authorize a deployment or certify production security.
Record the exact commit and deployment version beside every result.
Local browser tests substitute Google services.

## Prerequisites

Use a customer-controlled Workspace test domain and a new empty spreadsheet with TEST in its name.
Use synthetic business records and separate administrator, regional, site, viewer, and unlisted test identities.
Provide a second site outside the regional user's authority.
The deployment account must remain under business control, with account recovery and a successor administrator documented.
Staff receive application access, not access to the datastore workbook or the full operating manual.
Workbook editors and script editors can bypass application permissions; they are trusted administrators.
Do not import the source project's workbook, script identifiers, credentials, history, or live customer content.

## Permission review

The current execution model runs requests with the deployment account's Google authority.
Application authorization separately resolves the signed-in staff email from Google and checks its current active record and scopes.
An unavailable email must deny operational access, never substitute the deployment account.

| Permission | Purpose | Boundary to verify |
|---|---|---|
| User email | Identify the signed-in internal user | Different staff identities remain distinguishable |
| Spreadsheets | Read and write application tables | Private datastore, no staff direct access |
| Documents | Create and read operating guidance | Full manual restricted to maintainers |
| Drive | Read document metadata and manage application files | Broad account permission, use a dedicated deployment account |
| Send mail | Deliver authorized operational notifications | Disabled until an explicit delivery test |
| Script triggers | Schedule application checks | Trigger creator and replacement procedure documented |
| External requests | Read supported Google document data | Inspect exact destinations in the release candidate |
| Container UI | Show spreadsheet administrator menu | No setup action reachable through browser RPC |

The administrator must review the actual Google consent screen against the candidate manifest.
Do not approve unexplained additional permissions.
Granting these permissions, creating a deployment, changing sharing, and sending test notifications are manual approval actions.

## Identity and information boundaries

1. Open the deployed app separately as each listed internal identity and an unlisted identity.
   Confirm the named account, navigation, and authorized sites match the access records.
2. Request an outside-site record directly through the application request handler.
   Confirm rejection and absence of its title, customer details, history, document metadata, and guidance in responses.
3. Remove a staff grant, then repeat a read and write from that staff member's already open session.
   Confirm both fail without requiring sign-out or a cache expiry.
4. Attempt browser calls to setup, seed, and scheduled handlers.
   Confirm Google refuses private handler names and no workbook, trigger, or account state changes.
5. Open workbook, backup, and full manual links as ordinary staff and an outside-domain account.
   Confirm Google file permissions enforce the intended boundary independently of the application.

## Persistence and restoration

Use the candidate's documented fault test controls only in TEST, if such controls are explicitly included in its administrator package.
Do not simulate faults by deleting live records or changing production permissions.
Two different staff sessions should update the same version of a record.
Exactly one conflicting edit may succeed; the other must receive a clear reload instruction.
Retry the same accepted submission after a lost response and confirm one business record with complete activity and audit records.
An interrupted operation must remain visibly incomplete until reconciled, without appearing in completed performance totals.
Restore a generated package into a separate empty candidate and compare counts, references, configuration, and guidance generation.
Confirm the restored candidate remains TEST, has notifications disabled, and cannot silently replay historical messages.
Record the duration and the latest recoverable change; a checksum alone is not a restoration test.

## Notification and trigger qualification

Explicitly approve a small set of test recipients before enabling mail.
Run both named private scheduled handlers through real Google triggers and record the creator, result, and failure notification destination.
Confirm revoked recipients receive nothing, outside-region summaries contain no unauthorized sites, and a known pre-send failure retries within the documented limit.
A possibly accepted message with an unrecorded result must display an uncertain state and must not be automatically resent.
Disable or remove TEST triggers after the observation run.

## Performance and pilot acceptance

Measure ordinary page load, record detail, save acknowledgment, and monthly reporting with representative synthetic volumes.
Initial targets are under 3 seconds for routine reads and under 5 seconds for ordinary saves at the 95th percentile.
These are test targets, not product guarantees; record both median and slowest observed results and Google quota errors.
Include 5-15 users, 2-5 sites, simultaneous edits, and a larger retained history dataset.
If the targets fail, narrow capacity or repair the data access pattern before offering an implementation.
Run a 10-business-day TEST pilot after the preceding checks pass.
Record incidents, recovered failures, missed jobs, manual interventions, and administrator time.

## Required evidence

| Check | Expected evidence | Result |
|---|---|---|
| Exact candidate | Commit, manifest, schema, template and deployment versions | Pending |
| Identity | Account-by-account read/write and revocation results | Pending |
| File boundaries | Staff and external-account denial observations | Pending |
| Recovery | Conflicting edit, retried submission, isolated restore | Pending |
| Operations | Trigger ownership, notification outcomes, measured latency and pilot log | Pending |

An unresolved identity, data exposure, or unrecoverable accepted-write failure blocks customer use.
A successful local simulation cannot clear any pending real-Google row in this table.
