# STATUS — Mirsad Android

_Last push: M0 bootstrap._

## What works
- Gradle skeleton builds: `:core` (pure Kotlin contracts + placeholder engine) and `:app` (Compose shell, manifest with
  listener, call screening, share target and notice receiver stubs).
- Build-time privacy gate: `checkNoInternetDebug` fails the build if the merged manifest holds INTERNET.

## In progress
- Workstreams A–G running in parallel (see PLAN.md).

## Next
- M1 vertical slice: Demo, Check a message, real Stage 1, Incident, Quarantine + Not a scam, Report preview, APK in dist/.

## How to resume
Read PLAN.md, then `./gradlew :core:test :app:assembleDebug :app:lintDebug`.
