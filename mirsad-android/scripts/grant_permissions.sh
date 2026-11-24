#!/usr/bin/env bash
# Grant Mirsad what it needs on the media emulator without touching the UI:
#   - POST_NOTIFICATIONS runtime permission
#   - notification-listener access for MirsadNotificationListener
#   - the CALL_SCREENING role
# Then print the verification output. Idempotent.
#
# Usage: scripts/grant_permissions.sh
# Env:   SERIAL (default emulator-5554)
#
# Device commands (verified with `adb shell cmd notification` / `cmd role` help output on API 34):
#   pm grant PKG PERMISSION
#   cmd notification allow_listener COMPONENT [user_id]
#   cmd role add-role-holder [--user USER_ID] ROLE PACKAGE [FLAGS]
#   cmd role get-role-holders [--user USER_ID] ROLE

source "$(dirname "$0")/_lib.sh"

require_device
app_installed || die "$APP_ID is not installed; run scripts/install.sh first"

log "pm grant POST_NOTIFICATIONS"
adbs shell pm grant "$APP_ID" android.permission.POST_NOTIFICATIONS || log "WARNING: pm grant POST_NOTIFICATIONS failed (maybe already granted or not declared)"

log "cmd notification allow_listener $LISTENER_COMPONENT"
adbs shell cmd notification allow_listener "$LISTENER_COMPONENT" || log "WARNING: allow_listener failed"

log "cmd role add-role-holder android.app.role.CALL_SCREENING $APP_ID"
adbs shell cmd role add-role-holder android.app.role.CALL_SCREENING "$APP_ID" || log "WARNING: add-role-holder failed"

echo "---- verification ----"
# On API 33+ the approved listeners live in the notification manager's managed-services state
# (dumpsys notification), not in the legacy secure setting; `cmd notification` has no list verb.
# Buffer dumpsys output before grepping: with pipefail, `grep -m1` would SIGPIPE adb (exit 141).
notif_dump="$(adbs shell dumpsys notification 2>/dev/null | tr -d '\r' || true)"
pkg_dump="$(adbs shell dumpsys package "$APP_ID" 2>/dev/null | tr -d '\r' || true)"
allowed="$(printf '%s\n' "$notif_dump" | grep -A1 'Allowed notification listeners:' | sed -n '2p' | sed 's/^ *//')"
holders="$(adbs shell cmd role get-role-holders android.app.role.CALL_SCREENING | tr -d '\r')"
echo "POST_NOTIFICATIONS: $(printf '%s\n' "$pkg_dump" | grep 'android.permission.POST_NOTIFICATIONS' | sed -n '1p' | sed 's/^ *//')"
echo "Allowed notification listeners: $allowed"
echo "cmd role get-role-holders android.app.role.CALL_SCREENING: $holders"

status=0
echo "$allowed" | grep -q "$LISTENER_COMPONENT" || { log "WARNING: $LISTENER_COMPONENT is not an allowed listener"; status=1; }
echo "$holders" | grep -q "$APP_ID" || { log "WARNING: $APP_ID does not hold CALL_SCREENING"; status=1; }
[[ $status -eq 0 ]] && log "All grants verified"
exit $status
