#!/usr/bin/env bash
# Bring up everything Mirsad runs on one demo machine, in order. Safe to run again: each part is
# skipped when it is already up. Run from anywhere; paths are resolved from this file.
#
#   mirsad-gateway/scripts/start_local.sh            start what is not running
#   mirsad-gateway/scripts/start_local.sh status     show what is running
#
# Parts: the local model (vLLM, port 8001) and the page encoder (port 8003) on the GPU; the website
# shield's containers (engine 8000, gateway, watcher, demo sites); the portal (loopback 8788) behind
# its loopback front (8787); and the tunnel that gives the portal and the contact-sync server their
# public names. Secrets are read from the git-ignored .env files and never printed.
set -euo pipefail

SHIELD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SHIELD/.." && pwd)"
LOGS="$SHIELD/data/logs"
mkdir -p "$LOGS" "$ROOT/data/logs"

up() { curl -fsS -m 3 -o /dev/null "$1" 2>/dev/null; }
say() { printf '%-22s %s\n' "$1" "$2"; }

status() {
  up http://127.0.0.1:8001/v1/models   && say "local model"   "up (8001)"   || say "local model"   "DOWN"
  up http://127.0.0.1:8003/health      && say "page encoder"  "up (8003)"   || say "page encoder"  "DOWN"
  up http://127.0.0.1:8000/v1/health   && say "shield engine" "up (8000)"   || say "shield engine" "DOWN"
  up http://127.0.0.1:8788/healthz     && say "portal"        "up (8788)"   || say "portal"        "DOWN"
  up http://127.0.0.1:8787/healthz     && say "portal front"  "up (8787)"   || say "portal front"  "DOWN"
  up http://127.0.0.1:8080/dashboard   && say "contact sync"  "up (8080)"   || say "contact sync"  "DOWN"
  docker ps --format '{{.Names}}' | grep -qx mirsad-tunnel && say "tunnel" "up" || say "tunnel" "DOWN"
}

if [ "${1:-}" = "status" ]; then status; exit 0; fi

cd "$SHIELD"

if ! up http://127.0.0.1:8001/v1/models; then
  nohup nice -n 19 .venv-llm/bin/vllm serve Qwen/Qwen3.5-9B --host 0.0.0.0 --port 8001 \
    --served-model-name scamshield-llm --max-model-len 32768 --max-num-seqs 16 \
    --gpu-memory-utilization 0.28 --language-model-only --reasoning-parser qwen3 \
    --enable-auto-tool-choice --tool-call-parser qwen3_coder \
    --default-chat-template-kwargs '{"enable_thinking": false}' > "$LOGS/vllm.log" 2>&1 &
  say "local model" "starting (about three minutes to load)"
fi

if ! up http://127.0.0.1:8003/health; then
  nohup nice -n 19 .venv-gpu/bin/python -m ml.serve.page_encoder_server > "$LOGS/page_encoder.log" 2>&1 &
  say "page encoder" "starting"
fi

docker compose --profile demo up -d
say "shield containers" "started"

cd "$ROOT"
if ! up http://127.0.0.1:8788/healthz; then
  # shellcheck disable=SC1091
  export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nohup npm start > "$ROOT/data/logs/portal.log" 2>&1 &
  say "portal" "starting"
fi

cd "$SHIELD"
if ! up http://127.0.0.1:8787/healthz; then
  nohup .venv/bin/mitmdump -q --mode reverse:http://127.0.0.1:8788 --listen-host 127.0.0.1 --listen-port 8787 \
    --set upstream=http://127.0.0.1:8788 --set confdir=data/public_front -s scripts/public_front.py \
    > "$LOGS/public_front.log" 2>&1 &
  say "portal front" "starting"
fi

if ! docker ps --format '{{.Names}}' | grep -qx mirsad-tunnel; then
  TUNNEL_TOKEN="$(sed -n 's/^cloudflare_token=//p' .env | tr -d '"'"'"'\r')"
  if [ -n "$TUNNEL_TOKEN" ]; then
    docker rm -f mirsad-tunnel > /dev/null 2>&1 || true
    TUNNEL_TOKEN="$TUNNEL_TOKEN" docker run -d --name mirsad-tunnel --network host \
      --add-host scamshield-sync:127.0.0.1 -v "$(command -v cloudflared)":/usr/local/bin/cloudflared:ro \
      -e TUNNEL_TOKEN --restart unless-stopped --entrypoint /usr/local/bin/cloudflared \
      scamshield-engine:local tunnel --no-autoupdate run > /dev/null
    say "tunnel" "started"
  else
    say "tunnel" "skipped: no cloudflare_token in .env"
  fi
fi

sleep 5
status
