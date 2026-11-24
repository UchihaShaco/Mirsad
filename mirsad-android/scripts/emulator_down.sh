#!/usr/bin/env bash
# Stop the media emulator (default emulator-5554). Exits 0 when it is already down.
#
# Usage: scripts/emulator_down.sh
# Env:   SERIAL (default emulator-5554)
#
# `adb emu kill` is the documented way to stop an emulator through its console (adb --help: "emu COMMAND").

source "$(dirname "$0")/_lib.sh"

if ! device_online; then
  log "$SERIAL is not running; nothing to do"
  exit 0
fi

log "Killing $SERIAL"
adbs_t 30 emu kill || true

deadline=$(( $(date +%s) + 60 ))
while (( $(date +%s) < deadline )); do
  device_online || { log "$SERIAL stopped"; exit 0; }
  sleep 2
done
log "WARNING: $SERIAL still listed after 60s"
exit 1
