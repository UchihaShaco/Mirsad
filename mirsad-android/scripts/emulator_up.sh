#!/usr/bin/env bash
# Create (if missing) and boot (if not running) the media emulator `mirsad_media` on console port 5554,
# headless, then wait for sys.boot_completed, unlock, disable animations, set 24 h clock and English.
#
# Usage: scripts/emulator_up.sh
# Env:   SERIAL (default emulator-5554), AVD_NAME (default mirsad_media), BOOT_TIMEOUT (default 180 s),
#        ANDROID_HOME, AVDMANAGER (see scripts/_lib.sh)
#
# Idempotent: re-running against a booted emulator only re-applies the device settings.
# The emulator runs in the background (nohup) and keeps running after this script exits;
# stop it with scripts/emulator_down.sh.
#
# Flags verified against `emulator -help`: -avd -port -no-window -no-audio -no-boot-anim -no-snapshot -gpu.
# avdmanager: `create avd -n -k -d` (`avdmanager create avd` without -h prints the option list).
# Note: `avdmanager list avd` hangs when another AVD is running, so presence is checked with
# `emulator -list-avds` instead.

source "$(dirname "$0")/_lib.sh"

AVD_NAME="${AVD_NAME:-mirsad_media}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-180}"
SYSIMG="system-images;android-34;google_apis;arm64-v8a"
PORT="${SERIAL#emulator-}"
AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
AVD_DIR="$AVD_HOME/$AVD_NAME.avd"
EMU_LOG="$MIRSAD_RUN_DIR/emulator-$PORT.log"

[[ -x "$EMULATOR_BIN" ]] || die "emulator binary not found at $EMULATOR_BIN"
[[ -x "$ADB" ]] || die "adb not found at $ADB"

# ---- 1. AVD ---------------------------------------------------------------------------------------
avd_exists() { timeout 60 "$EMULATOR_BIN" -list-avds 2>/dev/null | grep -qx "$AVD_NAME"; }

# Set or replace `key = value` in an AVD config.ini (keeps other keys, appends when missing).
set_ini() {
  local file="$1" key="$2" value="$3"
  "$PYTHON" -I - "$file" "$key" "$value" <<'PY'
import sys, re
path, key, value = sys.argv[1:4]
lines = open(path, encoding="utf-8").read().splitlines() if __import__("os").path.exists(path) else []
pat = re.compile(r"^\s*" + re.escape(key) + r"\s*=")
out, hit = [], False
for l in lines:
    if pat.match(l):
        if not hit:
            out.append(f"{key} = {value}"); hit = True
    else:
        out.append(l)
if not hit:
    out.append(f"{key} = {value}")
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
}

create_avd() {
  log "Creating AVD $AVD_NAME ($SYSIMG)"
  [[ -x "$AVDMANAGER" ]] || die "avdmanager not found at $AVDMANAGER"
  local dev ok=0
  for dev in pixel_6 pixel_3a ""; do
    local args=(create avd -n "$AVD_NAME" -k "$SYSIMG")
    [[ -n "$dev" ]] && args+=(-d "$dev")
    # avdmanager asks "Do you wish to create a custom hardware profile? [no]" -> answer no.
    if echo no | timeout 120 "$AVDMANAGER" "${args[@]}" >>"$MIRSAD_RUN_DIR/avdmanager.log" 2>&1; then
      log "AVD created with device profile '${dev:-<none>}'"; ok=1; break
    fi
    log "avdmanager create with device '${dev:-<none>}' failed, trying next (see $MIRSAD_RUN_DIR/avdmanager.log)"
  done
  [[ $ok -eq 1 ]] || die "could not create AVD $AVD_NAME"
}

# Hardware profile, applied once right after creation (the emulator normalises and rewrites config.ini
# on every boot, e.g. the data partition size; re-applying would fight it):
# Pixel-6-like 1080x2400 portrait, keyboard, 4 GB data, GPU on.
apply_hw_profile() {
  local ini="$AVD_DIR/config.ini"
  set_ini "$ini" hw.keyboard yes
  set_ini "$ini" disk.dataPartition.size 4G
  set_ini "$ini" hw.lcd.width 1080
  set_ini "$ini" hw.lcd.height 2400
  set_ini "$ini" hw.lcd.density 420
  set_ini "$ini" hw.gpu.enabled yes
  set_ini "$ini" hw.gpu.mode auto
  set_ini "$ini" hw.ramSize 2048
  set_ini "$ini" hw.initialOrientation portrait
  set_ini "$ini" hw.mainKeys no
  set_ini "$ini" hw.gsmModem yes
  set_ini "$ini" showDeviceFrame no
  set_ini "$ini" skin.dynamic yes
  set_ini "$ini" skin.name 1080x2400
  set_ini "$ini" skin.path _no_skin
  set_ini "$ini" fastboot.forceColdBoot yes
}

