#!/usr/bin/env bash
# Reset the demo: the engine forgets the demo hosts, then warms up so the first scenario is not slowed
# by model loading. The gateway's own cache expires by itself within 10 seconds.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose stop watcher engine >/dev/null 2>&1
docker compose run --rm --no-deps -v ./demo:/app/demo:ro engine python /app/demo/reset.py
docker compose start engine >/dev/null 2>&1
until curl -sf localhost:8000/v1/health >/dev/null; do sleep 1; done
curl -sf -o /dev/null -X POST localhost:8000/v1/check -H 'content-type: application/json' \
  -d '{"url": "https://www.example.com/", "depth": "page"}'
sleep 10
echo "demo reset: engine ready, watcher paused (start it again with: docker compose start watcher)"
