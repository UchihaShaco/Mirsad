# Rules for every workstream subagent

You are one workstream of **Mirsad Android**: an on-device scam shield for people in the UAE, a prototype for the
Abu Dhabi Police hackathon, built tonight unattended. The lead integrates, builds the APK, commits and pushes.

Project folder (note the space in the path; always quote it):
`/Users/ahsalem/hackathons/scam shield/Mirsad/mirsad-android`

## Read first
1. `core/src/main/kotlin/app/mirsad/core/contract/Contracts.kt` — the contracts. Compile against them; do not change
   signatures. If you truly need a contract change, say so in your final report and work around it meanwhile.
2. `PLAN.md` — milestones and which paths each workstream owns.
3. `app/src/main/kotlin/app/mirsad/shield/AppContainer.kt` and `bootstrap/InMemoryContainer.kt` (how the app is wired).

## Hard rules
- **Edit only the paths you own** (PLAN.md table). Never touch Gradle files, the manifest, or another workstream's
  paths. If you need a dependency, a manifest entry or a Gradle change, write it in your final report; the lead does it.
- **Never run git** (no add, commit, push, stash, checkout). The lead commits.
- **Unattended.** Never ask questions. Pick the most reasonable option, note it in your report, continue.
- **No hanging commands.** Every command that can block gets `timeout 600` and non-interactive flags. Never run the
  emulator in the foreground.
- **Gradle:** `cd` into the project folder and run `timeout 600 ./gradlew <tasks> --console=plain -q`. Use the shared
  daemon (do not pass `--no-daemon`, never `--stop`, never kill Gradle processes). Other agents build concurrently; if
  you see "Timeout waiting to lock" or "another build is running", wait 30 s and retry.
- **Pure Kotlin in :core** — no Android imports. `:app` is Kotlin + Jetpack Compose + Material 3, minSdk 29.
- **No INTERNET permission**, no analytics, no crash reporting, no network code at all. A Gradle task fails the build if
  INTERNET appears in the merged manifest.
- **Dependencies allowed:** AndroidX (core, appcompat, activity-compose, navigation-compose, lifecycle), Compose BOM,
  Room (+KSP), kotlinx.serialization, kotlinx.coroutines, JUnit. Nothing else without asking the lead in your report.
- **Look up APIs before using them.** Use WebSearch/WebFetch on developer.android.com for every Android API you call
  (NotificationListenerService, CallScreeningService, RoleManager, NotificationCompat, Room, per-app languages...).
  Do not write API calls from memory.
- **Truthful.** No invented statistics or accuracy claims, no claim of endorsement by any authority, no police or
  government logos/emblems. Describe the app as a hackathon prototype.
- **Synthetic data only.** Every number is zero-filled fictional (e.g. +971500000003, +440000000001), every domain
  ends in `.example`. Mark synthetic rows/incidents as synthetic.
- **Secrets:** never print, read, copy or ask for keys, tokens or passwords.
- **Bilingual.** User-facing text exists in English and Arabic (values/strings.xml and values-ar/strings.xml).
  The safety line shown with every warning: EN "Never share banking details, passwords or one-time codes with anyone."
  AR "لا تشارك بياناتك البنكية أو كلمات المرور أو رموز التحقق مع أي شخص." (Abu Dhabi Police public guidance.)

## Emulators
- `emulator-5556` (Pixel 3a, API 34, headless) is the shared **dev** device for workstreams C and D:
  `adb -s emulator-5556 install -r app/build/outputs/apk/debug/app-debug.apk`.
- `emulator-5554` belongs to workstream F (media). Do not use it unless you are F.
- Useful: `adb -s emulator-5556 shell cmd notification allow_listener app.mirsad.shield/app.mirsad.shield.service.MirsadNotificationListener`,
  `adb -s emulator-5556 shell cmd role add-role-holder android.app.role.CALL_SCREENING app.mirsad.shield`,
  `adb -s emulator-5556 shell pm grant app.mirsad.shield android.permission.POST_NOTIFICATIONS`,
  `adb -s emulator-5556 emu sms send +440000000001 "text"`, `adb -s emulator-5556 emu gsm call +440000000001`,
  `adb -s emulator-5556 exec-out screencap -p > shot.png`, `adb -s emulator-5556 logcat -d | grep -i mirsad`.

## Working style
- Deliver a working increment first (the lead may integrate at any minute), then refine. Keep every file compiling;
  run the tests you own before you finish.
- Prefer small, plain Kotlin. Comments only where a reader needs them.
- Your **final report** (under 400 words): what you built (paths), what you verified and how (commands + results),
  known gaps, and the exact Gradle/manifest/contract changes you need from the lead, if any.
