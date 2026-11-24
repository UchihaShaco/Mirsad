#!/usr/bin/env bash
# Install the Mirsad APK on the media emulator, replacing any existing install and granting all
# runtime permissions declared in the manifest.
#
# Usage: scripts/install.sh [apk]      (default: dist/mirsad-android-debug.apk)
# Env:   SERIAL (default emulator-5554)
#
# adb --help: "install [-lrtsdg] [--instant] PACKAGE": -r replace existing application, -g grant all runtime permissions.

source "$(dirname "$0")/_lib.sh"

APK="${1:-$PROJECT_DIR/dist/mirsad-android-debug.apk}"
[[ -f "$APK" ]] || die "APK not found: $APK"
require_device

log "Installing $APK on $SERIAL"
adbs_t 180 install -r -g "$APK"
app_installed || die "$APP_ID is not installed after adb install"
log "Installed: $(adbs shell dumpsys package "$APP_ID" | grep -m1 versionName | tr -d '\r' | sed 's/^ *//')"
