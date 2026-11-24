#!/usr/bin/env bash
# Simulate an incoming GSM call on the media emulator, keep it ringing for a few seconds, then cancel it.
#
# Usage: scripts/inject_call.sh <number> [seconds]      (default 4 s ringing)
#   e.g. scripts/inject_call.sh +440000000001 5
# Env:   SERIAL (default emulator-5554)
#
# Console commands (emulator console `help gsm`): `gsm call <phonenumber>` starts an inbound call,
# `gsm cancel <phonenumber>` ends it. Sent through `adb -s SERIAL emu gsm ...`.
# When Mirsad holds the CALL_SCREENING role and rejects the call, the dialer never rings; `gsm cancel`
# then just cleans the modem state (the emulator answers OK either way).

source "$(dirname "$0")/_lib.sh"

[[ $# -ge 1 ]] || { echo "usage: $0 <number> [seconds]" >&2; exit 2; }
NUMBER="$1"
RING_SECONDS="${2:-4}"
require_device

log "Incoming call from $NUMBER for ${RING_SECONDS}s"
out="$(adbs_t 30 emu gsm call "$NUMBER" 2>&1 | tr -d '\r')"
echo "$out" | grep -q '^OK' || { echo "$out" >&2; die "gsm call was not accepted by the console"; }
sleep "$RING_SECONDS"
adbs_t 30 emu gsm cancel "$NUMBER" >/dev/null 2>&1 || true
log "Call cancelled"
