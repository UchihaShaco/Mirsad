#!/usr/bin/env bash
# Record the 30 s Mirsad demo on the media emulator and produce demo/mirsad-android-demo.mp4 (H.264, no audio,
# 720 px wide, <= 30.0 s, < 15 MB) and demo/mirsad-android-demo.gif (10 fps, 360 px wide, < 8 MB).
#
# Usage: scripts/record_video.sh
# Env:   SERIAL (default emulator-5554)
#
# Device: `screenrecord --time-limit 30 --bit-rate 6000000 /sdcard/mirsad.mp4` (flags from `screenrecord --help`),
#         started in the background while the timed storyboard runs, then `adb pull`.
# ffmpeg: -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 23 -vf scale=720:-2 -t 30  (ffmpeg -h / -h encoder=libx264)
#         GIF: fps=10,scale=360:-1,split,palettegen,paletteuse (ffmpeg -filters)
# ffprobe: -v error -show_entries format=duration -of csv=p=0
#
# Storyboard (seconds from the start of the recording):
#    0-3   home, protection on                          (autopilot home)
#    3-10  parcel-fee SMS arrives and is held           (inject_sms + shade expand/collapse)
#   10-16  incident with reasons and timing             (autopilot incident)
#   16-21  a wrongly held legitimate message restored with Not a scam  (autopilot restore)
#   21-26  call from the scam number is rejected by call screening     (inject_call + autopilot incident)
#   26-30  report preview for the held message                         (autopilot report_message)
# The SMS and the call go through the real notification listener and call screening service
# (run scripts/grant_permissions.sh first); the autopilot only navigates.

source "$(dirname "$0")/_lib.sh"

DEVICE_MP4="/sdcard/mirsad.mp4"
RAW_MP4="$MIRSAD_RUN_DIR/mirsad-raw.mp4"
OUT_MP4="$DEMO_DIR/mirsad-android-demo.mp4"
OUT_GIF="$DEMO_DIR/mirsad-android-demo.gif"
MAX_MP4_BYTES=$((15 * 1024 * 1024))
MAX_GIF_BYTES=$((8 * 1024 * 1024))
RECORD_SECONDS=30
mkdir -p "$DEMO_DIR"

require_device
app_installed || die "$APP_ID is not installed; run scripts/install.sh first"
[[ -x "$FFMPEG" && -x "$FFPROBE" ]] || die "ffmpeg/ffprobe not found ($FFMPEG, $FFPROBE)"

# ---- prepare: English, clean shade, home screen, no stale recording -------------------------------
clear_demo_notifications
"$SCRIPTS_DIR/set_locale.sh" en
adbs shell am start -S -W -n "$MAIN_ACTIVITY" >/dev/null
autopilot_step skip_onboarding; sleep 1
autopilot_step reset
adbs shell rm -f "$DEVICE_MP4" >/dev/null 2>&1 || true
sleep 3

# Wall-clock aligned storyboard: at <t> seconds after T0 (integer seconds is fine for this cut).
at() { local target=$(( T0 + $1 )); while (( SECONDS < target )); do sleep 0.2; done; log "t=$1s: $2"; }

# ---- record ---------------------------------------------------------------------------------------
log "screenrecord --time-limit $RECORD_SECONDS --bit-rate 6000000 $DEVICE_MP4"
timeout $((RECORD_SECONDS + 40)) "$ADB" -s "$SERIAL" shell screenrecord --time-limit "$RECORD_SECONDS" --bit-rate 6000000 "$DEVICE_MP4" \
  >"$MIRSAD_RUN_DIR/screenrecord.log" 2>&1 &
REC_PID=$!
# T0 = the moment screenrecord has opened its output file (encoder up), so the storyboard timeline
# matches the video timeline instead of starting during encoder setup.
deadline=$(( SECONDS + 15 ))
until adbs_t 5 shell ls "$DEVICE_MP4" >/dev/null 2>&1; do (( SECONDS < deadline )) && sleep 0.2 || break; done
T0=$SECONDS

