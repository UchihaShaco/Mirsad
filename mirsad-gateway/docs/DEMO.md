# Live demo: a phone behind Mirsad's simulated ISP (مرصاد)

Three minutes. A phone browses through the gateway; the judge watches each site get checked, allowed,
blocked, warned about or cut off later. The dashboard on the laptop shows the same verdicts as they land.

## The demo sites

`docker compose --profile demo up -d` adds `demo-sites`: simulated sites on a private compose network,
**never published on a host port and never reachable from the internet**. Their host names are
fictitious: each was checked to be unregistered (NXDOMAIN on public DNS, no RDAP record) when they were
chosen, and they resolve only inside the demo network, through Docker network aliases. The gateway's
DNS hook answers the phone from that resolver, so the phone reaches them through the tunnel like any
other site, and the engine fetches them exactly like it fetches internet sites. The engine's
private-address guard is opened for one address only (`SCAMSHIELD_ALLOW_NETWORKS=172.30.77.10/32`,
the demo-sites container); nothing in the engine knows these hosts.

| # | Open on the phone | Scenario | Expected outcome |
|---|---|---|---|
| a | `http://oasisroastery.com/` | Small coffee shop, never seen before | Short "checking" page (or a pause), then the shop loads. Allowed, risk ~22 |
| b | `http://uae-trafficfines-pay.com/` | Bilingual traffic-fine lure: Emirates ID, card, CVV and SMS code, posted to another host | Block page. Risk ~100. Card form, off-site form posting, Emirates ID request, OTP request, fine lure |
| c | `http://go2ae.link/r/fine` | Short link: HTTP redirect, meta refresh, then a JavaScript redirect to (b) | Block page for the short link itself. Same reasons plus "Redirects to a different website" |
| d | `http://sandrosetours.com/` | Clean tour operator whose "Book a tour" link leads to a card form posting off-site | Loads (allowed, risk ~23). Seconds later the deep crawl reaches the booking page and **revokes** it: the next visit shows the block page |
| e | `http://epost-redelivery-ae.com/` | Parcel-fee scam that shows crawlers a gardening blog and mobile Chrome the card form | Block page. "Shows security scanners a different page than phone users" among the top reasons |
| f | `http://appupdate-cdn-ae.net/` | Empty page shell with a deliberately scrambled script | Warning page ("Be careful"), with "Go back" / "Continue anyway". Risk ~69: both models are confident, but a block needs specific page evidence |

`http://demo.test/` is a launcher page with all six links (it is on the gateway's passthrough list,
so it is never checked itself). Pages show "Simulated page for a security demonstration" in English
and Arabic, drawn by the stylesheet so it is not part of the page text the engine analyses.

A seventh scenario (a legitimate site blocked first and then cleared by the review agent) was
**dropped**: these hosts have no independent footprint on the internet, so an honest review cannot
clear them, and staging it would mean rigging the reviewer. Every block above is reviewed by the
local LLM in the background and confirmed; the review result appears in the dashboard.

## Before the judges arrive (once)

1. `docker compose --profile demo up -d --build`
2. The phone: Tailscale on, **Exit node → scamshield-isp**, Private DNS on Automatic or Off.
   In the Tailscale admin console the node `scamshield-isp` must have **Use as exit node** approved.
