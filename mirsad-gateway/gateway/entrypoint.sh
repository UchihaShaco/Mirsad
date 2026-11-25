#!/usr/bin/env bash
# ScamShield gateway: joins the tailnet as an exit node, steers phone traffic into the proxy, runs it.
set -euo pipefail

MODE="${GATEWAY_MODE:-tailscale}"          # tailscale | wireguard | explicit
STATE="${SCAMSHIELD_STATE:-/var/lib/scamshield}"
TS_IF=tailscale0
TPROXY_PORT=8080
EXPLICIT_PORT=8081
WG_PORT=51820
DEMO_NET="${SCAMSHIELD_DEMO_NET:-172.30.77.0/24}"  # the demo sites' compose network (docker-compose.yml)
PRIVATE_NETS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16

log() { printf '[gateway] %s\n' "$*"; }

mkdir -p "$STATE/tailscale" "$STATE/mitmproxy" /var/run/tailscale

# Docker writes its embedded resolver into resolv.conf on every start; keep it as our upstream.
UPSTREAM_DNS="${SCAMSHIELD_UPSTREAM_DNS:-$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)}"
if [[ -z "$UPSTREAM_DNS" || "$UPSTREAM_DNS" == 127.0.0.1 ]]; then
  UPSTREAM_DNS=127.0.0.11
fi

ensure_chain() {  # ensure_chain <table> <chain> <parent>: own chain, flushed, jumped to first
  local table=$1 chain=$2 parent=$3
  iptables -t "$table" -N "$chain" 2>/dev/null || iptables -t "$table" -F "$chain"
  iptables -t "$table" -C "$parent" -j "$chain" 2>/dev/null || iptables -t "$table" -I "$parent" 1 -j "$chain"
}

setup_firewall() {
  local wan
  wan="$(ip -4 route show default | awk '{print $5; exit}')"

  ensure_chain nat SCAMSHIELD_PRE PREROUTING
  iptables -t nat -A SCAMSHIELD_PRE -i "$TS_IF" -d 100.64.0.0/10 -j RETURN
  iptables -t nat -A SCAMSHIELD_PRE -i "$TS_IF" -p udp --dport 53 -j REDIRECT --to-ports 53
  iptables -t nat -A SCAMSHIELD_PRE -i "$TS_IF" -p tcp --dport 53 -j REDIRECT --to-ports 53
  # Web ports of private addresses would reach the proxy and leave from the gateway's own position (host LAN,
  # Docker networks). Only the demo sites' network is served; other private targets fall to the FORWARD reject.
  iptables -t nat -A SCAMSHIELD_PRE -i "$TS_IF" -d "$DEMO_NET" -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports "$TPROXY_PORT"
  iptables -t nat -A SCAMSHIELD_PRE -i "$TS_IF" -d "$PRIVATE_NETS" -j RETURN
  iptables -t nat -A SCAMSHIELD_PRE -i "$TS_IF" -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports "$TPROXY_PORT"

  ensure_chain filter SCAMSHIELD_FWD FORWARD
  iptables -A SCAMSHIELD_FWD -i "$TS_IF" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable
  iptables -A SCAMSHIELD_FWD -i "$TS_IF" -p tcp --dport 853 -j REJECT --reject-with tcp-reset
  iptables -A SCAMSHIELD_FWD -i "$TS_IF" -p udp --dport 853 -j REJECT --reject-with icmp-port-unreachable
  # The phone gets the internet, not the gateway's private networks (engine, demo sites, host LAN).
  iptables -A SCAMSHIELD_FWD -i "$TS_IF" -d "$PRIVATE_NETS" -j REJECT --reject-with icmp-net-prohibited
  iptables -A SCAMSHIELD_FWD -i "$TS_IF" -j ACCEPT
  iptables -A SCAMSHIELD_FWD -o "$TS_IF" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

  # The explicit proxy is for this machine and the Docker network, not for tailnet peers.
  ensure_chain filter SCAMSHIELD_IN INPUT
  iptables -A SCAMSHIELD_IN -i "$TS_IF" -p tcp --dport "$EXPLICIT_PORT" -j REJECT --reject-with tcp-reset

  ensure_chain mangle SCAMSHIELD_MSS FORWARD
  iptables -t mangle -A SCAMSHIELD_MSS -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu

  ensure_chain nat SCAMSHIELD_POST POSTROUTING
  iptables -t nat -A SCAMSHIELD_POST -s 100.64.0.0/10 -o "$wan" -j MASQUERADE

  # The uplink has no IPv6: refuse it at once so apps fall back to IPv4 instead of timing out.
  if ip6tables -L FORWARD -n >/dev/null 2>&1; then
    ip6tables -N SCAMSHIELD_FWD 2>/dev/null || ip6tables -F SCAMSHIELD_FWD
    ip6tables -C FORWARD -j SCAMSHIELD_FWD 2>/dev/null || ip6tables -I FORWARD 1 -j SCAMSHIELD_FWD
    ip6tables -A SCAMSHIELD_FWD -i "$TS_IF" -p tcp -j REJECT --reject-with tcp-reset
    ip6tables -A SCAMSHIELD_FWD -i "$TS_IF" -j REJECT
  fi
  log "firewall: tcp 80/443 -> proxy :$TPROXY_PORT, dns 53 -> resolver hook, quic and dns-over-tls refused, egress via $wan"
}

