# Mirsad Android — plan

Prototype for the Abu Dhabi Police hackathon. On-device scam shield for calls and messages in the UAE.
Lead integrates, builds, commits and pushes; workstreams run as parallel subagents that never run git.

## Milestones

| | Scope | Gate |
|---|---|---|
| M0 | Environment, repo, Gradle skeleton (core + app), contracts, fake engine, manifest, no-INTERNET build check | `./gradlew :core:test :app:assembleDebug :app:lintDebug` green, pushed |
| M1 | Vertical slice: Demo screen, Check a message (share target), real Stage 1 engine, Incident screen, Quarantine + Not a scam, Report preview. APK in dist/. First screenshots + video. Judge-usable README | legit suite + build green, pushed |
| M2 | Live protection: notification listener, call screening, onboarding, notices. Verified on the emulator with an injected SMS and call. Media re-captured | pushed |
| M3 | Classifier behind the HOLD gate, Arabic polish, blocklist import, evaluation numbers in README, verifier fix list closed. Media re-captured | pushed |
| M4 | Only if M1–M3 have no open defects: OTP guard, optional on-device LLM explanation behind an interface | — |

## Workstreams and owned paths

| | Workstream | Owns |
|---|---|---|
| A | Engine | `core/src/main/kotlin/app/mirsad/core/engine/**`, `core/src/test/.../engine/**`, `core/src/main/kotlin/app/mirsad/core/MirsadEngineFactory.kt`, `app/src/main/assets/rules.json`, `official_domains.json`, `lexicon.json` |
| B | Classifier | `core/src/main/kotlin/app/mirsad/core/ml/**`, `core/src/test/.../ml/**`, `data/**`, `app/src/main/assets/model.bin` |
| C | App UI | `app/src/main/kotlin/app/mirsad/shield/ui/**`, `app/src/main/res/**`, `MainActivity.kt`, `app/src/debug/**` (autopilot), `app/src/main/kotlin/app/mirsad/shield/demo/**` |
| D | Services + storage | `app/src/main/kotlin/app/mirsad/shield/data/**`, `service/**`, `share/**`, `MirsadApp.kt`, `app/schemas/**` |
| E | Reporting | `core/src/main/kotlin/app/mirsad/core/report/**`, `core/src/test/.../report/**`, `app/src/main/kotlin/app/mirsad/shield/report/**`, `app/src/main/assets/report_channels.json`, `blocklist_example.json`, `docs/EVIDENCE_SCHEMA.md`, `scripts/push_report_to_mirsad.sh` |
| F | Media | `scripts/**` (except push_report_to_mirsad.sh), `screenshots/**`, `demo/**` |
| G | Docs + pitch | `README.md`, `docs/**` (except EVIDENCE_SCHEMA.md) |
| H | Verifier | writes only `VERIFIER_REPORT.md` |
| Lead | Gradle files, manifest, `core/.../contract/**`, `AppContainer.kt`, `bootstrap/**`, STATUS.md, PLAN.md, DECISIONS.md, dist/ |

## Contracts

`core/src/main/kotlin/app/mirsad/core/contract/Contracts.kt` is the single source of truth: Event, Verdict, Level, Reason
(+ ReasonCodes), Artifact, EngineContext, ScamEngine, Classifier, Incident, IncidentStore, ListStore, FeedbackStore,
SettingsStore, IncidentPipeline, ReportBuilder, ScamReport, FalsePositiveReport, BlocklistFile.
App-side: `AppContainer` (composition root) and `MainActivity` extras for deep links.

## Resume after a context reset

1. Read STATUS.md (what works, what is in progress) and this file.
2. `./gradlew :core:test :app:assembleDebug :app:lintDebug` to confirm the tree is green.
3. Continue the lowest unfinished milestone; push at every milestone and at least every 30 minutes.
