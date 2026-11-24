#!/usr/bin/env bash
# Pushes the newest Mirsad Android scam report from a connected device to the root Mirsad product's
# POST /v1/ingest. Laptop-side only: the phone never does this itself (the app holds no INTERNET permission).
#
# Usage:
#   scripts/push_report_to_mirsad.sh [serial] [--dry-run] [--file report.json]
#
#   serial       adb device serial (e.g. emulator-5556); default: the only connected device
#   --dry-run    print the ingest body instead of posting it (no token needed)
#   --file PATH  map a local report JSON instead of pulling one from the device
#
# Environment:
#   MIRSAD_BASE_URL         default http://127.0.0.1:8787
#   MIRSAD_CONNECTOR_TOKEN  required unless --dry-run; read only here, never printed
#   MIRSAD_SOURCE           telegram (default) | whatsapp: the ingest `source` (the schema has no SMS value)
#   MIRSAD_MAPPER           auto (default) | jq | python: how the report is mapped to the ingest body
#
# The mapping is the one in core/src/main/kotlin/app/mirsad/core/report/MirsadIngestMapper.kt and is documented
# in docs/EVIDENCE_SCHEMA.md. Re-runnable: the service answers 200 (duplicate) for a report it already has.
set -euo pipefail

PACKAGE="app.mirsad.shield"
EXTERNAL_DIR="/sdcard/Android/data/$PACKAGE/files/reports"
BASE_URL="${MIRSAD_BASE_URL:-http://127.0.0.1:8787}"
SOURCE="${MIRSAD_SOURCE:-telegram}"
MAPPER="${MIRSAD_MAPPER:-auto}"
DRY_RUN=0
SERIAL=""
FILE=""

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --file) [ $# -ge 2 ] || die "--file needs a path"; FILE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *) SERIAL="$1" ;;
  esac
  shift
done

case "$SOURCE" in telegram|whatsapp) ;; *) die "MIRSAD_SOURCE must be telegram or whatsapp" ;; esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mirsad-push.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPORT="$WORK/report.json"
BODY="$WORK/body.json"
RESP="$WORK/response.json"

adb_cmd() {
  if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi
}

# --- 1. Get the report -------------------------------------------------------------------------
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "no such file: $FILE"
  cp "$FILE" "$REPORT"
  echo "report: $FILE"
else
  command -v adb >/dev/null 2>&1 || die "adb not found on PATH"
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

# --- 2. Map it to the ingest body (same mapping as MirsadIngestMapper.kt) ----------------------
map_with_jq() {
  jq --arg source "$SOURCE" '
    def cap($n): if length > $n then .[:$n] else . end;
    . as $r
    | (($r.artifacts.sender // "") | ltrimstr(" ") | rtrimstr(" ") | if . == "" then null else . end) as $sender
    | ($sender // $r.fingerprint) as $chatId
    | (if (($r.reasonCodes // []) | length) > 0 then ($r.reasonCodes | join(", ")) else "none" end) as $codes
    | (if $r.text != null then $r.text
       else "Mirsad Android report \($r.reportId): suspected scam, channel \($r.channel), level \($r.level), score \($r.score), reasons: \($codes). Message text withheld by the user."
       end) as $text
    | {
        source: $source,
        externalAccountId: (("mirsad-android:" + $r.reportId) | cap(200)),
        externalChatId: ($chatId | cap(200)),
        chat: { displayLabel: (("Mirsad Android report " + $r.reportId) | cap(200)) },
        event: {
          type: "message.recorded",
          sourceEventId: ($r.reportId | cap(200)),
          sourceMessageId: ($r.reportId | cap(200)),
          direction: "incoming",
          text: ($text | cap(65536)),
          sentAt: $r.createdAt,
          sender: (
            { externalId: ($chatId | cap(200)) }
            + (if $r.artifacts.senderType == "ALPHANUMERIC" and $sender != null then { displayName: ($sender | cap(200)) } else {} end)
            + (if $r.artifacts.senderType == "NUMBER" and $sender != null then
                 { phone: ({ raw: ($sender | cap(64)), internationalFormat: ($sender | startswith("+")) }
                           + (if ($sender | startswith("+971")) then { country: "AE" } else {} end)) }
               else {} end)
          )
        }
      }' "$REPORT"
}

map_with_python() {
  python3 -I - "$REPORT" "$SOURCE" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    r = json.load(f)
source = sys.argv[2]
a = r.get("artifacts") or {}
sender = (a.get("sender") or "").strip() or None
chat_id = sender or r["fingerprint"]
codes = ", ".join(r.get("reasonCodes") or []) or "none"
text = r.get("text")
if text is None:
    text = ("Mirsad Android report %s: suspected scam, channel %s, level %s, score %s, reasons: %s. "
            "Message text withheld by the user." % (r["reportId"], r["channel"], r["level"], r["score"], codes))
sender_obj = {"externalId": chat_id[:200]}
if a.get("senderType") == "ALPHANUMERIC" and sender:
    sender_obj["displayName"] = sender[:200]
if a.get("senderType") == "NUMBER" and sender:
    phone = {"raw": sender[:64], "internationalFormat": sender.startswith("+")}
    if sender.startswith("+971"):
        phone["country"] = "AE"
    sender_obj["phone"] = phone
body = {
    "source": source,
    "externalAccountId": ("mirsad-android:" + r["reportId"])[:200],
    "externalChatId": chat_id[:200],
    "chat": {"displayLabel": ("Mirsad Android report " + r["reportId"])[:200]},
    "event": {
        "type": "message.recorded",
        "sourceEventId": r["reportId"][:200],
        "sourceMessageId": r["reportId"][:200],
        "direction": "incoming",
        "text": text[:65536],
        "sentAt": r["createdAt"],
        "sender": sender_obj,
    },
}
json.dump(body, sys.stdout, indent=2, ensure_ascii=False)
print()
PY
}

case "$MAPPER" in
  auto)
    if command -v jq >/dev/null 2>&1; then MAPPER=jq
    elif command -v python3 >/dev/null 2>&1; then MAPPER=python
    else die "need jq or python3 to build the ingest body"; fi ;;
  jq|python) ;;
  *) die "MIRSAD_MAPPER must be auto, jq or python" ;;
esac
if [ "$MAPPER" = jq ]; then map_with_jq > "$BODY"; else map_with_python > "$BODY"; fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run ($MAPPER): would POST $BASE_URL/v1/ingest with this body:"
  cat "$BODY"
  exit 0
fi

# --- 3. POST it --------------------------------------------------------------------------------
[ -n "${MIRSAD_CONNECTOR_TOKEN:-}" ] || die "MIRSAD_CONNECTOR_TOKEN is required (a connector token provisioned with captureMethod approved_import)"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"

echo "posting to $BASE_URL/v1/ingest (source=$SOURCE, mapper=$MAPPER)"
# The token travels in a curl config read from a process substitution: it is never on the command line and never printed.
set +e
http_code="$(curl -sS --fail-with-body --max-time 20 \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$MIRSAD_CONNECTOR_TOKEN") \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  --data-binary @"$BODY" -o "$RESP" -w '%{http_code}' "$BASE_URL/v1/ingest")"
curl_status=$?
set -e

echo "HTTP ${http_code:-?}"
if [ -s "$RESP" ]; then
  if command -v jq >/dev/null 2>&1; then jq . "$RESP" 2>/dev/null || cat "$RESP"; else cat "$RESP"; fi
  echo
fi
[ "$curl_status" -eq 0 ] || die "ingest failed (curl exit $curl_status)"
echo "done"
