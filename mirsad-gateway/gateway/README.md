# Mirsad (مرصاد) website shield: the simulated ISP

A container that joins the team tailnet as the exit node `scamshield-isp` (the node keeps the name it was registered
under; `TS_HOSTNAME` changes it for a new node). A phone that selects it
sends all its traffic through the container, where a mitmproxy addon (`addon.py`) asks the engine
about every new site before it may load.

```
phone ──Tailscale──▶ tailscale0 ─┬─ tcp 80/443 ──▶ transparent proxy :8080 ─┐
                                 ├─ dns 53 ──────▶ resolver hook :53 ────────┼─▶ addon.py ──▶ engine :8000
                                 ├─ udp 443 (QUIC), 853 (DNS over TLS): refused, so apps fall back
                                 └─ everything else: forwarded and masqueraded
curl / phone-sim ───────────────────────────────▶ explicit proxy :8081 ─────┘
```

| Site state | Without our CA (default) | With our CA (`SCAMSHIELD_INTERCEPT=1`) and for plain HTTP |
|---|---|---|
| unknown | connection held at the TLS ClientHello, up to `SCAMSHIELD_HOLD_S` (8 s) | "checking this site" page that forwards when the verdict lands |
| allow | passed through untouched | passed through |
| warn | passed through (`SCAMSHIELD_WARN_OVER_TLS=block` to refuse) | warning with "go back" / "continue anyway" |
| block | connection reset at once; `http://shield.test/` lists the phone's recent blocks and why | bilingual block page: risk score, top reasons, case reference |
| revoked later | open connections cut, new ones refused | same, then the block page |
| block overturned by review | allowed again within seconds | the block page shows "re-checked and cleared" |

Hosts in `passthrough.txt` (Tailscale, OS connectivity checks, push, pinned-certificate apps) are never
held or investigated. If the engine is down or too slow, unknown sites are blocked after the hold
time (`SCAMSHIELD_ON_TIMEOUT=allow` to fail open); hosts already decided keep their last decision.
Every decision is one JSON log line: host, decision, wait_ms, source (cache / engine / timeout /
engine-down / partial / passthrough / event).

## Start

```bash
cp .env.example .env            # optional: TS_AUTHKEY=tskey-auth-... skips the login step
docker compose up -d --build
docker compose logs -f gateway  # first run without a key: prints "TAILSCALE LOGIN REQUIRED" + URL
```

Until the login is done the URL can also be read with
`docker compose exec gateway cat /var/lib/scamshield/tailscale/login-url.txt`.
Tailscale state and the proxy CA live in `gateway/state/` (git-ignored), so the node keeps its
identity across restarts. To get a fresh login URL: `docker compose down gateway && rm -rf
gateway/state/tailscale && docker compose up -d gateway`.

## Join the tailnet and approve the exit node

1. Open the login URL from the logs and sign in with the team account. The machine appears as
   `scamshield-isp`.
2. In the admin console (https://login.tailscale.com/admin/machines), open `scamshield-isp` →
   **Edit route settings** → tick **Use as exit node** → Save. (Optionally **Disable key expiry**.)
3. If the tailnet uses ACLs, make sure the phone's user may use exit nodes
   (`"autogroup:internet"` in the policy's destinations).

## Select the exit node on the phone

- **Android**: Tailscale app → **Exit node** (top of the main screen) → `scamshield-isp`.
  Turn **Allow LAN access** off. Settings → Network → **Private DNS** → *Automatic* or *Off*
  (a fixed "Private DNS provider hostname" bypasses the gateway's resolver).
- **iOS**: Tailscale app → **Exit Node** → `scamshield-isp`.

Check: open http://example.org on the phone; `docker compose logs gateway` shows a
`"decision"` line with the phone's 100.x address as client.

## DNS from the phone

With an exit node selected and no tailnet-wide DNS override, the phone's Tailscale client sends its
DNS queries to the exit node's Tailscale DNS service, and `tailscaled` in the container answers them
with the container's `/etc/resolv.conf`. The entrypoint points that file at the proxy's DNS listener
(`127.0.0.1:53`), which forwards to Docker's resolver. If the tailnet does override DNS (e.g. global
nameserver 8.8.8.8), those queries travel through the tunnel as plain port 53 traffic and are
redirected to the same listener. The hook starts investigating a name as soon as it is looked up,
answers AAAA with no records (the uplink is IPv4 only) and drops HTTPS records, so browsers neither
try QUIC first nor hide the server name behind Encrypted Client Hello.

## Intercept mode (full URLs, pages over HTTPS)

1. Set `SCAMSHIELD_INTERCEPT=1` in `.env` (the one switch; it must live in `.env` because every
   `docker compose` command re-reads it), then `docker compose up -d gateway`.
2. On the phone, with the exit node on, open **http://mitm.it** and download the Android / iOS
   certificate (the gateway's DNS hook points `mitm.it` at itself).
3. Android: Settings → Security → More security settings → Encryption & credentials → Install a
   certificate → **CA certificate**. Chrome trusts user CAs; most apps do not, which is why
   `passthrough.txt` exempts pinned apps. iOS: install the profile, then Settings → General → About →
   Certificate Trust Settings → enable full trust.

Upstream certificates are checked against the public roots plus a local lab CA
(`gateway/state/lab-ca/`) that signs the private demo sites' certificates; see `docs/DEMO.md`.

## Live-demo sites

`docker compose --profile demo up -d` adds simulated scam and clean sites on a private network, a
3-minute script and a reset command: see `docs/DEMO.md`.

## Without a phone

```bash
docker compose --profile sim run --rm phone-sim      # scripted session from sim_urls.txt
curl -x http://localhost:8081 http://example.org/     # plain HTTP: pages are visible
curl -x http://localhost:8081 https://example.com/    # HTTPS: held, then passed through or refused
```

`GATEWAY_MODE=explicit` runs only the explicit proxy and DNS hook (no Tailscale), for laptops without
`/dev/net/tun`. `GATEWAY_MODE=wireguard` replaces Tailscale with the proxy's own WireGuard server for a
phone on the same Wi-Fi: the client config is printed in the logs; set its `Endpoint` to this PC's
LAN address and UDP `51820` (on WSL2 that port must be forwarded from Windows).

Tests (mock engine, real addon, no Docker): `.venv/bin/pytest tests/gateway`.

## Troubleshooting

| Symptom | Check |
|---|---|
| No login URL | `docker compose logs gateway`; `cat gateway/state/tailscale/tailscaled.log` |
| Phone has no internet with the exit node on | exit node approved in the console? `docker compose exec gateway tailscale status`; `docker compose exec gateway iptables -t nat -S` |
| Sites load but no decision lines | phone's Private DNS set to a fixed provider, or another VPN active |
| Every site blocked after ~8 s | engine down: `curl localhost:8000/v1/health`; log lines show `"source": "engine-down"` |
| An app breaks only through the gateway | add its domains to `SCAMSHIELD_PASSTHROUGH` |
| Certificate errors on the phone | intercept mode is on but the CA is not installed: set `SCAMSHIELD_INTERCEPT=0` |
