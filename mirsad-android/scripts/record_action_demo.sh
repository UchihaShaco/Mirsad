#!/usr/bin/env bash
# Records the live side-by-side demo: two emulators receive the same scam SMS and the same scam call at the same time.
# LEFT has no Mirsad (disabled), RIGHT runs Mirsad with all permissions. Both screens are recorded with screenrecord,
# then scripts/make_action_video.py puts them side by side with short captions.
#
# Usage: scripts/record_action_demo.sh [out_dir]
# Env:   LEFT (default emulator-5558, Mirsad disabled), RIGHT (default emulator-5560, Mirsad installed + granted)
source "$(dirname "$0")/_lib.sh"
LEFT="${LEFT:-emulator-5558}"; RIGHT="${RIGHT:-emulator-5560}"
OUT="${1:-$MIRSAD_RUN_DIR/action}"; mkdir -p "$OUT"
REC=20
on() { local s="$1"; shift; timeout 30 "$ADB" -s "$s" "$@"; }
ap() { on "$RIGHT" shell am broadcast -a "$AUTOPILOT_ACTION" -n "$AUTOPILOT_RECEIVER" --es step "$1" >/dev/null 2>&1 || true; }

# Tap the first on-screen element whose text starts with $2 (real tap, like a person).
tap_text() {
  local s="$1" prefix="$2"
  on "$s" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
  local b; b="$(on "$s" exec-out cat /sdcard/ui.xml | "$PYTHON" -I -c '
import sys,re
xml=sys.stdin.read(); p=sys.argv[1]
for m in re.finditer(r"text=\"([^\"]*)\"[^>]*?bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"",xml):
    if m.group(1).replace("⁦","").replace("⁩","").startswith(p):
        x1,y1,x2,y2=map(int,m.groups()[1:]); print((x1+x2)//2,(y1+y2)//2); break' "$prefix")"
  [[ -n "$b" ]] || return 1
  on "$s" shell input tap $b
}

prepare() {
  for s in "$LEFT" "$RIGHT"; do
    on "$s" shell cmd statusbar collapse >/dev/null 2>&1 || true
    on "$s" shell content delete --uri content://call_log/calls >/dev/null 2>&1 || true
    on "$s" shell am force-stop com.google.android.dialer >/dev/null 2>&1 || true
    on "$s" shell am force-stop com.google.android.apps.messaging >/dev/null 2>&1 || true
    on "$s" shell input keyevent 224 >/dev/null 2>&1 || true
    on "$s" shell rm -f /sdcard/action.mp4 >/dev/null 2>&1 || true
  done
  sleep 1
  for s in "$LEFT" "$RIGHT"; do  # warm the SMS app so its notification is immediate
    on "$s" shell am start -W -n com.google.android.apps.messaging/.ui.ConversationListActivity >/dev/null 2>&1 || true
  done
  sleep 2
  on "$LEFT" shell input keyevent 3
  on "$RIGHT" shell am start -S -W -n "$MAIN_ACTIVITY" >/dev/null; sleep 2
  ap skip_onboarding; sleep 1; ap reset; sleep 3
}

prepare
log "recording $LEFT (without) and $RIGHT (with) for ${REC}s"
for s in "$LEFT" "$RIGHT"; do
  timeout $((REC + 30)) "$ADB" -s "$s" shell screenrecord --time-limit "$REC" --bit-rate 8000000 /sdcard/action.mp4 \
    >"$OUT/screenrecord-$s.log" 2>&1 &
done
for s in "$LEFT" "$RIGHT"; do
  dl=$((SECONDS + 15)); until on "$s" shell ls /sdcard/action.mp4 >/dev/null 2>&1; do (( SECONDS < dl )) && sleep 0.2 || break; done
done
T0=$SECONDS
# Run a command on both phones at once; wait only for those two (not for the screen recorders).
both() { local pids=() s; for s in "$LEFT" "$RIGHT"; do on "$s" "$@" >/dev/null 2>&1 & pids+=($!); done; wait "${pids[@]}"; }
at() { local target=$(( T0 + $1 )); while (( SECONDS < target )); do sleep 0.1; done; log "t=$1 $2"; }

at 2  "scam SMS to both"
both emu sms send "$SCAM_NUMBER" "$SCAM_SMS"
at 4  "shade open on both";  both shell cmd statusbar expand-notifications
at 7  "right: tap the Mirsad notice"
tap_text "$RIGHT" "Held 1 suspicious" || { on "$RIGHT" shell cmd statusbar collapse; ap incident; }
on "$LEFT" shell cmd statusbar collapse
at 9  "scam call to both";   both emu gsm call "$SCAM_NUMBER"
at 11 "right: shade";        on "$RIGHT" shell cmd statusbar expand-notifications
at 15 "cancel calls";        both emu gsm cancel "$SCAM_NUMBER"
on "$RIGHT" shell cmd statusbar collapse; ap report_message
at $REC "end"
sleep 6
for s in "$LEFT" "$RIGHT"; do on "$s" pull /sdcard/action.mp4 "$OUT/$s.mp4" >/dev/null; done
ls -la "$OUT"
