# Verification

The test suite exercises application logic and browser workflows against simulated Google services.
Run `npm run verify` to reproduce the local checks.
Run `node tools/package-test-candidate.cjs candidate-name` and then `node tests/editor-bundle.js release/candidate-name` to check a generated editor bundle.
Generated packages are excluded from Git.

Passing local tests does not establish real Google identity behavior, file permissions, quota behavior, email delivery, or operational capacity.
Live qualification remains pending.

The foundation includes server-side authorization, recoverable business operations, uncertain-send handling, immutable guidance snapshots, and logical restore into an empty test workbook.
Branding property updates remain outside the durable business-operation mechanism.
Spreadsheet owners can edit audit rows and hashes directly.

See [security boundaries](../SECURITY.md), [test installation](test-installation.md), and [Google qualification](google-test-plan.md).
