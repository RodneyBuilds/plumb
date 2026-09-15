# Security boundaries

This is an experimental foundation and has not completed live Google Workspace qualification.
Do not store real business records, credentials, regulated data, or personal histories in a test installation.

The application checks permissions on the server and restricts deployment to a Workspace domain.
The deploying account executes server requests and needs the scopes listed in `app/appsscript.json`.
Review those permissions before authorizing any installation.
Underlying spreadsheet and script owners remain trusted: they can bypass application controls and alter audit data.
Audit records are not tamper-proof.

Backups are logical exports, not complete account backups.
They do not restore source code, document contents, permissions, deployments, or triggers.
Unfinished operations can pause new writes until administrative recovery.
No certification, availability guarantee, or security guarantee is claimed.

Use the [Google qualification checklist](docs/google-test-plan.md) before considering operational use.
If a security defect is found, do not post credentials, live records, or exploit details in a public issue.
Use GitHub private vulnerability reporting if it is available; otherwise request a private reporting channel without disclosing the vulnerability publicly.
