# First-release product contract

Status: implementation target, not a shipped feature list.

## Decision supported

An operations manager must see which work needs intervention, who is responsible, when the next action is due, and whether a completed intervention was followed by a measurable change.
Every success, pending state, and failure must leave the next safe action clear.

## Relationship and work records

Customer organizations and contacts use immutable IDs independent of names or email addresses.
Contacts belong to one customer organization in the first release.
Each customer organization belongs to an explicit set of sites; users see only customers linked to their authorized sites.
Work belongs to one site and may link to a customer organization and one of its contacts.
Server validation rejects a customer that is not assigned to the work's site or a contact that belongs to another customer.
Archived customers and contacts remain readable in existing authorized work history but cannot be selected for new work.
Duplicate warnings search authorized records only and never reveal hidden organizations or contacts.

Administrators and scoped managers manage customer records within their authorized sites.
Site staff can select and read applicable customers and contacts; creating or changing shared directory records requires management permission.
Viewer remains an access-only role until a separate operational read permission is explicitly designed.
Names, business email, optional business telephone, and a short business note are sufficient for the first directory.
Do not add identity documents, sensitive personal histories, attachments, or inbox imports.

Intake remains the canonical work record.
Preserve New, Triaged, Assigned, In Progress, Waiting, Resolved, Closed and the existing explicit transition rules.
Assigned work needs an active authorized staff owner, next step, and due date.
Site staff may update progress on their own assigned work in scope; manager-only assignment, reassignment, closure, and reopening are checked on the server.
History preserves prior deadlines and owners.
The interface shows the customer, owner, next step, deadline, status, and latest change together.

## Improvement actions

Actions belong to a goal and its site.
Creation requires a current measured baseline and an authorized owner.
Store the exact selected guidance, source generation, baseline observation ID/value/period, and creation time once.
Later edits to the manual do not rewrite the action's historical guidance.
Owners may move Open to In progress to Done; managers can return Done to In progress with a reason.
Only a scoped manager can mark Done as Verified after a later measurement period exists.
Store that follow-up observation ID, period, value, reviewer, and timestamp.
Show the measured difference and a plain statement that a before/after comparison does not establish causation.
If the baseline or follow-up observation is subsequently corrected, retain the captured comparison and visibly flag that the source observation has a replacement.
Do not silently recalculate an already verified action.

An action without a later measurement remains Done and awaiting measurement.
An inactive owner is shown as needing reassignment and receives no notification.
Actions use version checks and stable command IDs to prevent lost updates and duplicate creations.

## Operational measures

Keep measured operational facts distinct from manually entered monthly figures.
The initial operational view can derive open/overdue work and stage counts from current records and completion/reopen events from history.
Use the reporting period and timezone explicitly on every historical measure.
Never count a record with an incomplete save as committed work.
On-time completion uses the due date captured at the completion event, and prior deadline changes remain visible for review.
Reopen rate divides work reopened during a period by work closed during that period and shows both counts; when the denominator is zero, report no comparable rate.
Do not infer revenue or labor savings from activity counts.

## Safe service boundaries

Ordinary users use the app, not direct access to the system workbook.
Manual procedures are approved by the business's designated editor.
Public inquiry collection, Calendar integration, and third-party connections are optional adapters and stay disabled by default.
The supported custom-domain promise is a branded entry point where available, not a guarantee that a custom hostname remains visible throughout Google authentication.
Performance, recovery time, and capacity are qualification targets until measured in Google.
