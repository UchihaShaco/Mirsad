#!/usr/bin/env bash
# Run the Mirsad detection engine on your laptop (same rules, model and HOLD gate as the app). No phone needed.
#
#   scripts/analyse.sh "<sender>" "<text>" [SMS|CHAT|CALL] [RELAXED|BALANCED|STRICT]
#   scripts/analyse.sh --file messages.tsv [sensitivity]     # channel<TAB>sender<TAB>text per line
#
# Example:
#   scripts/analyse.sh "+440000000001" "Emirates Post: your parcel is held at customs. Pay AED 3.50 within 24 hours: http://emiratespost-ae.delivery-fee.example/pay"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CP_FILE="$ROOT/core/build/cli-classpath.txt"
if [ ! -f "$CP_FILE" ] || [ -n "${MIRSAD_REBUILD:-}" ]; then
  (cd "$ROOT" && ./gradlew :core:cliClasspath --console=plain -q)
fi
exec java -Dfile.encoding=UTF-8 -cp "$(cat "$CP_FILE")" app.mirsad.core.cli.AnalyseMainKt "$@"
