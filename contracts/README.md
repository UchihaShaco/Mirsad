# Shared contracts

Files the Mirsad portal (repository root, TypeScript) and Mirsad Android (`mirsad-android/`, Kotlin) exchange. Both
sides test against these same fixtures, so neither can change a format without the other noticing.

| File | Producer | Consumer | Format |
|---|---|---|---|
| `fixtures/citizen-report.v1.json` | Mirsad Android (Report) | Portal, `POST /v1/citizen-reports` | Scam report v1 (`mirsad-android/docs/EVIDENCE_SCHEMA.md`, section 1); a real (non-demo) report with fictional values |
| `fixtures/citizen-report.v1.demo.json` | Mirsad Android, captured from a real phone's Demo | Portal | The same format with `synthetic: true`; the portal refuses it unless imported as a demo |
| `fixtures/false-positive-report.v1.json` | Mirsad Android ("Not a scam") | Nobody in the portal | Refused by the portal: it is meant for the app's developers |

All numbers are fictional (zero-filled or reserved ranges) and all domains end in `.example`.
