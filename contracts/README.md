# Shared contracts

Files the Mirsad portal (repository root, TypeScript) and Mirsad Android (`mirsad-android/`, Kotlin) exchange. Both
sides test against these same fixtures, so neither can change a format without the other noticing.

| File | Producer | Consumer | Format |
|---|---|---|---|
| `fixtures/citizen-report.v1.json` | Mirsad Android (Report) | Portal, `POST /v1/citizen-reports` | Scam report v1 (`mirsad-android/docs/EVIDENCE_SCHEMA.md`, section 1); a real (non-demo) report with fictional values |
| `fixtures/citizen-report.v1.demo.json` | Mirsad Android, captured from a real phone's Demo | Portal | The same format with `synthetic: true`; the portal refuses it unless imported as a demo |
| `fixtures/false-positive-report.v1.json` | Mirsad Android ("Not a scam") | Nobody in the portal | Refused by the portal: it is meant for the app's developers |
| `fixtures/blocklist.v1.signed.json` | Portal, `GET /v1/watchlist/blocklist` | Mirsad Android, Settings → Import blocklist | Blocklist v1 with `keyId`, `expiresAt` and `signature`, signed by the throwaway key below |
| `fixtures/blocklist-test-key.json` | — | Both test suites | The fixture's public key (`GET /v1/watchlist/blocklist-key` shape). Its private half was discarded; it is not a police key and no build trusts it |

## Signed blocklist

The portal signs with ECDSA P-256 and SHA-256; `signature` is the DER signature in base64 and `keyId` is the first 16
hex characters of SHA-256 over the public key's SubjectPublicKeyInfo DER. The signed bytes are this UTF-8 text, built
from the file's own values in this order and joined with `\n` (`note` is not signed):

```
mirsad-blocklist-v1
keyId:<keyId>
issuer:<issuer>
issuedAt:<issuedAt>
expiresAt:<expiresAt>
numbers:<numbers joined with ,>
domains:<domains joined with ,>
fingerprints:<fingerprints joined with ,>
```

Portal: `src/services/blocklist-export.ts`. App: `core/.../report/BlocklistSignature.kt`. A signed list that does not
verify against a key in the app's `assets/trusted_blocklist_keys.json`, or has expired, is refused. A verified list
replaces the previous list from the same key. Add a deployment's key with `mirsad-android/scripts/trust_portal_key.sh`.

All numbers are fictional (zero-filled or reserved ranges) and all domains end in `.example`.
