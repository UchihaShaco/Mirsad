# Mirsad Android: architecture

Two Gradle modules, one contract file, no network.

## Modules

| Module | What | Rules |
|---|---|---|
| `:core` | Detection engine, classifier, report builder, contracts. | Pure Kotlin/JVM. No Android imports. Everything that decides is unit-testable on the JVM. |
| `:app` | Android app: Compose UI, Room storage, services, share target, notices. | Kotlin + Jetpack Compose + Material 3, minSdk 29, compile/target SDK 37. |

Toolchain: AGP 9.2.1, Gradle 9.4.1, Kotlin 2.4.21, KSP 2.3.14, Compose BOM 2026.09.00, Room 2.8.5, JDK 17. Allowed
dependencies: AndroidX (core, appcompat, activity-compose, navigation-compose, lifecycle), Compose BOM, Room with KSP,
kotlinx.serialization, kotlinx.coroutines, JUnit. Nothing else.

## Contracts

`core/src/main/kotlin/app/mirsad/core/contract/Contracts.kt` is the single source of truth and is owned by the lead.
Every workstream compiles against it. The types, in the order the data flows:

- **`Event`**: one incoming call, message or shared text. Channel (CALL / SMS / CHAT), raw sender, text (null for a
  call or hidden content), source app package, timestamp, `senderLooksLikeContact`, `contentHidden`.
- **`EngineContext`**: what the engine needs beyond the event, read from Room on every call: sensitivity, allow and
  block lists (senders, domains, fingerprints), known-good fingerprints, numbers that were senders of held messages in
  the last 7 days, and `stageOneOnly` for calls.
- **`ScamEngine.analyse(event, context): Verdict`**: synchronous, thread-safe, never throws.
- **`Verdict`**: score in [0, 1], `Level` (ALLOW / WARN / HOLD), a list of `Reason` (stable code from `ReasonCodes`,
  weight in [-1, 1], optional detail such as a host, `hard` flag), extracted `Artifact`s (PHONE, URL, DOMAIN, IBAN,
  EMAIL, WALLET, HANDLE), a 16-hex-char fingerprint, latency in ms, detected `Language`, model and rules versions.
- **`Classifier.scoreScam(normalisedText): Double`**: Stage 2. `NoopClassifier` returns 0 until a model is wired in.
- **`Incident`**: a stored verdict plus what the UI needs (sender type, source, synthetic flag, feedback, whether the
  original notification was removed, the notification key and title).
- **`IncidentStore`, `ListStore`, `FeedbackStore`, `SettingsStore`**: storage interfaces, implemented in `:app` with
  Room and SharedPreferences/DataStore.
- **`IncidentPipeline`**: `process`, `markNotScam` (returns an `UndoToken`), `undoNotScam`, `confirmScam`,
  `engineContext`. The UI and the services call only this.
- **`ReportBuilder`**, `ScamReport`, `FalsePositiveReport`, `ReportPreview`, `BlocklistFile`: reporting, built in
  `:core` and shared only when the user taps Report.

Reason codes are a closed set, so every reason can be translated into plain Arabic and English in the UI. `Reason.detail`
may carry a host or a number, never raw message text.

## Pipeline

```
  Carrier call ──────► MirsadCallScreeningService ───┐
  Notification from   ┐                              │
  SMS app, WhatsApp,  ├► MirsadNotificationListener ─┤
  Telegram, Botim     ┘                              │     Event(channel, sender, text, appPackage,
  "Check with Mirsad" ─► ShareReceiverActivity ──────┤           timestamp, senderLooksLikeContact,
  Demo sample ─────────► Demo screen ────────────────┘           contentHidden)
                                                     │
                                                     ▼
                                   IncidentPipeline.process(event, source, synthetic)
                                                     │
                            EngineContext ◄── Room: lists, sensitivity, held numbers (7 days)
                                                     │
                                                     ▼
          ┌──────────────────────── ScamEngine.analyse() ── :core, pure Kotlin ───────────────────────┐
          │                                                                                           │
          │  normalise text ──► Stage 1: sender rules, link analysis, lookalikes, content signals,    │
          │  (Arabic forms,       reputation lists, cross-channel call rule          ──► reasons      │
          │   digits, Arabizi)                                                                        │
          │                 ──► Stage 2: hashed char n-gram + word unigram LR        ──► MODEL_SCORE  │
          │                                                                                           │
          │  combine ──► score ──► HOLD gate (threshold AND a hard reason; never-HOLD rules) ──► level │
          │  extract artifacts (E.164, URL, domain, AE IBAN mod-97, e-mail, wallet, wa.me/t.me)        │
          │  fingerprint = SimHash64(normalised text, digits and URLs masked)                          │
          └──────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                     │ Verdict
                           ┌─────────────────────────┼──────────────────────────┐
                           ▼                         ▼                          ▼
                  Room: Incident            Notice (NotificationCompat)     UI (Compose)
                  Quarantine, 30 days       WARN: caution + reasons         Incident screen
                                            HOLD: remove original,          Quarantine & Activity
                                            "Held 1 suspicious message      Report preview
                                            from <sender>" + Not a scam     Not a scam / Undo
                                            / Report actions
```

Calls take the same path with `stageOneOnly = true`, a 1 s budget, and allow on timeout.

## Services and entry points

| Component | Kind | Notes |
|---|---|---|
| `MainActivity` | Single activity, Compose | Deep-link extras: `EXTRA_INCIDENT_ID` opens an incident; `EXTRA_SCREEN` is one of `home`, `quarantine`, `demo`, `settings`, `onboarding`, `report`. |
| `share.ShareReceiverActivity` | `ACTION_SEND text/plain`, translucent, excluded from recents | "Check with Mirsad". Runs the text through the pipeline as `IncidentSource.SHARE` and opens the incident screen. No permission needed. |
| `service.MirsadNotificationListener` | `NotificationListenerService`, bound by the system | Watches the packages in Settings (default: Google/AOSP/Samsung Messages, WhatsApp, WhatsApp Business, Telegram, Botim). Builds an `Event` from the notification title and text; sets `senderLooksLikeContact` when the title parsed as a name and `contentHidden` when the system hid the text (Android 15+ one-time codes). On HOLD it cancels the original notification by key and posts the notice. |
| `service.MirsadCallScreeningService` | `CallScreeningService`, bound once Mirsad holds the `CALL_SCREENING` role via `RoleManager` | Sees number and direction only, and only for numbers not in contacts. Stage 1 only, 1 s budget, allow on timeout. HOLD = reject before ringing, keep in call log, post a notice. |
| `service.NoticeActionReceiver` | `BroadcastReceiver`, not exported | Not a scam / Report / Undo actions on notices. |
| `demo.AutopilotReceiver` | Debug-only receiver | Plays the demo storyboard on a timer for the recording script. Not in release. |
| AppCompat `AppLocalesMetadataHolderService` | Metadata holder | Persists the in-app Arabic/English choice (per-app languages). |

No foreground service. The listener and the screening service are bound and unbound by the system.


## Storage

Room, in the app's private storage, `allowBackup=false`:

| Table | Content | Retention |
|---|---|---|
| incidents | `Incident` rows: verdict, reasons and artifacts as JSON, source, synthetic flag, feedback, notification key | 30 days (`purgeOlderThan`), or until the user clears |
| list_entries | `ListEntry`: ALLOW_SENDER, BLOCK_SENDER, BLOCK_DOMAIN, BLOCK_FINGERPRINT, KNOWN_GOOD_FINGERPRINT with an origin (`user`, `not_a_scam`, `import:<file>`) | Until removed in Settings or by Undo |
| feedback | `Feedback`: verdict, fingerprint, reason codes, model version, text, language | Until cleared; exported with the training data |

Settings (language, sensitivity, monitored packages, onboarding done) live in SharedPreferences or DataStore behind
`SettingsStore`. Room schemas are exported to `app/schemas/`.

Composition root: `AppContainer` (engine, stores, pipeline, report builder). `MirsadApp` installs the Room-backed
container; `bootstrap/InMemoryContainer` is the no-storage fallback that kept the app runnable while the stores were
built.


## Threading

- `ScamEngine.analyse` is synchronous and safe from any thread; it measures its own latency and reports it in the
  verdict.
- `IncidentPipeline` methods are `suspend` and run on `Dispatchers.IO` (Room, lists, notices). The UI never calls the
  engine directly.
- The notification listener receives callbacks on a binder thread and hands each notification to a coroutine scope
  owned by the service; the original notification is cancelled only after the verdict is HOLD and the copy is stored.
- The call-screening service wraps the Stage 1 call in a 1 s timeout; on timeout or any exception it responds with
  allow. `respondToCall` is always called exactly once.
- The UI observes `Flow`s from the stores through ViewModels; Compose recomposes on changes.


## Build gate

`app/build.gradle.kts` registers `checkNoInternet<Variant>` on every variant. It reads the merged manifest and fails the
build if `android.permission.INTERNET` or `android.permission.ACCESS_NETWORK_STATE` appears. `package*`, `assemble*`
and `lint*` depend on it. The manifest additionally declares both permissions with `tools:node="remove"`, so a library
that merges them in is stripped before the gate runs. The standard build and test command:

```sh
./gradlew :core:test :app:assembleDebug :app:lintDebug
```

Debug builds use R8 shrinking without obfuscation so the APK in `dist/` stays small; the release build type uses the
debug signing config (prototype only).

## Where assets live

Canonical JSON and model assets are in `app/src/main/assets/`, so the APK ships them as assets:

| File | Owner | Purpose |
|---|---|---|
| `rules.json` | Engine | Stage 1 rule weights and patterns; its `version` is reported as `rulesVersion`. |
| `official_domains.json` | Engine | Reference list of official UAE domains for lookalike detection. Starter list, to be verified. |
| `lexicon.json` | Engine | Local entities, lures and Arabic/Arabizi forms. |
| `model.bin` | Classifier | Stage 2 weights written by `./gradlew :core:trainModel` from `data/`. |
| `report_channels.json` | Reporting | Aman and eCrime shortcuts, marked `to_be_confirmed`. |
| `blocklist_example.json` | Reporting | Example import file: zero-filled numbers, `.example` domains. |

`core/build.gradle.kts` adds `../app/src/main/assets` as a resources source directory, so `:core` and its JVM tests
load the same files from the classpath that the APK ships. There is one copy of every asset.

All sample data is synthetic: zero-filled numbers such as `+971500000003` and `+440000000001`, domains ending in
`.example`, incidents flagged `synthetic = true`.


## Ownership (from PLAN.md)

Engine `core/.../engine/**` and the engine assets; classifier `core/.../ml/**`, `data/**`, `model.bin`; UI
`app/.../ui/**`, `res/**`, `MainActivity.kt`, `demo/**`; services and storage `app/.../data/**`, `service/**`,
`share/**`, `MirsadApp.kt`, `app/schemas/**`; reporting `core/.../report/**`, `app/.../report/**`,
`report_channels.json`, `blocklist_example.json`, `docs/EVIDENCE_SCHEMA.md`, `scripts/push_report_to_mirsad.sh`;
media `scripts/**`, `screenshots/**`, `demo/**`; docs `README.md`, `docs/**`; the lead owns Gradle files, the manifest,
the contracts, `AppContainer.kt`, `bootstrap/**` and `dist/`.
