# Decisions

One line per decision taken without asking, newest at the bottom.

- 2026-11-24 Product folder is `mirsad-android/` at the repo root: the repository holds one Node.js product at the root and no products directory, so there is no sibling convention to follow.
- 2026-11-24 Event and team name: the root README names neither; the README calls this a prototype for the Abu Dhabi Police hackathon by the Mirsad team.
- 2026-11-24 Toolchain: AGP 9.2.1 + Gradle 9.4.1 (AGP 9.2 minimum/default, both already in the local Gradle cache), Kotlin 2.4.21 (latest stable on Maven Central), KSP 2.3.14, Room 2.8.5, JDK 17, compileSdk/targetSdk 37.
- 2026-11-24 Compose BOM 2026.09.00 instead of 2026.11.01: Compose 1.13 requires compileSdk 37.1, which AGP 9.2 does not support.
- 2026-11-24 JSON assets live in `app/src/main/assets/` (canonical) and are exposed to :core as classpath resources via a sourceSet, so the engine and its JVM tests read the same files the APK ships.
- 2026-11-24 Debug build type uses R8 shrinking without obfuscation so the APK in dist/ stays under the 25 MB repo file cap (unshrunk debug APK was 64 MB).
- 2026-11-24 Material icons: only the core icon set; `material-icons-extended` dropped for size.
- 2026-11-24 A teammate offered a hosted model (via an env var) to generate extra synthetic rows laptop-side; the variable is not present in this session's shell and rc files cannot be sourced, so synthetic rows come from the deterministic Kotlin generator only. The app stays offline either way.
- 2026-11-24 On-device LLM explanation (M4) stays behind an `ExplanationProvider` interface with a template implementation; Liquid AI LFM2.5-350M via llama.cpp (model pushed over adb) is the documented candidate, not integrated: the LEAP Android SDK is deprecated, the model exceeds the 25 MB repo file cap, and M1–M3 take priority.
- 2026-11-24 "A number that appeared in a held message" is hard evidence for calls only; for a follow-up message from that number it is a soft signal (WARN at most), because the spec lists it as a call rule.
- 2026-11-24 A small fee behind a link holds only when corroborated (named UAE entity, foreign number, deceptive link or a threat); a bare small fee with a link from a local number (a laundry, a nursery) is WARN at most.
- 2026-11-24 Block-list hits (sender, domain, fingerprint) and the held-number call rule hold at every sensitivity; sensitivity moves the thresholds for content evidence only. The never-HOLD caps still win.
- 2026-11-24 Traffic that the live services ALLOW is not stored at all (no text, no number); only WARN and HOLD incidents are kept. Demo and share checks are stored because the user asked for that verdict.
- 2026-11-24 The Demo's "legitimate message Mirsad gets wrong" is a friend who really changed number and asks to be paid back with an IBAN: the engine holds it (payment request with an account), which is the honest example for the one-tap Not a scam flow.
- 2026-11-24 Demo and media use +447000000001 for the injected scam SMS and call: the emulator's telephony stack rewrites +440000000001 to +44000000001, which would break the SMS-to-call rule in the recording.
- 2026-11-24 The debug autopilot receiver requires android.permission.DUMP (held by adb shell only), because the APK in dist/ is the debug build and the autopilot can reset data.
- 2026-11-24 Assets ship twice in the APK (as assets and as Java resources of :core, about 1 MB extra): accepted, so the engine loads the same files on the JVM and on Android without an Android-specific loader.
- 2026-11-24 Applied the verifier's validated rules patch (negation-aware credential/OTP requests, wider OTP templates, fewer shortener false hits, aadc.ae official): on the verifier's 289 new legitimate messages HOLD fell from 28 to 1 while the scam corpus kept its HOLD/WARN split.
- 2026-11-24 Engine hardening: only the first 2,000 characters are analysed, link/e-mail/URL regexes are bounded, and an internal error on text with a link, number or money word returns WARN (never ALLOW): pathological inputs went from up to 90 s to under 0.4 s.
- 2026-11-24 A transfer request with an IBAN or wallet is hard evidence only from a plain or unknown number and when corroborated (pressure, new-number story, impersonation, foreign number, prize, job, investment); landlords, schools and contractors are WARN at most.
- 2026-11-24 A brand sub-domain on a known deep-link/survey platform (onelink.me, qualtrics.com …) is a soft signal: real banks send app and survey links that way.
- 2026-11-24 Never silent: if Mirsad cannot post notices (permission or notifications off), a would-be HOLD keeps the original notification and a call is allowed.
- 2026-11-24 The held-number call rule counts only real held messages (not calls, not demo incidents, not items marked Not a scam), so demo runs never affect live protection.
- 2026-11-24 HOLD notices use a quiet channel (IMPORTANCE_LOW, no sound); WARN stays high importance so a suspicious call shows a heads-up while it rings.
- 2026-11-24 Report copies are saved in app-private storage only and removed by Delete all data; the report preview lists follow the app language.
- 2026-11-24 The root README does not list products (it documents the single root service), so no line was added there.
- 2026-11-25 The demo video is a 20-second captioned explainer (English and Arabic versions, 1920x1080) built from real phone frames with cross-fades, for viewers who have never seen the product; the user records the voice-over (docs/VOICEOVER.md). ffmpeg here has no text renderer, so captions are drawn with Pillow.
- 2026-11-25 The README video is a 17-second live recording of two phones side by side (left without Mirsad, right with it) receiving the same scam SMS and call at the same moment, because the slide-style explainer did not show the product working. 17 s follows the request relayed from the user's side session. The slide explainer script stays in scripts/ but is no longer the README video.
- 2026-11-25 Listener de-duplication fixed: a re-post of the same notification within 60 s is not analysed again, but if that message was held the re-posted notification is removed again; the same text arriving later is analysed again (before, a scam re-sent from the same number was never held while the listener stayed alive).
