#!/usr/bin/env bash
# One-shot media pipeline: emulator up -> install -> grant permissions -> screenshots -> video -> checks.
#
# Usage: scripts/full_capture.sh [apk]      (default dist/mirsad-android-debug.apk)
# Env:   SERIAL (default emulator-5554)
# Leaves the emulator running (stop it with scripts/emulator_down.sh). Exit code is check_media's.

source "$(dirname "$0")/_lib.sh"

APK="${1:-$PROJECT_DIR/dist/mirsad-android-debug.apk}"
step() { log "==== $1 ===="; shift; timeout "$@"; }

step "emulator_up"          400 "$SCRIPTS_DIR/emulator_up.sh"
step "install"              300 "$SCRIPTS_DIR/install.sh" "$APK"
step "grant_permissions"    120 "$SCRIPTS_DIR/grant_permissions.sh" || log "WARNING: some grants could not be verified; continuing"
step "capture_screenshots"  600 "$SCRIPTS_DIR/capture_screenshots.sh"
# Live side-by-side demo: needs a second emulator without Mirsad (LEFT) besides the Mirsad one (RIGHT).
step "record_action_demo"   300 "$SCRIPTS_DIR/record_action_demo.sh" "$MIRSAD_RUN_DIR/action"
step "make_action_video"    900 "$PYTHON" -I "$SCRIPTS_DIR/make_action_video.py" "$MIRSAD_RUN_DIR/action"
step "check_media"          120 "$SCRIPTS_DIR/check_media.sh"