start_tailscale() {
  tailscaled --state="$STATE/tailscale/tailscaled.state" --statedir="$STATE/tailscale" \
    --socket=/var/run/tailscale/tailscaled.sock --tun="$TS_IF" >>"$STATE/tailscale/tailscaled.log" 2>&1 &
  TAILSCALED_PID=$!
  for _ in $(seq 50); do
    [[ -S /var/run/tailscale/tailscaled.sock ]] && break
    sleep 0.2
  done

  local args=(up --reset --hostname="${TS_HOSTNAME:-scamshield-isp}" --advertise-exit-node
              --accept-dns=false --netfilter-mode=off --timeout=0)
  [[ -n "${TS_AUTHKEY:-}" ]] && args+=(--auth-key="$TS_AUTHKEY")
  (
    set +e
    tailscale "${args[@]}" 2>&1 | while IFS= read -r line; do
      case "$line" in
        *https://login.tailscale.com/*|*https://*/a/*)
          url="$(grep -o 'https://[^ ]*' <<<"$line")"
          log "================================================================"
          log "TAILSCALE LOGIN REQUIRED - open this URL to add the gateway:"
          log "  $url"
          log "================================================================"
          printf '%s\n' "$url" >"$STATE/tailscale/login-url.txt"
          ;;
        "") ;;
        *) log "tailscale: $line" ;;
      esac
    done
    if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
      log "tailscale: 'tailscale up' failed; see $STATE/tailscale/tailscaled.log"
      exit 1
    fi
    rm -f "$STATE/tailscale/login-url.txt"
    log "tailscale: joined tailnet as ${TS_HOSTNAME:-scamshield-isp} ($(tailscale ip -4 2>/dev/null)); approve it as an exit node in the admin console if not auto-approved"
  ) &
}

point_resolver_at_hook() {
  for _ in $(seq 50); do
    dig +time=1 +tries=1 @127.0.0.1 -p 53 localhost >/dev/null 2>&1 && break
    sleep 0.2
  done
  printf 'nameserver 127.0.0.1\noptions ndots:0\n' >/etc/resolv.conf
  log "dns: resolver hook on :53, upstream $UPSTREAM_DNS (tailscaled's exit-node DNS uses it via resolv.conf)"
}

# Upstream trust: the public roots plus a local lab CA that signs the private demo sites' certificates,
# so intercept mode can verify them like any other site.
python - "$STATE/lab-ca" <<'PY'
import sys
from pathlib import Path
from mitmproxy.certs import CertStore
path = Path(sys.argv[1])
if not (path / "lab-ca.pem").exists():
    CertStore.create_store(path, "lab", 2048, organization="Lab Trust Services", cn="Lab Trust Services Root CA")
PY
cat "$(python -c 'import certifi; print(certifi.where())')" "$STATE/lab-ca/lab-ca-cert.pem" >"$STATE/upstream-trust.pem"

TAILSCALED_PID=""
modes=(--mode "regular@$EXPLICIT_PORT" --mode "dns@53")
case "$MODE" in
  tailscale)
    sysctl -q net.ipv4.ip_forward 2>/dev/null | grep -q 1 || log "warning: net.ipv4.ip_forward is off"
    setup_firewall
    start_tailscale
    modes+=(--mode "transparent@$TPROXY_PORT")
    ;;
  wireguard)
    modes+=(--mode "wireguard:$STATE/mitmproxy/wireguard.conf@$WG_PORT")
    log "wireguard: client configuration is printed below by the proxy; endpoint = this PC's LAN address, udp $WG_PORT"
    ;;
  explicit) ;;
  *) log "unknown GATEWAY_MODE=$MODE (tailscale | wireguard | explicit)"; exit 2 ;;
esac

mitmdump "${modes[@]}" \
  --set confdir="$STATE/mitmproxy" \
  --set connection_strategy=lazy \
  --set dns_name_servers="$UPSTREAM_DNS" \
  --set ssl_verify_upstream_trusted_ca="$STATE/upstream-trust.pem" \
  --set flow_detail=0 \
  -s /app/addon.py &
PROXY_PID=$!
point_resolver_at_hook
log "proxy: explicit proxy on :$EXPLICIT_PORT (mode=$MODE, intercept=${SCAMSHIELD_INTERCEPT:-0})"

trap 'kill -TERM $PROXY_PID $TAILSCALED_PID 2>/dev/null' TERM INT
wait -n $PROXY_PID $TAILSCALED_PID
log "a core process exited; stopping so the container restarts"
kill -TERM $PROXY_PID $TAILSCALED_PID 2>/dev/null || true
wait
