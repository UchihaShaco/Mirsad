#!/usr/bin/env bash
# Shared helpers for the Mirsad media scripts (workstream F). Source it, do not run it:
#   source "$(dirname "$0")/_lib.sh"
#
# Environment (all optional):
#   SERIAL            adb serial of the media emulator      (default emulator-5554)
#   ANDROID_HOME      Android SDK root                      (default $HOME/Library/Android/sdk)
#   AVDMANAGER        path to avdmanager                    (default $HOME/mybins/cmdline-tools/bin/avdmanager)
#   FFMPEG / FFPROBE  paths                                 (default /opt/homebrew/bin/ffmpeg, ffprobe)
#   MIRSAD_RUN_DIR    scratch dir for logs and raw pulls    (default ${TMPDIR:-/tmp}/mirsad-media)
#
# Every blocking command in these scripts is wrapped in `timeout`; nothing here is interactive.

set -euo pipefail

SERIAL="${SERIAL:-emulator-5554}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
ADB="${ADB:-$ANDROID_HOME/platform-tools/adb}"
EMULATOR_BIN="${EMULATOR_BIN:-$ANDROID_HOME/emulator/emulator}"
AVDMANAGER="${AVDMANAGER:-$HOME/mybins/cmdline-tools/bin/avdmanager}"
FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/opt/homebrew/bin/ffprobe}"
PYTHON="${PYTHON:-python3}"

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
SCREENSHOTS_DIR="$PROJECT_DIR/screenshots"
DEMO_DIR="$PROJECT_DIR/demo"
MIRSAD_RUN_DIR="${MIRSAD_RUN_DIR:-${TMPDIR:-/tmp}/mirsad-media}"
mkdir -p "$MIRSAD_RUN_DIR"

APP_ID="app.mirsad.shield"
MAIN_ACTIVITY="$APP_ID/.MainActivity"
AUTOPILOT_ACTION="$APP_ID.AUTOPILOT"
AUTOPILOT_RECEIVER="$APP_ID/.demo.AutopilotReceiver"
LISTENER_COMPONENT="$APP_ID/$APP_ID.service.MirsadNotificationListener"

# The scam sender and message used across the storyboard (synthetic, zero-filled, .example domain).
# Fictional number for the injected scam SMS and the follow-up call. The emulator's telephony stack rewrites
# some zero-filled numbers (an SMS from +440000000001 arrives as +44000000001), which would break the
# "call from the number of a held message" rule; +447000000001 arrives intact for both SMS and calls.
SCAM_NUMBER="${SCAM_NUMBER:-+447000000001}"
SCAM_SMS="Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours or it will be returned: http://emiratespost-ae.delivery-fee.example/pay"
LEGIT_NUMBER="+971500000003"
LEGIT_SMS="Your order 12345 has shipped. Track it in the app."

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

# adb against the media emulator, always with a timeout (seconds, default 60).
adbs() { timeout 60 "$ADB" -s "$SERIAL" "$@"; }
adbs_t() { local t="$1"; shift; timeout "$t" "$ADB" -s "$SERIAL" "$@"; }

# True when the media emulator is attached and in "device" state.
device_online() {
  # tr: adb.exe (Windows, e.g. through WSL interop) ends lines with CRLF, so $2 would be "device\r".
  timeout 20 "$ADB" devices 2>/dev/null | tr -d '\r' | awk -v s="$SERIAL" '$1==s && $2=="device" {found=1} END {exit found?0:1}'
}

require_device() {
  device_online || die "$SERIAL is not online. Run scripts/emulator_up.sh first."
}

# Non-blocking sleep helper that is explicit in the storyboard timing logs.
pause() { sleep "$1"; }

# Returns 0 if the app is installed on the device.
app_installed() {
  adbs shell pm path "$APP_ID" 2>/dev/null | grep -q package
}

# Broadcast one autopilot step (see scripts/autopilot.sh). Always exits 0: the receiver is a stub
# until workstream C implements it, and a missing receiver must not break the capture pipeline.
autopilot_step() {
  local step="$1"
  adbs_t 30 shell am broadcast -a "$AUTOPILOT_ACTION" -n "$AUTOPILOT_RECEIVER" --es step "$step" >/dev/null 2>&1 || true
}

# Best-effort reset of the shade before a storyboard. Force-stopping a package makes the notification
# manager cancel its notifications (verified on API 34: Messages and the dialer drop theirs; SMS and
# calls still deliver afterwards). The synthetic call log is deleted so the dialer does not re-post
# missed-call notices on the next boot. Everything here may fail silently (different stock apps, etc.).
clear_demo_notifications() {
  adbs shell cmd statusbar collapse >/dev/null 2>&1 || true
  adbs shell content delete --uri content://call_log/calls >/dev/null 2>&1 || true
  adbs shell am force-stop com.google.android.dialer >/dev/null 2>&1 || true
  adbs shell am force-stop com.google.android.apps.messaging >/dev/null 2>&1 || true
  sleep 1
  # Warm the default SMS app again (cold start after force-stop delays the first notification by
  # several seconds on the software-rendered emulator), then go home.
  adbs shell am start -W -a android.intent.action.MAIN -c android.intent.category.APP_MESSAGING >/dev/null 2>&1 || true
  sleep 1
  adbs shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
  sleep 0.5
}

# File size in bytes (portable: macOS stat first, then GNU).
file_size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }
