#!/usr/bin/env bash
# Send one autopilot step to the debug build's AutopilotReceiver (workstream C implements the steps).
#
# Usage: scripts/autopilot.sh <step>
#   steps: home, demo_scam, incident, restore, call, report, quarantine, settings, lang_ar, lang_en
# Env:   SERIAL (default emulator-5554)
#
# Broadcast (adb shell am --help: "broadcast [--user <USER_ID> | all | current] <INTENT>",
# intent options "-a <ACTION>", "-n <COMPONENT>", "--es <EXTRA_KEY> <EXTRA_STRING_VALUE>"):
#   am broadcast -a app.mirsad.shield.AUTOPILOT -n app.mirsad.shield/.demo.AutopilotReceiver --es step <step>
# Always exits 0 so capture scripts keep running while the receiver is still a stub.

source "$(dirname "$0")/_lib.sh"

[[ $# -ge 1 ]] || { echo "usage: $0 <step>" >&2; exit 2; }
STEP="$1"
case "$STEP" in
  home|demo_scam|incident|restore|call|report|quarantine|settings|lang_ar|lang_en) ;;
  *) log "WARNING: unknown step '$STEP' (sending anyway)" ;;
esac

if ! device_online; then
  log "WARNING: $SERIAL not online; autopilot step '$STEP' skipped"
  exit 0
fi

out="$(adbs_t 30 shell am broadcast -a "$AUTOPILOT_ACTION" -n "$AUTOPILOT_RECEIVER" --es step "$STEP" 2>&1 | tr -d '\r' || true)"
if echo "$out" | grep -q 'Broadcast completed'; then
  log "autopilot step '$STEP' delivered ($(echo "$out" | grep -o 'result=[0-9-]*' | head -1))"
else
  log "WARNING: autopilot step '$STEP' not delivered: $(echo "$out" | tail -1)"
fi
exit 0
