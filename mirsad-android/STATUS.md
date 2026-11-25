FINAL

# STATUS — Mirsad Android

_Last update: 2026-11-24 23:10 (+04). Definition of done met; see "How it was checked"._

## What works
- `./gradlew :core:test :app:assembleDebug :app:lintDebug` is green: 114 core tests (engine, HOLD gate policy,
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

## Live test on a real phone (2026-11-25)

Tested by the team lead's session on a real Android 15 phone over adb, with the APK built from this source (the
`dist/mirsad-android-debug.apk` committed alongside this note is that exact build). Nothing here used an emulator.

| What | Result |
|---|---|
| Build and checks | `:core:test` 114/114, `:app:assembleDebug`, `:app:lintDebug` 0 errors; the APK asks only for notifications (no INTERNET) |
| Demo, Report preview, Check a message (share sheet) | Work as documented; Aman shortcuts disabled for demo incidents |
| Live notification from a monitored app (fake police fine) | Caught on arrival, **held** (risk 96%), original notification removed, Mirsad notice posted; a normal message was left alone |
| Real SMS through Google Messages | Caught live with the right reasons; **warned**, not held, because the sender was a saved contact (the contact cap, by design) |
| Real call from a number on the block list | **Rejected before ringing**; Android's call log records it as blocked; the incident says "The sender is on your block list" |
| Signed blocklist from the Mirsad portal (new) | Verified list imported; a tampered copy refused with nothing changed; a newer list from the same key replaced the previous one |
| Blind set of 30 new messages (15 scam, 15 legitimate, EN and AR) | 15/15 scams flagged (8 held, 7 warned), 15/15 legitimate allowed |

Fixed during the test:
- `scripts/push_report_to_mirsad.sh` was refused on every push (`account_not_authorized`: it invented a channel
  account per report, and posted citizen reports as Telegram chats). It now sends the report as-is to the portal's
  `POST /v1/citizen-reports`; an officer can also import the file in the portal.
- `scripts/analyse.sh` treated SMS sender IDs such as `ADCB-Alert` as saved contacts and only warned where the phone
  holds. Both now use one rule, `SenderHeuristics` in core.

Worth deciding: a scam from a saved contact (for example a hacked friend's account) is only ever warned about, and a
warned scam does not count against the sender's calls; only a held message or a block-list entry blocks calls.

## Emulator run (2026-11-25, Android 13 x86_64, Windows adb through WSL)

The committed APK has no INTERNET permission. A scam SMS was held and a benign one allowed. A call from the held
number was rejected. Not a scam and Undo worked, and the UI works in Arabic. A report from the phone was pushed to the
portal (201): it is listed under Citizen reports and its number is on the watchlist. The committed APK refused the
signed blocklist from this machine's portal (the key is not trusted). A build that trusts that key verified it, then
rejected a call and held an SMS from a blocklisted number.

With Mirsad contact sync also installed, a number on its "⚠️ Known Scammer" contact got past Mirsad: Android does not
screen calls from contacts, and the SMS notification shows the name, not the number. Fixed for messages: the
contact-sync names are a block signal (`SENDER_KNOWN_SCAMMER_CONTACT`, rules 1.3.0), so such an SMS is now held.
Not a scam remembers only the template, never the name. Calls from that contact still ring until the contact-sync app
sends its contact to voicemail. `test assembleDebug lintDebug` is green with 120 core tests.

## Next (if anyone continues)
1. Lower the WARN rate on legitimate messages (retrain with legitimate messages that contain links).
2. Arabic review items and dialect OTP-request phrasings.
3. Allow-listed senders should still WARN on hard link evidence.

## How to resume
Read PLAN.md and DECISIONS.md, then `./gradlew :core:test :app:assembleDebug :app:lintDebug`.
Media: `scripts/full_capture.sh` (emulator-5554). Engine on a laptop: `scripts/analyse.sh`.
