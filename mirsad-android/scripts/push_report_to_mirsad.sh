#!/usr/bin/env bash
# Sends the newest Mirsad Android scam report from a connected device to the Mirsad portal's
# POST /v1/citizen-reports. Laptop-side only: the phone never does this itself (the app holds no INTERNET permission).
# Officers can also import the same file in the portal with Import report; this script is for a laptop at a desk.
#
# Usage:
#   scripts/push_report_to_mirsad.sh [serial] [--dry-run] [--demo] [--file report.json]
#
#   serial       adb device serial (e.g. emulator-5556); default: the only connected device
#   --dry-run    print the request body instead of posting it (no token needed)
#   --demo       allow a Demo or test report (synthetic: true); the portal labels it Demo and keeps it off the watchlist
#   --file PATH  send a local report JSON instead of pulling one from the device
#
# Environment:
#   MIRSAD_BASE_URL       default http://127.0.0.1:8787
#   MIRSAD_OFFICER_TOKEN  an officer's bearer token, required unless --dry-run; read only here, never printed
#   ADB                   adb binary, default adb on PATH (as in scripts/_lib.sh)
#
# The report is sent exactly as the phone wrote it (docs/EVIDENCE_SCHEMA.md, section 1). Re-runnable: the portal
# answers 200 for a report it already has. Answers: 201 imported, 200 already imported, 400 not a report,
# 422 report_not_accepted (a Demo report without --demo, a false-positive report, another version).
set -euo pipefail

PACKAGE="app.mirsad.shield"
EXTERNAL_DIR="/sdcard/Android/data/$PACKAGE/files/reports"
BASE_URL="${MIRSAD_BASE_URL:-http://127.0.0.1:8787}"
ADB="${ADB:-adb}"
DRY_RUN=0
DEMO=0
SERIAL=""
FILE=""

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --demo) DEMO=1 ;;
    --file) [ $# -ge 2 ] || die "--file needs a path"; FILE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *) SERIAL="$1" ;;
  esac
  shift
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mirsad-push.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPORT="$WORK/report.json"
BODY="$WORK/body.json"
RESP="$WORK/response.json"

adb_cmd() {
  if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" "$@"; else "$ADB" "$@"; fi
}

# --- 1. Get the report -------------------------------------------------------------------------
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "no such file: $FILE"
  cp "$FILE" "$REPORT"
  echo "report: $FILE"
else
  command -v "$ADB" >/dev/null 2>&1 || die "adb not found (set ADB or put adb on PATH)"
  # The app saves under getExternalFilesDir("reports") and falls back to filesDir/reports. Try the private
  # files dir through run-as first (debug builds only), then the external app-specific directory.
  latest="$(adb_cmd exec-out run-as "$PACKAGE" ls -t files/reports 2>/dev/null | tr -d '\r' | grep '\.json$' | head -n 1 || true)"
  if [ -n "$latest" ]; then
    adb_cmd exec-out run-as "$PACKAGE" cat "files/reports/$latest" > "$REPORT"
    echo "pulled: (run-as $PACKAGE) files/reports/$latest"
  else
    latest="$(adb_cmd shell "ls -t $EXTERNAL_DIR 2>/dev/null" | tr -d '\r' | grep '\.json$' | head -n 1 || true)"
    [ -n "$latest" ] || die "no report found on the device; tap Report in Mirsad first (looked in files/reports and $EXTERNAL_DIR)"
    adb_cmd exec-out cat "$EXTERNAL_DIR/$latest" > "$REPORT"
    echo "pulled: $EXTERNAL_DIR/$latest"
  fi
fi
[ -s "$REPORT" ] || die "the report is empty"

# --- 2. Wrap it: { "report": <the file as written>, "demo": true? } ------------------------------
if command -v jq >/dev/null 2>&1; then
  jq --argjson demo "$DEMO" '{ report: . } + (if $demo == 1 then { demo: true } else {} end)' "$REPORT" > "$BODY" \
    || die "the report is not valid JSON"
elif command -v python3 >/dev/null 2>&1; then
  python3 -I - "$REPORT" "$DEMO" > "$BODY" <<'PY' || die "the report is not valid JSON"
import json, sys
body = {"report": json.load(open(sys.argv[1], encoding="utf-8"))}
if sys.argv[2] == "1":
    body["demo"] = True
json.dump(body, sys.stdout, indent=2, ensure_ascii=False)
print()
PY
else
  die "need jq or python3 to build the request body"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run: would POST $BASE_URL/v1/citizen-reports with this body:"
  cat "$BODY"
  exit 0
fi

# --- 3. POST it --------------------------------------------------------------------------------
[ -n "${MIRSAD_OFFICER_TOKEN:-}" ] || die "MIRSAD_OFFICER_TOKEN is required (an officer's bearer token)"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"

echo "posting to $BASE_URL/v1/citizen-reports"
# The token travels in a curl config read from a process substitution: it is never on the command line and never printed.
set +e
http_code="$(curl -sS --fail-with-body --max-time 20 \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$MIRSAD_OFFICER_TOKEN") \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  --data-binary @"$BODY" -o "$RESP" -w '%{http_code}' "$BASE_URL/v1/citizen-reports")"
curl_status=$?
set -e

echo "HTTP ${http_code:-?}"
if [ -s "$RESP" ]; then
  if command -v jq >/dev/null 2>&1; then jq . "$RESP" 2>/dev/null || cat "$RESP"; else cat "$RESP"; fi
  echo
fi
[ "$curl_status" -eq 0 ] || die "import failed (curl exit $curl_status)"
echo "done"
