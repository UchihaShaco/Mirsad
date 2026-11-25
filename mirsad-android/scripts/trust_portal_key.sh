#!/usr/bin/env bash
# Adds a Mirsad portal's blocklist signing key to app/src/main/assets/trusted_blocklist_keys.json, so a build of the
# app accepts that portal's signed blocklists. Run before building the APK for a deployment.
#
#   MIRSAD_OFFICER_TOKEN=... scripts/trust_portal_key.sh [base-url]     # default http://127.0.0.1:8787
#   scripts/trust_portal_key.sh --file key.json                         # a key saved from GET /v1/watchlist/blocklist-key
#
# The key is public: it can only verify signatures. The token is read from the environment and never printed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ASSET="$HERE/app/src/main/assets/trusted_blocklist_keys.json"
die() { echo "error: $*" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || die "python3 is required"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mirsad-key.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
if [ "${1:-}" = "--file" ]; then
  [ -f "${2:-}" ] || die "--file needs a path"
  cp "$2" "$WORK/key.json"
else
  BASE_URL="${1:-${MIRSAD_BASE_URL:-http://127.0.0.1:8787}}"
  [ -n "${MIRSAD_OFFICER_TOKEN:-}" ] || die "MIRSAD_OFFICER_TOKEN is required"
  curl -sS --fail-with-body --max-time 20 -K <(printf 'header = "Authorization: Bearer %s"\n' "$MIRSAD_OFFICER_TOKEN") \
    -o "$WORK/key.json" "$BASE_URL/v1/watchlist/blocklist-key" || die "could not read the key from $BASE_URL"
fi
python3 -I - "$WORK/key.json" "$ASSET" <<'PY'
import base64, hashlib, json, sys
raw = json.load(open(sys.argv[1], encoding="utf-8"))
key = raw.get("data", raw)
der = base64.b64decode(key["publicKey"], validate=True)
if hashlib.sha256(der).hexdigest()[:16] != key["keyId"]:
    sys.exit("error: the key id does not match the public key")
asset = json.load(open(sys.argv[2], encoding="utf-8"))
keys = [k for k in asset.get("keys", []) if k["keyId"] != key["keyId"]]
keys.append({"keyId": key["keyId"], "issuer": key["issuer"], "publicKey": key["publicKey"]})
asset["keys"] = keys
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(asset, indent=2, ensure_ascii=False) + "\n")
print(f"trusted {key['keyId']} ({key['issuer']}); {len(keys)} key(s) in {sys.argv[2]}")
PY