at 0  "home with protection on"
at 3  "scam SMS arrives";         "$SCRIPTS_DIR/inject_sms.sh" "$SCAM_NUMBER" "$SCAM_SMS"
at 6  "shade: held notice";       adbs shell cmd statusbar expand-notifications
at 10 "shade collapse";           adbs shell cmd statusbar collapse
at 10 "incident";                 autopilot_step incident
at 16 "restore (Not a scam)";     autopilot_step restore
at 21 "call rejected";            "$SCRIPTS_DIR/inject_call.sh" "$SCAM_NUMBER" 3 &
at 23 "rejected call incident";   autopilot_step incident
at 26 "report preview";           autopilot_step report_message
at 30 "end of storyboard"

# screenrecord stops itself at the time limit; wait for the adb process (bounded).
deadline=$(( SECONDS + 40 ))
while kill -0 "$REC_PID" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
if kill -0 "$REC_PID" 2>/dev/null; then kill "$REC_PID" 2>/dev/null || true; fi
wait "$REC_PID" 2>/dev/null || true
wait 2>/dev/null || true
sleep 1

adbs_t 120 pull "$DEVICE_MP4" "$RAW_MP4" >/dev/null
[[ -s "$RAW_MP4" ]] || die "screenrecord produced no file (see $MIRSAD_RUN_DIR/screenrecord.log)"
raw_dur="$(timeout 60 "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$RAW_MP4")"
log "raw recording: $(file_size "$RAW_MP4") bytes, ${raw_dur}s"

# ---- encode mp4 -----------------------------------------------------------------------------------
probe_duration() { timeout 60 "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$1"; }
duration_ok() { "$PYTHON" -I -c 'import sys; sys.exit(0 if float(sys.argv[1]) <= 30.0 else 1)' "$1"; }

# screenrecord only emits frames when the display changes, so a static ending shortens the raw clip;
# tpad clones the last frame up to the full length, then -t cuts to exactly <t> seconds (ffmpeg -h filter=tpad).
encode_mp4() {
  local crf="$1" width="$2" t="$3"
  timeout 300 "$FFMPEG" -v error -y -i "$RAW_MP4" -an -c:v libx264 -preset medium -crf "$crf" \
    -pix_fmt yuv420p -movflags +faststart \
    -vf "scale=$width:-2:flags=lanczos,fps=30,tpad=stop_mode=clone:stop_duration=$RECORD_SECONDS" \
    -t "$t" "$OUT_MP4"
}

ok=0
for attempt in "23 720 30" "23 720 29.9" "26 720 29.9" "28 640 29.9" "30 540 29.9"; do
  set -- $attempt
  encode_mp4 "$1" "$2" "$3"
  dur="$(probe_duration "$OUT_MP4")"; size="$(file_size "$OUT_MP4")"
  log "mp4 crf=$1 width=$2: ${dur}s, $size bytes"
  if duration_ok "$dur" && (( size < MAX_MP4_BYTES )); then ok=1; break; fi
done
[[ $ok -eq 1 ]] || die "could not fit the mp4 within 30.0 s / 15 MB"

# ---- gif ------------------------------------------------------------------------------------------
encode_gif() {
  local fps="$1" width="$2" colors="$3"
  timeout 300 "$FFMPEG" -v error -y -i "$OUT_MP4" \
    -vf "fps=$fps,scale=$width:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=$colors:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$OUT_GIF"
}
ok=0
for attempt in "10 360 128" "10 360 64" "8 320 64" "6 320 48"; do
  set -- $attempt
  encode_gif "$1" "$2" "$3"
  size="$(file_size "$OUT_GIF")"
  log "gif fps=$1 width=$2 colors=$3: $size bytes"
  (( size < MAX_GIF_BYTES )) && { ok=1; break; }
done
[[ $ok -eq 1 ]] || die "could not fit the gif under 8 MB"

log "Wrote $OUT_MP4 and $OUT_GIF"