if ! avd_exists; then
  create_avd
  [[ -f "$AVD_DIR/config.ini" ]] || die "AVD config not found at $AVD_DIR/config.ini"
  apply_hw_profile
fi
[[ -f "$AVD_DIR/config.ini" ]] || die "AVD config not found at $AVD_DIR/config.ini"

# Quirk: avdmanager 11.0 writes image.sysdir.1 relative to $HOME ("Library/Android/sdk/system-images/...")
# when the SDK sits under the home folder; the emulator then fails with "Broken AVD system path".
# Pin it to the SDK-relative form the emulator expects (idempotent, applied on every run).
set_ini "$AVD_DIR/config.ini" image.sysdir.1 "system-images/android-34/google_apis/arm64-v8a/"

# ---- 2. Boot --------------------------------------------------------------------------------------
if device_online; then
  running_avd="$(adbs emu avd name 2>/dev/null | head -1 | tr -d '\r' || true)"
  log "$SERIAL already online (avd: ${running_avd:-unknown}); reusing it"
else
  log "Booting $AVD_NAME headless on port $PORT (log: $EMU_LOG)"
  nohup "$EMULATOR_BIN" -avd "$AVD_NAME" -port "$PORT" \
    -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
    >"$EMU_LOG" 2>&1 </dev/null &
  disown || true
fi

log "Waiting up to ${BOOT_TIMEOUT}s for sys.boot_completed on $SERIAL"
deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
booted=0
while (( $(date +%s) < deadline )); do
  if device_online; then
    v="$(adbs_t 10 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$v" == "1" ]]; then booted=1; break; fi
  fi
  if ! pgrep -f "qemu-system.*-port $PORT" >/dev/null && ! pgrep -f "emulator.*-port $PORT" >/dev/null; then
    if ! device_online; then
      sleep 2
      if ! device_online && [[ -f "$EMU_LOG" ]] && grep -qiE 'ERROR|panic' "$EMU_LOG"; then
        tail -20 "$EMU_LOG" >&2; die "emulator process exited before boot"
      fi
    fi
  fi
  sleep 3
done
[[ $booted -eq 1 ]] || { [[ -f "$EMU_LOG" ]] && tail -30 "$EMU_LOG" >&2; die "boot timed out after ${BOOT_TIMEOUT}s"; }
log "Boot completed"

# ---- 3. Device settings (idempotent) --------------------------------------------------------------
adbs shell input keyevent 82 >/dev/null 2>&1 || true            # dismiss keyguard
adbs shell settings put global window_animation_scale 0
adbs shell settings put global transition_animation_scale 0
adbs shell settings put global animator_duration_scale 0
adbs shell settings put system time_12_24 24
adbs shell settings put system screen_off_timeout 1800000
adbs shell settings put global stay_on_while_plugged_in 7
adbs shell svc power stayon true >/dev/null 2>&1 || true
adbs shell locksettings set-disabled true >/dev/null 2>&1 || true
# Clean status bar for captures: SystemUI demo mode (fixed clock, full battery, no mobile icons noise).
adbs shell settings put global sysui_demo_allowed 1
adbs shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null
adbs shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200 >/dev/null
adbs shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null
adbs shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4 >/dev/null

# English locale by default (google_apis images boot en-US; only act when something else is set).
cur_locale="$(adbs shell getprop persist.sys.locale 2>/dev/null | tr -d '\r' || true)"
if [[ -n "$cur_locale" && "$cur_locale" != en* ]]; then
  log "Device locale is '$cur_locale'; resetting to en-US"
  adbs shell setprop persist.sys.locale en-US
  adbs shell setprop ctl.restart zygote
  sleep 5
  deadline=$(( $(date +%s) + 90 ))
  while (( $(date +%s) < deadline )); do
    v="$(adbs_t 10 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    [[ "$v" == "1" ]] && break
    sleep 3
  done
  adbs shell input keyevent 82 >/dev/null 2>&1 || true
fi

log "$SERIAL ready: $(adbs shell getprop ro.build.version.release | tr -d '\r') / sdk $(adbs shell getprop ro.build.version.sdk | tr -d '\r') / $(adbs shell wm size | tr -d '\r') / locale ${cur_locale:-en-US}"
