#!/usr/bin/env bash
# Walk the Mirsad storyboard on the media emulator and capture the screenshots into screenshots/NN_name.png,
# each compressed to < 500 KB, portrait. Re-runnable; overwrites previous captures.
#
# Usage: scripts/capture_screenshots.sh
# Env:   SERIAL (default emulator-5554), STEP_WAIT (seconds to let a screen settle, default 2)
#
# Device commands verified on API 34:
#   am start -n app.mirsad.shield/.MainActivity [--es app.mirsad.shield.extra.SCREEN <screen>]   (adb shell am help)
#   exec-out screencap -p                                   (adb --help "exec-out"; `screencap -h`: "-p  save the file as a png")
#   cmd statusbar expand-notifications | collapse           (adb shell cmd statusbar help)
# Compression: ffmpeg -vf scale=W:-1 -pix_fmt rgb24 -compression_level 9 -pred mixed (ffmpeg -h encoder=png / -h full).
#
# Storyboard (real services: needs scripts/grant_permissions.sh first; autopilot steps are debug-only):
#   02_onboarding            deep link EXTRA_SCREEN=onboarding (after autopilot skip_onboarding + reset)
#   03_demo                  autopilot demo (the sample list)
#   04_held_notice           scam SMS injected, held by the listener; shade expanded (held notice)
#   05_incident              autopilot incident (the held SMS)
#   06_quarantine_not_a_scam after a rejected call and the wrongly-held friend message restored with Not a scam
#   07_report_preview        autopilot report_message (report for the held SMS)
#   01_home                  captured last so it shows real counts and the latest incidents
#   08_home_arabic, 09_demo_arabic, 10_incident_arabic, 11_quarantine_arabic   after set_locale ar

source "$(dirname "$0")/_lib.sh"

STEP_WAIT="${STEP_WAIT:-2}"
MAX_BYTES=$((500 * 1024))
RAW_DIR="$MIRSAD_RUN_DIR/screenshots-raw"
mkdir -p "$RAW_DIR" "$SCREENSHOTS_DIR"

require_device
app_installed || die "$APP_ID is not installed; run scripts/install.sh first"
[[ -x "$FFMPEG" ]] || die "ffmpeg not found at $FFMPEG"

launch_app() {
  # -S: force-stop first so every launch is a fresh Activity with exactly these extras (launchMode
  # singleTop would otherwise keep the previous intent, e.g. screen=onboarding, across recreations).
  local screen="${1:-}"
  if [[ -n "$screen" ]]; then
    adbs shell am start -S -W -n "$MAIN_ACTIVITY" --es "$APP_ID.extra.SCREEN" "$screen" >/dev/null
  else
    adbs shell am start -S -W -n "$MAIN_ACTIVITY" >/dev/null
  fi
}

# capture <name>: raw PNG from the device framebuffer, then compressed into screenshots/<name>.png
capture() {
  local name="$1" raw="$RAW_DIR/$1.png" out="$SCREENSHOTS_DIR/$1.png"
  adbs_t 60 exec-out screencap -p >"$raw"
  [[ -s "$raw" ]] || die "empty screenshot for $name"
  timeout 60 "$FFPROBE" -v error -show_entries stream=width,height -of csv=p=0 "$raw" >/dev/null || die "screencap for $name is not a valid PNG"
  compress_png "$raw" "$out"
  log "captured $name -> $(file_size "$out") bytes"
}

compress_png() {
  local src="$1" dst="$2" w
  for w in 720 600 480 360; do
    timeout 120 "$FFMPEG" -v error -y -i "$src" -vf "scale=$w:-1:flags=lanczos" -pix_fmt rgb24 \
      -compression_level 9 -pred mixed "$dst"
    (( $(file_size "$dst") < MAX_BYTES )) && return 0
    # Same width, 8-bit palette (screens are flat UI; this is usually enough).
    timeout 120 "$FFMPEG" -v error -y -i "$src" \
      -vf "scale=$w:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=none" \
      -compression_level 9 "$dst"
    (( $(file_size "$dst") < MAX_BYTES )) && return 0
  done
  die "could not get $(basename "$dst") under $MAX_BYTES bytes"
}

shade_open()  { adbs shell cmd statusbar expand-notifications; }
shade_close() { adbs shell cmd statusbar collapse; }

# ---- storyboard ----------------------------------------------------------------------------------
# Real flow: the scam SMS and the call go through the notification listener and the call screening service,
# the "restore" step is the wrongly-held friend message, and Home is captured last so it shows real counts.
log "Storyboard start (STEP_WAIT=${STEP_WAIT}s)"
clear_demo_notifications
"$SCRIPTS_DIR/set_locale.sh" en
launch_app
sleep "$STEP_WAIT"
autopilot_step skip_onboarding;            sleep 1
autopilot_step reset;                      sleep "$STEP_WAIT"

launch_app onboarding;                     sleep "$STEP_WAIT"; capture 02_onboarding
launch_app; autopilot_step demo;           sleep "$STEP_WAIT"; capture 03_demo

"$SCRIPTS_DIR/inject_sms.sh" "$SCAM_NUMBER" "$SCAM_SMS"
sleep 4
shade_open; sleep 2;                       capture 04_held_notice
shade_close; sleep 1

autopilot_step incident;                   sleep "$STEP_WAIT"; capture 05_incident
"$SCRIPTS_DIR/inject_call.sh" "$SCAM_NUMBER" 3
autopilot_step restore;                    sleep 5
autopilot_step quarantine;                 sleep "$STEP_WAIT"; capture 06_quarantine_not_a_scam
autopilot_step report_message;             sleep "$STEP_WAIT"; capture 07_report_preview
autopilot_step home;                       sleep "$STEP_WAIT"; capture 01_home

"$SCRIPTS_DIR/set_locale.sh" ar;           sleep "$STEP_WAIT"
autopilot_step home;                       sleep "$STEP_WAIT"; capture 08_home_arabic
autopilot_step demo;                       sleep "$STEP_WAIT"; capture 09_demo_arabic
autopilot_step incident;                   sleep "$STEP_WAIT"; capture 10_incident_arabic
autopilot_step quarantine;                 sleep "$STEP_WAIT"; capture 11_quarantine_arabic

"$SCRIPTS_DIR/set_locale.sh" en
autopilot_step home

log "Screenshots written to $SCREENSHOTS_DIR:"
ls -l "$SCREENSHOTS_DIR"/*.png
