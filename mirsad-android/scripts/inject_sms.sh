#!/usr/bin/env bash
# Inject an incoming SMS into the media emulator through the emulator console.
#
# Usage: scripts/inject_sms.sh <from> <text>
#   e.g. scripts/inject_sms.sh +440000000001 "Emirates Post: your parcel is held ..."
# Env:   SERIAL (default emulator-5554)
#
# Console command (emulator console `help sms`): `sms send <phonenumber> <text>`, sent through
# `adb -s SERIAL emu sms send ...` (adb --help: "emu COMMAND  run emulator console command").
# Quirk: the emulator console accepts digits, '+' and letters in <phonenumber> but alphanumeric sender
# IDs (e.g. "EmiratesPost") are delivered inconsistently by the modem simulator; use numeric senders.

source "$(dirname "$0")/_lib.sh"

[[ $# -ge 2 ]] || { echo "usage: $0 <from> <text>" >&2; exit 2; }
FROM="$1"; shift
TEXT="$*"
require_device

log "SMS from $FROM: ${TEXT:0:60}..."
out="$(adbs_t 30 emu sms send "$FROM" "$TEXT" 2>&1 | tr -d '\r')"
echo "$out" | grep -q '^OK' || { echo "$out" >&2; die "emulator console did not answer OK"; }
log "SMS injected"
