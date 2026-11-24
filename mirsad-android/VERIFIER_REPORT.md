# Verification report

Independent verification ran on 2026-11-24 against a frozen build (rules 1.0.0/1.1.0). Eleven verifiers were planned;
six finished before the account's usage limit stopped the rest (device walk without permissions, live protection,
engine, UI and security code reviews did not run). The lead covered the live path and an Android 16 smoke test by hand.

Finished: false-positive attack (289 new legitimate messages), scam-miss attack (232 new scams + robustness), claims
check of every document, services/storage review, Arabic review, fresh-clone build.

## Fixed

| Finding | Fix |
|---|---|
| Regex backtracking: seconds to minutes on 1 KB of crafted text (blocker) | Bounded URL, bare-domain and e-mail regexes; only the first 2,000 characters are analysed. Worst case now < 0.4 s. `RobustnessTest`. |
| StackOverflowError returned ALLOW, so padding hid a scam (blocker) | Internal errors on text with a link, number or money word return WARN; the padding cases now HOLD. `RobustnessTest`. |
| One-time codes from sender IDs held; "do not share" read as a request (blocker / major) | Negation-aware credential and OTP rules, wider OTP templates (the verifier's validated patch). New build-gate sets `data/never_hold_otp.tsv`, `data/never_hold_negation.tsv`. |
| IBAN payment request hard for any sender: school, landlord, contractor held | Hard only from a plain or unknown number with corroboration. |
| Small fee + link from a local shop held | Hard only with a named entity, foreign number, deceptive link or threat. |
| Brand sub-domains on deep-link / survey platforms held (adcb.onelink.me) | Soft signal for a short list of platforms. |
| aadc.ae flagged as a lookalike of addc.ae | Added to the official list. |
| HOLD silent when notifications are off | No HOLD unless the notice can be posted. |
| Demo incidents fed the live held-number call rule; held calls renewed it | Rule counts real held messages only, not calls, demo items or items marked Not a scam. |
| Share target sender "shared" treated as a sender ID | Empty sender (UNKNOWN). |
| Short-code and mixed-case SMS sender IDs treated as contacts | Digits-only titles and single-token SMS titles are sender IDs. |
| Report copies on shared external storage, never deleted | App-private storage; removed by Delete all data. |
| Report preview lists English in the Arabic UI | Arabic lists when the app language is Arabic. |
| Arabic notice titles showed "+971…" reversed | Senders wrapped in left-to-right isolates. |
| "Quiet notice" played a sound | Hold channel has no sound or vibration. |
| Android added an "Open link" button for the scam URL to Mirsad's own notice (found by the lead) | System contextual actions disabled on every Mirsad notice. |
| Feedback export unreachable | Settings > Export my corrections as training rows. |
| Legit suite did not gate `assembleDebug`; data not a test input | `preBuild` depends on `:core:test`; `data/` is a declared test input. |
| Backup / device transfer possible; unused VIBRATE; exported Compose PreviewActivity; exported autopilot | Extraction rules exclude everything; VIBRATE removed; PreviewActivity removed; autopilot needs DUMP (adb only). |
| Screenshots, video and dist APK were M0 placeholders; README claims out of date | Media re-captured from the final APK through the real services; README and docs rewritten against the build. |

## Open (documented in the README)

- WARN rate on the verifier's legitimate set is 19 % at Balanced (classifier tips messages with links; entity names
  from plain numbers). Needs real data and retraining.
- 44 of 232 verifier scams pass with no warning: no-link phone-back lures, heavy obfuscation (homoglyphs, leetspeak),
  dialect phrasings of OTP requests, unlisted remote-access apps.
- Arabic review items not yet applied: dialect scam phrasing coverage, everyday words matching entity names (سألك →
  Salik), stiff wording in some strings, count plurals.
- Allow-list entries suppress all analysis for that sender (a spoofed sender ID that was once allowed stays allowed).
- Not covered by a finished verifier: full UI code review and security review of exported components beyond the items
  above.

Raw verifier outputs were kept outside the repository (synthetic data only).