3. Laptop browser: `http://localhost:8000/` (the website shield's operations console), tab **Live**.
4. `./demo/reset.sh` (below). It stops the watcher while it clears state; start it again with
   `docker compose start watcher`. The engine gives people's checks priority over the watcher, so
   the demo runs the same with the watcher on.
5. Phone: open `http://demo.test/` and keep it as the start tab, and `http://shield.test/` in a
   second tab (see "Without a certificate" below).

Use the `http://` links. Plain HTTP lets the gateway show its pages without any certificate on the
phone. For `https://` addresses and real sites, see "Intercept mode" below.

## The three-minute script

| Time | On the phone | What the judge sees | Dashboard (Live tab) |
|---|---|---|---|
| 0:00 | Open `demo.test`, explain: the phone's whole connection goes through our simulated ISP | Launcher page | — |
| 0:15 | Tap **a**, the coffee shop | "Checking this site for you" for about a second (first visit only), then the shop | New verdict `oasisroastery.com` **allow**, risk ~22 |
| 0:35 | Back, tap **b**, the traffic-fine page | Red block page in English and Arabic: risk score, top three reasons, reference `SS-…` | `uae-trafficfines-pay.com` **block** ~100. Open it: card form, off-site posting, Emirates ID, OTP; review "confirmed" a few seconds later |
| 1:05 | Back, tap **c**, the short link | Same block page, now for `go2ae.link`. The hidden meta-refresh and JavaScript hops were followed | `go2ae.link` **block**, final URL `uae-trafficfines-pay.com`, reason "Redirects to a different website" |
| 1:30 | Back, tap **e**, the parcel page | Block page. Explain: a crawler sees a gardening blog, a phone sees the card form | `epost-redelivery-ae.com` **block**, reason "Shows security scanners a different page than phone users" |
| 1:55 | Back, tap **f** | Amber warning with "Go back" / "Continue anyway" | `appupdate-cdn-ae.net` **warn** ~69: both models confident, no specific scam evidence yet |
| 2:15 | Back, tap **d**, the tour operator | The site loads: nothing wrong on its first page | `sandrosetours.com` **allow** ~23, then within ~1–5 s **block** (revoked, "Allowed earlier, blocked after deeper inspection of …/booking/pay") |
| 2:35 | Pull to refresh on **d** | Block page: the late finding cut the site off | Host shows revoked; reasons point at `/booking/pay` |
| 2:50 | Close: evidence | — | Evidence tab: download the pack for (b): `report.pdf`, `screenshot.png`, takedown letters in English and Arabic |

Timing notes: the first visit to a site takes 0.3–2 s with the engine warmed up (the gateway shows the
checking page only when a decision takes longer than 1 s; set `SCAMSHIELD_PAGE_GRACE_S=0` in `.env`
to always show it). The deep crawl of (d) finishes 1–5 s after the first page; if the judge reloads
too early, the page still loads, so wait for the dashboard to flip before reloading.

## Reset between runs

```bash
./demo/reset.sh
```

It stops the watcher and engine, deletes the demo hosts' verdicts, host records, events and visit
counts (`demo/reset.py`), starts the engine and warms it up with one check. The gateway's decision cache
expires within 10 seconds by itself. Every scenario then starts from "never seen".

## Fallback without the phone (venue network fails)

```bash
./demo/reset.sh
docker compose --profile sim run --rm --no-deps -e SIM_URLS_FILE=/demo/sim_demo.txt phone-sim
```

The phone simulator opens the same sequence through the gateway's explicit-proxy listener with a
mobile Chrome identity, including the wait for the revocation. Expected output:

```
LOADED     1.8s  http://oasisroastery.com/  (HTTP 200, 1506 bytes)
BLOCKED    0.4s  http://uae-trafficfines-pay.com/  (block page shown)
BLOCKED    0.4s  http://go2ae.link/r/fine  (block page shown)
BLOCKED    0.5s  http://epost-redelivery-ae.com/  (block page shown)
WARNED     0.2s  http://appupdate-cdn-ae.net/  (warning interstitial shown)
LOADED     0.1s  http://sandrosetours.com/  (HTTP 200, 1394 bytes)
...       30.0s  (waiting)
BLOCKED    0.0s  http://sandrosetours.com/  (block page shown)
```

Show `docker compose logs -f gateway | grep decision` next to it: one JSON line per decision, with
`"source": "event:verdict.revoked"` and `{"event": "connections.cut", ...}` for (d). The pages
themselves can be shown in a laptop browser through the same proxy, for example Chrome started with
`--proxy-server=http://localhost:8081`.

## Without a certificate (the default)

- **HTTP demo sites** show the block page or warning directly, because plain HTTP is readable.
- **A blocked HTTPS site** cannot be answered with our page without a certificate on the phone, as
  with any ISP: the gateway resets the connection the moment the decision is made, so Chrome shows
  its connection error at once (no spinner, no timeout), and **`http://shield.test/` explains why**.
- `http://shield.test/` is this phone's protection page, served by the gateway itself (the DNS hook
  answers the name; it is never investigated). It lists the phone's recent decisions, newest block or
  warning first, with the risk score, "pretends to be …" when a brand is impersonated, the top
  reasons in English and Arabic, and the case reference (the evidence pack's number when there is
  one). Sites being checked right now appear at the top with a spinner. It refreshes every 3 seconds.
- Each phone sees only its own history: entries are keyed by the phone's tailnet address.

In the script: after a blocked HTTPS site shows Chrome's error, switch to the `shield.test` tab.

Android's captive-portal notification ("Sign in to network") is **not used**. Android sends its
connectivity probes over the underlying Wi-Fi or mobile network, not through the Tailscale VPN, so a
redirect served by the exit node never reaches that check; making it work would mean breaking the
connectivity check for the whole network. (Reasoned from how Android validates VPN networks; not
tried on the demo phone.)

## Intercept mode (HTTPS pages on the phone)

Without our certificate, an HTTPS site the gateway blocks just fails to connect (the phone shows a
connection error, the log shows the reason). With it, blocked HTTPS sites show the same block page.

1. Put `SCAMSHIELD_INTERCEPT=1` in `.env` and run `docker compose --profile demo up -d gateway demo-sites`.
   The switch must be in `.env`: every later `docker compose` command re-reads it, so a one-off
   environment variable would be lost the next time the gateway is recreated.
2. On the phone, with the exit node on, open **`http://mitm.it`** in Chrome and tap the **Android**
   button. Then Settings → Security and privacy → More security settings → Encryption and credentials →
   Install a certificate → **CA certificate** → Install anyway → choose the downloaded
   `mitmproxy-ca-cert` file. (Samsung: Settings → Security and privacy → Other security settings →
   Install from device storage → CA certificate.)
3. Chrome now trusts the gateway, so `https://uae-trafficfines-pay.com/` shows the block page and real
   HTTPS sites load normally. Apps that pin their certificates are on the gateway's passthrough list.
4. To undo: remove the certificate under Encryption and credentials → User credentials, and set
   `SCAMSHIELD_INTERCEPT=0` again.

In intercept mode the demo sites also serve HTTPS, with certificates from a local lab CA that the
gateway trusts. Verified through the simulator: `https://oasisroastery.com/` loads,
`https://uae-trafficfines-pay.com/` shows the block page, `https://appupdate-cdn-ae.net/` the warning,
and real sites (`https://www.adpolice.gov.ae/`, Wikipedia) load through the interception.
