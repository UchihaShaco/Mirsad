# STATUS — Mirsad Android

_Last update: 2026-11-24 22:30 (+04). Milestones M1 and M2 integrated; M3 (classifier) wired; independent verification running._

## What works (checked by the lead on the emulator, Android 14)
- `./gradlew :core:test :app:assembleDebug :app:lintDebug` is green: 103 core tests (engine, classifier, reports, the
  56-row legitimate-message suite with 0 held and 0 warned, gate policy), lint with 0 errors, and the no-INTERNET gate.
- Judge path with no permissions: Demo → a scam is held → incident with reasons and timing → Not a scam with Undo →
  report preview with the exact JSON.
- Live protection with permissions granted: an injected scam SMS is held (original notification removed, Mirsad notice
  with Not a scam and Report), and a call from the same number is rejected before ringing and stays in the call log.
- Real engine (rules 1.1.0) plus the trained classifier (`lr-ngram-v1`, 1 MB) behind the HOLD gate; share target; Room
  storage; Arabic and English with an in-app switch; report builder, Aman shortcuts, blocklist import.
- Media in `screenshots/` and `demo/` were captured from the APK in `dist/` through the real services.
- `scripts/analyse.sh` runs the same engine on a laptop without a phone.

## In progress
- Independent verification (device walks, false-positive and scam-miss attacks, claims check, code, security and Arabic
  review, fresh-clone build). The fix list lands in `VERIFIER_REPORT.md`.
- README still carries "Status: to confirm" notes; they are removed once the claims check is in.

## Next
1. Close the verifier fix list, re-capture media, push.
2. Put the evaluation numbers and the measured false-positive and miss rates in the README.
3. Android 16 smoke test (system image downloaded) and FINAL.

## How to resume
Read PLAN.md, then `./gradlew :core:test :app:assembleDebug :app:lintDebug`. Emulators: `emulator-5554` is the media
device (`scripts/full_capture.sh`), `emulator-5556` the dev device. Decisions are in DECISIONS.md.
