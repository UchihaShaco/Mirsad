#!/usr/bin/env bash
# Captures the seven real phone frames for the 20-second explainer (scripts/make_explainer.py) on the media emulator.
# The scam SMS and the call go through the real notification listener and call screening service; the "without
# Mirsad" frame is taken with Mirsad's notification access switched off for a moment.
#
# Usage: scripts/capture_explainer_frames.sh [out_dir]      (default: $MIRSAD_RUN_DIR/explainer-frames)
# Needs: the APK installed and scripts/grant_permissions.sh run (SERIAL, default emulator-5554).
source "$(dirname "$0")/_lib.sh"

OUT="${1:-$MIRSAD_RUN_DIR/explainer-frames}"
mkdir -p "$OUT"
require_device
app_installed || die "$APP_ID is not installed; run scripts/install.sh first"
LISTENER="$APP_ID/$APP_ID.service.MirsadNotificationListener"
cap() { adbs_t 60 exec-out screencap -p >"$OUT/$1.png"; [[ -s "$OUT/$1.png" ]] || die "empty frame $1"; log "frame $1"; }
launch() { adbs shell am start -S -W -n "$MAIN_ACTIVITY" >/dev/null; }

clear_demo_notifications
"$SCRIPTS_DIR/set_locale.sh" en
launch; sleep 2
autopilot_step skip_onboarding; sleep 1
autopilot_step reset; sleep 3
cap s1_home

# Without Mirsad: the scam notification lands like any other.
adbs shell cmd notification disallow_listener "$LISTENER"; sleep 2
adbs shell input keyevent 3; sleep 1
"$SCRIPTS_DIR/inject_sms.sh" "$SCAM_NUMBER" "$SCAM_SMS"; sleep 5
adbs shell cmd statusbar expand-notifications; sleep 2; cap s2_sms_arrives
adbs shell cmd statusbar collapse
clear_demo_notifications

# With Mirsad.
adbs shell cmd notification allow_listener "$LISTENER"; sleep 1
launch; sleep 4
"$SCRIPTS_DIR/inject_sms.sh" "$SCAM_NUMBER" "$SCAM_SMS"; sleep 6
adbs shell cmd statusbar expand-notifications; sleep 2; cap s3_held
adbs shell cmd statusbar collapse; sleep 1
autopilot_step incident; sleep 3; cap s4_incident
"$SCRIPTS_DIR/inject_call.sh" "$SCAM_NUMBER" 3; sleep 1
autopilot_step incident; sleep 3; cap s5_call
autopilot_step restore; sleep 4; cap s6_restore
autopilot_step report_message; sleep 3; cap s7_report
log "frames in $OUT"
echo "$OUT"
