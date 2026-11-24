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
