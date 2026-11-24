FINAL

# STATUS — Mirsad Android

_Last update: 2026-11-24 23:10 (+04). Definition of done met; see "How it was checked"._

## What works
- `./gradlew :core:test :app:assembleDebug :app:lintDebug` is green: 107 core tests (engine, HOLD gate policy,
  robustness, classifier, reports, the 56-row legitimate suite with 0 held and 0 warned, and two never-HOLD sets),
  lint 0 errors, no-INTERNET gate. Every app build runs the core tests first.
- Judge path without permissions: Demo → scam held → incident with reasons and timing → a wrongly held legitimate
  message restored with Not a scam (Undo) → report preview with the exact JSON. Share target "Check with Mirsad".
- Live protection with permissions: an injected scam SMS is held (original notification removed, quiet notice with
  Not a scam and Report) and a call from the same number is rejected and kept in the call log. Checked on Android 14
  (media emulator) and Android 16.
- Engine rules 1.2.0 + classifier lr-ngram-v1 behind the HOLD gate; Arabic and English with RTL; blocklist import;
  Aman shortcuts disabled for synthetic incidents; training-row export; laptop CLI `scripts/analyse.sh`.
- dist/mirsad-android-debug.apk, 11 screenshots and the 30.0 s video/GIF all come from the same final build.

## How it was checked
Independent verification (VERIFIER_REPORT.md): six of eleven verifiers finished before the usage limit; every blocker
they found is fixed and covered by a test. Open items are listed there and in README section 10.

## Next (if anyone continues)
1. Lower the WARN rate on legitimate messages (retrain with legitimate messages that contain links).
2. Arabic review items and dialect OTP-request phrasings.
3. Allow-listed senders should still WARN on hard link evidence.

## How to resume
Read PLAN.md and DECISIONS.md, then `./gradlew :core:test :app:assembleDebug :app:lintDebug`.
Media: `scripts/full_capture.sh` (emulator-5554). Engine on a laptop: `scripts/analyse.sh`.
