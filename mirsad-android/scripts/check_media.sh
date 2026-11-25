#!/usr/bin/env bash
# Assert the media deliverables and print a table. Exit 1 on any failure.
#   screenshots/NN_name.png : at least 8 files, each < 500 KB, valid PNG, portrait (height > width)
#   demo/mirsad-android-demo.mp4 (+ -ar.mp4): H.264, yuv420p, no audio stream, even dimensions, duration <= 20.0 s, < 15 MB
#   demo/mirsad-android-demo.gif : GIF, < 8 MB
#
# Usage: scripts/check_media.sh
# Needs ffprobe only (no device). Flags from `ffprobe -h`: -v -select_streams -show_entries -of.

source "$(dirname "$0")/_lib.sh"

[[ -x "$FFPROBE" ]] || die "ffprobe not found at $FFPROBE"
MAX_PNG=$((500 * 1024)); MAX_MP4=$((15 * 1024 * 1024)); MAX_GIF=$((8 * 1024 * 1024))
fail=0
rows=()
row() { rows+=("$(printf '%-34s %-10s %-11s %-9s %s' "$1" "$2" "$3" "$4" "$5")"); }
bad() { fail=1; log "FAIL: $*"; }

probe() { timeout 60 "$FFPROBE" -v error -select_streams v:0 -show_entries "stream=$2" -of csv=p=0 "$1" 2>/dev/null | head -1 | tr -d '\r'; }

# ---- screenshots ----------------------------------------------------------------------------------
shopt -s nullglob
pngs=("$SCREENSHOTS_DIR"/[0-9][0-9]_*.png)
shopt -u nullglob
if (( ${#pngs[@]} < 8 )); then bad "only ${#pngs[@]} screenshots in $SCREENSHOTS_DIR (need >= 8)"; fi
for f in "${pngs[@]}"; do
  size="$(file_size "$f")"; wh="$(probe "$f" width,height)"; w="${wh%%,*}"; h="${wh##*,}"
  status=OK
  [[ "$(probe "$f" codec_name)" == "png" ]] || { status=FAIL; bad "$(basename "$f") is not a PNG"; }
  (( size < MAX_PNG )) || { status=FAIL; bad "$(basename "$f") is $size bytes (>= $MAX_PNG)"; }
  [[ -n "$w" && -n "$h" ]] && (( h > w )) || { status=FAIL; bad "$(basename "$f") is not portrait (${w}x${h})"; }
  row "screenshots/$(basename "$f")" "${w}x${h}" "$size B" "-" "$status"
done

# ---- video ----------------------------------------------------------------------------------------
mp4="$DEMO_DIR/mirsad-android-demo.mp4"
if [[ -f "$mp4" ]]; then
  size="$(file_size "$mp4")"
  dur="$(timeout 60 "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$mp4" | tr -d '\r')"
  wh="$(probe "$mp4" width,height)"; w="${wh%%,*}"; h="${wh##*,}"
  codec="$(probe "$mp4" codec_name)"; pix="$(probe "$mp4" pix_fmt)"
  audio="$(timeout 60 "$FFPROBE" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$mp4" | tr -d '\r')"
  status=OK
  [[ "$codec" == "h264" ]] || { status=FAIL; bad "mp4 codec is '$codec', not h264"; }
  [[ "$pix" == "yuv420p" ]] || { status=FAIL; bad "mp4 pix_fmt is '$pix', not yuv420p"; }
  [[ -z "$audio" ]] || { status=FAIL; bad "mp4 has an audio stream"; }
  (( size < MAX_MP4 )) || { status=FAIL; bad "mp4 is $size bytes (>= $MAX_MP4)"; }
  (( w % 2 == 0 && h % 2 == 0 )) || { status=FAIL; bad "mp4 has odd dimensions ${w}x${h}"; }
  (( w >= 1280 )) || { status=FAIL; bad "mp4 is narrower than 1280 px (${w}x${h})"; }
  "$PYTHON" -I -c 'import sys; sys.exit(0 if 0 < float(sys.argv[1]) <= 20.0 else 1)' "$dur" || { status=FAIL; bad "mp4 duration ${dur}s is not within (0, 20.0]"; }
  row "demo/mirsad-android-demo.mp4" "${w}x${h}" "$size B" "${dur}s" "$status"
else
  bad "missing $mp4"; row "demo/mirsad-android-demo.mp4" "-" "-" "-" "MISSING"
fi

# ---- gif ------------------------------------------------------------------------------------------
gif="$DEMO_DIR/mirsad-android-demo.gif"
if [[ -f "$gif" ]]; then
  size="$(file_size "$gif")"
  wh="$(probe "$gif" width,height)"; w="${wh%%,*}"; h="${wh##*,}"
  dur="$(timeout 60 "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$gif" | tr -d '\r')"
  status=OK
  [[ "$(probe "$gif" codec_name)" == "gif" ]] || { status=FAIL; bad "gif is not a GIF"; }
  (( size < MAX_GIF )) || { status=FAIL; bad "gif is $size bytes (>= $MAX_GIF)"; }
  row "demo/mirsad-android-demo.gif" "${w}x${h}" "$size B" "${dur}s" "$status"
else
  bad "missing $gif"; row "demo/mirsad-android-demo.gif" "-" "-" "-" "MISSING"
fi

# ---- table ----------------------------------------------------------------------------------------
printf '%-34s %-10s %-11s %-9s %s\n' "file" "size(px)" "bytes" "duration" "status"
printf '%s\n' "${rows[@]}"
echo "screenshots: ${#pngs[@]} (need >= 8, each < 500 KB, portrait); mp4 <= 20.0 s and < 15 MB; gif < 8 MB"
if (( fail )); then echo "check_media: FAIL"; exit 1; fi
echo "check_media: PASS"
