# Industry approaches to pre-click URL investigation, and what we can reuse tonight

Researched 24 Nov 2026, 20:50–21:30 GST. Every claim carries a link. **[UNVERIFIED]** marks things I could not confirm from a primary source. **[TESTED]** marks endpoints I called from this machine tonight.

---

## 0. TL;DR

- Nobody serious relies on one signal. The big players combine three things. (a) **List lookups**: Safe Browsing, SmartScreen and the protective-DNS feeds. (b) **Domain freshness**: newly-seen or newly-registered domains, 24 h to 30 days. (c) **Content or visual analysis** from a crawler built to look like a real victim: residential IPs, real browser fingerprints, OCR of screenshots.
- **Cloaking is the main obstacle to detection.** Kits filter by User-Agent, IP/ASN, geolocation, TLS fingerprint, referrer, time of day and "one visit per IP". Our gateway runs inside the UAE and sees the victim's real request, so it has an advantage most commercial scanners pay for with proxy networks.
- **Free sources we can wire tonight:** RDAP plus .ae WHOIS, crt.sh, WhoisDS daily NRD, OpenPhish, Tranco, Cloudflare Radar ranking, Cloudflare URL Scanner (token already available), urlscan.io search, IPtoASN/Team Cymru/RIPEstat, and the Google Safe Browsing v4 Lookup API (needs a key). URLhaus and ThreatFox need a free abuse.ch Auth-Key and are for non-commercial use only. PhishTank registration is closed.

---

## 1. Browser and OS protections

### Google Safe Browsing (Chrome)
- **Standard protection, now real-time.** Chrome checks a local cache of known-safe sites first. If the URL is not there, Chrome computes 32-byte SHA-256 full hashes of the URL expressions, truncates them to 4-byte prefixes, encrypts them and sends them through an Oblivious HTTP privacy relay run by Fastly. Google sees the hash prefixes but not the IP; Fastly sees the IP but not the prefixes. If the relay is unreachable, Chrome falls back to the local hash list. Source: [Google Security Blog, 14 Mar 2024](https://security.googleblog.com/2024/03/blog-post.html).
- **Enhanced protection** is opt-in. It adds AI classification, deeper file scans and extension checks, and can flag sites that Safe Browsing has not yet confirmed as unsafe ([same post](https://security.googleblog.com/2024/03/blog-post.html)).
- **Developer APIs:**
  - v4 Lookup: `POST https://safebrowsing.googleapis.com/v4/threatMatches:find?key=API_KEY`, up to 500 URLs per request ([docs](https://developers.google.com/safe-browsing/v4/lookup-api)). Non-commercial only. Google says commercial use should go to Web Risk ([usage limits](https://developers.google.com/safe-browsing/v4/usage-limits)).
  - v5 `GET https://safebrowsing.googleapis.com/v5/hashes:search?hashPrefixes=...` takes 4-byte base64 prefixes and returns full hashes, threat types and a `cacheDuration` ([reference](https://developers.google.com/safe-browsing/reference/rest/v5/hashes/search)).
- **What we take from it:** treat a Safe Browsing hit as near-certain BLOCK. A miss tells us nothing, because the lists lag fresh smishing domains (see the PhishFarm finding in section 3.6).

### Google Web Risk (commercial version of Safe Browsing)
- `uris.search` is free for the first 100,000 calls a month and costs $0.50 per 1,000 after that. Calling `threatLists.computeDiff` moves pricing to the hashes.search rate ([pricing](https://cloud.google.com/web-risk/pricing)). It needs a GCP project with billing enabled. That is a sign-up step and probably needs a card **[UNVERIFIED: card requirement]**.

### Microsoft Defender SmartScreen
- It analyses visited pages for suspicious behaviour and checks them against a dynamic list of reported phishing and malware sites. URL reputation draws on user feedback, data providers and intelligence models. **When a URL has no reputation it is marked higher risk and the user gets a warning** ([Microsoft Learn: Edge SmartScreen](https://learn.microsoft.com/deployedge/microsoft-edge-security-smartscreen), [URL reputation demos](https://learn.microsoft.com/en-us/defender-endpoint/defender-endpoint-demonstration-smartscreen-url-reputation)).
- **What we take from it:** "unknown means warn" is an accepted industry stance, which justifies our WARN tier for domains that are new or unranked. There is no free public SmartScreen lookup API **[UNVERIFIED: none found]**.

---

## 2. Protective DNS, secure web gateways and ISP or national filtering

| Service | Freshness signal | Window | Notes and source |
|---|---|---|---|
| **Cisco Umbrella** | "Newly Seen Domains" (NSD): first queried by any Umbrella/OpenDNS user | **24 h** | Only counts if the query got a valid answer. Cisco says many NSDs are benign. The database is built from heavily sampled logs, so established domains can be falsely marked new. An NSDv2 built by Talos from full passive DNS was announced. ([224735](https://www.cisco.com/c/en/us/support/docs/security/umbrella/224735-enable-newly-seen-domains-security.html), [224688](https://www.cisco.com/c/en/us/support/docs/security/umbrella/224688-understand-why-domains-are-marked-as.html), [225196 PDF](https://www.cisco.com/c/en/us/support/docs/security/umbrella/225196-upcoming-umbrella-security-enhancements.pdf)) |
| **Cloudflare Gateway** | "Newly Seen Domains" (first resolved in the past 30 days). Older docs also have "New Domains" (registered in the past 30 days) | **30 days** | The categoriser models use domain age and reputation ([domain categories](https://developers.cloudflare.com/cloudflare-one/policies/gateway/domain-categories)) |
| **NextDNS** | "Block Newly Registered Domains (NRDs)" | **30 days**, fixed | Staff say it is an internal dynamic list that detects new domains a few minutes after registration. Users report false positives, e.g. trafficmanager.net and akadns.net ([thread](https://help.nextdns.io/t/m1h1r87/nextdnss-blocking-newly-registred-domains), [FP thread](https://help.nextdns.io/t/y4hzhj6/false-positives-on-nrds)) |
| **Quad9** | No in-house IOCs. Blocks domains drawn from **20+ threat-intel partners** plus vetted open-source data, security-only criteria | n/a | Partners get volumetric telemetry back ([threat blocking](https://quad9.net/service/threat-blocking/), [about](https://quad9.net/about/)) |
| **Infoblox** | Lookalike Domain Monitoring: the customer lists its brands and Infoblox watches registrars, ISPs and DNS for high-risk lookalikes. A homograph ML classifier works per character (IDN homographs, `rn`→`m`, `l`→`I`) | n/a | ([solution note](https://infoblox.com/resources/solution-notes/protect-your-network-and-customers-with-lookalike-monitoring), [AWS ML blog](https://aws.amazon.com/blogs/machine-learning/infoblox-inc-built-a-patent-pending-homograph-attack-detection-model-for-dns-with-amazon-sagemaker), [A fresh look at lookalike domains](https://www.infoblox.com/blog/security/a-fresh-look-at-lookalike-domains/)) |
| **DNSFilter** | not researched tonight | | **[UNVERIFIED]** |

**Lesson:** a domain's age alone produces false positives (Cisco and NextDNS both say so). Use age as a multiplier on other evidence, not as a block on its own. Popular CDN and cloud-infrastructure domains need an allowlist.

### National or telco level
- **UK NCSC Protective DNS** is operated by Nominet. Rolling PDNS out to schools took reported blocked queries from about 19 thousand to about 10 million. The related "Share and Defend" feed of known scam domains to ISPs has blocked "millions" of access attempts since March 2025 ([NCSC Annual Review 2025, Active Cyber Defence](https://www.ncsc.gov.uk/collection/ncsc-annual-review-2025/chapter-02-resilience-at-scale/active-cyber-defence)). Earlier figure: 57.4 million blocks out of 68.7 billion queries in 2018 ([ACD Fifth Year report](https://www.ncsc.gov.uk/files/ACD-The-Fifth-Year-full-report.pdf)). Press reports of "nearly 1 billion" blocked attempts ([TechRadar](https://www.techradar.com/pro/security/uk-cybercrime-agency-blocks-nearly-1-billion-access-attempts-to-malicious-websites)) are **[UNVERIFIED against NCSC text]**.
- **Singapore:** SPF and IMDA have ISPs block scam websites, about 500 in 2020 and about 12,000 in 2021 ([MDDI ministerial statement](https://www.mddi.gov.sg/newsroom/ministerial-statement-by-minister-joteo-on-combating-online-phishing/)). Telcos have blocked malicious links in SMS since 2019 and run in-network SMS scanning since 2022. SPF's **SATIS** AI platform evaluates over 400,000 websites a day ([MDDI anti-scam efforts](https://www.mddi.gov.sg/other-pages/anti-scam-efforts/)). A national PDNS is reportedly planned ([Bernama](https://www.bernama.com/en/world/news.php?id=2619620), date **[UNVERIFIED]**).
- **Australia:** Telstra "Cleaner Pipes" blocks known scam websites at network level, plus about 21 million scam calls and 11 million scam SMS a month (self-reported; [Telstra](https://www.telstra.com.au/connected/cyber-security-and-safety/blocking-millions-cyber-threats)). The National Anti-Scam Centre has coordinated telcos, platforms and police since 1 July 2023 ([ACMA](https://www.acma.gov.au/combating-phone-scams)).
- **UAE:** under TDRA's Internet Access Management policy, **Etisalat (e&) and du must block content TDRA flags**, and "Impersonation, fraud and phishing" is a prohibited category. In one reported quarter, 883 sites were blocked, about 377 (43%) of them for phishing or fraud (year **[UNVERIFIED]**; [Khaleej Times](https://www.khaleejtimes.com/uae/crime/uae-17-categories-of-online-content-websites-that-are-blocked-in-the-emirates)). TDRA/aeCERT scan links and investigate phishing sites, and the public can report to aeCERT ([u.ae cyber safety](https://u.ae/en/information-and-services/justice-safety-and-the-law/cyber-safety-and-digital-security)). In Oct 2025 e& launched network-wide AI voice anti-fraud with Mavenir, covering robocalls, spoofing and one-ring calls ([Bernama/MREM](https://mrem.bernama.com/viewsm.php?idm=52406)). I found **no public e&/du product that blocks phishing URLs per subscriber**. That gap is our pitch: **a pre-click investigation layer at the ISP, feeding TDRA's existing block mechanism and police evidence.**

---

## 3. Anti-phishing vendors and scanners

### 3.1 urlscan.io [TESTED]
- **API:**
  - Submit: `POST https://urlscan.io/api/v1/scan` with header `API-Key` and body `{url, visibility}`.
  - Poll `GET /api/v1/result/{uuid}/`. It returns 404 until the scan finishes and 410 if the scan was deleted. **Wait at least 30 s** before the first poll.
  - Screenshot at `https://urlscan.io/screenshots/{uuid}.png`; DOM at `https://urlscan.io/dom/{uuid}/` ([quickstart](https://docs.urlscan.io/guides/quickstart.md)).
  - Search: `GET /api/v1/search/?q=page.domain:x`. It works without a key. **Anonymous search limit observed tonight: 30/min per IP** (`x-rate-limit-limit: 30`), with concurrency 10. Per-tier limits are only exposed at `/api/v1/quotas` ([rate limits](https://docs.urlscan.io/pages/api-rate-limits)). Submitting without a key returned 401.
- **Detection philosophy:** detection is content-only and deliberately aggressive, so it accepts false positives. It works from a manually curated brand database and **does not judge by domain name or URL alone** ([brand detection](https://docs.urlscan.io/pages/brand-detection.md)). You can set a custom User-Agent and choose a scan country ([FAQ](https://docs.urlscan.io/pages/faq.md)). You can ask them by email to add UAE brands.
- **Use tonight:** call search first. If someone has already scanned the domain, we get a free screenshot and verdict. Do not submit public scans of victims' URLs, because they could contain personal data. Use `unlisted`.

### 3.2 Cloudflare Radar URL Scanner (we have a token)
- Base `https://api.cloudflare.com/client/v4/accounts/{account_id}/urlscanner/`:
  - `POST v2/scan`, `GET v2/result/{uuid}` (404 while running, so poll every 10–30 s), `GET v2/search?q=`, bulk up to 100 URLs.
  - Options: `customagent`, `referer`, `customHeaders`, and `screenshotsResolutions: desktop|mobile|tablet`.
  - Token permission: *Account > URL Scanner > Edit*.
  - Output: `verdicts.overall.malicious`, `meta.processors.phishing`, Wappalyzer tech stack, certificates, ASNs, page.country.
  - Source: [docs](https://developers.cloudflare.com/radar/investigate/url-scanner/).
- **Limits on the free (Radar) tier:** 5,000 public scans a month, **no unlisted scans**, 1 request per 10 s. Geo-specific scanning is Enterprise-only ([scan limits](https://developers.cloudflare.com/security-center/investigate/scan-limits/), [geo changelog](https://developers.cloudflare.com/changelog/2025-05-07-url-scanner-geoegress/)).
- **Use tonight:** async enrichment for the evidence pack (screenshot, HAR, verdict). It is too slow for the inline decision. Because free scans are public, only send suspicious URLs, never user-specific ones.
- **Cloudflare Radar domain ranking:** `GET /radar/ranking/domain/{domain}` gives an exact rank for the top 100 and a bucket (top 200k, 1M, ...) for the rest ([API](https://developers.cloudflare.com/api/resources/radar/subresources/ranking/subresources/domain/methods/get)). This is a cheap popularity prior.

### 3.3 Netcraft
- Netcraft beats cloaking with **250+ residential proxy nodes** that replicate victims' ISPs and regions, full-render stealth headless browsers that solve proof-of-work and CAPTCHAs, simulated mouse, scroll and touch, consumer-device fingerprints instead of VM ones, and **OCR and computer vision on screenshots** for text drawn as images or on a canvas ([Netcraft: detecting cloaking](https://www.netcraft.com/blog/detecting-cloaking-geofencing-evasion)).
- It claims a median phishing takedown time of 33 minutes ([takedown page](https://www.netcraft.com/anti-phishing/phishing-site-takedown/)). This is marketing and not independently audited. Free public reporting is at report.netcraft.com. I could not read API docs, the page is JS-only **[UNVERIFIED]**.

### 3.4 Bolster / CheckPhish
- A free API key gives **25 scans a day**, and all API requests are limited to 20 per minute. Results include a screenshot path and DOM ([CheckPhish APIs](https://bolster.ai/kbarticles/scan-apis-for-checkphish-users)). Bolster markets computer-vision logo detection ([blog](https://bolster.ai/blog/logo-detection-for-online-brand-protection)), but I could not confirm the free API returns logo matches **[UNVERIFIED]**. It is a sign-up step and low value for us.

### 3.5 VirusTotal
- Public API: **500 requests/day, 4/min, and not to be used in commercial products** ([docs](https://docs.virustotal.com/reference/public-vs-premium-api)). Acceptable for a hackathon demo as a secondary signal, with a sign-up.

### 3.6 ZeroFox, PhishFort, cloaking research
- ZeroFox estimates about 34% of phishing attacks use cloaking, and some pages render only with JavaScript enabled ([ZeroFox](https://www.zerofox.com/blog/phishing-kits-with-cloaked-techniques-the-next-generation-of-phishing-attacks/)).
- Kits match User-Agent against bot keywords and redirect non-matching visitors to benign sites such as Wikipedia. They do geo/IP lookups and carry hard-coded deny-lists of security-vendor IPs and hostnames ([Cofense](https://cofense.com/blog/phishing-kits-uncovered-methods-and-tactics-used-to-evade-segs,-sandboxes,-and-analysts), [Akamai](https://akamai.com/blog/security/catch-me-if-you-can-evasive-and-defensive-techniques-in-phishing)). Some serve a page only once per IP ([Zscaler](https://www.zscaler.com/blogs/security-research/evolution-phishing-kits)).
- The **PhishFarm** study (IEEE S&P 2019) found that simple geo, device or JS cloaking defeated several of the 10 anti-phishing entities tested, and that mobile Chrome, Safari and Firefox showed no blacklist warnings ([paper](https://sefcom.asu.edu/publications/phishfarm-oakland2019.pdf)).
- Client-side JS fingerprinting and timing-based bot checks are catalogued in [arXiv 2509.13186](https://arxiv.org/html/2509.13186v1).
- PhishFort: not researched tonight **[UNVERIFIED]**.

### 3.7 Cloaking techniques and how our design answers them

| Kit technique | Source | Our counter |
|---|---|---|
| UA keyword / bot filtering | Cofense | Replay the **victim's own UA** (phone UA from the gateway) |
| TLS (JA3/JA4) fingerprint mismatch | Netcraft | Browser-impersonating HTTP client (e.g. curl_cffi `impersonate="safari_ios"` / `chrome`) |
| Geo / IP / ASN filtering, vendor IP deny-lists | Netcraft, Cofense | Fetch from the **UAE ISP egress**, never from cloud IPs. Smishing Triad pages reportedly restrict to UAE IPs and mobile devices **[UNVERIFIED; secondary coverage only]** |
| Referrer-only loading | Netcraft | Forward the original Referer when present |
| One visit per IP | Zscaler | Our fetch *is* a visit. Fetch once and cache the evidence for the user and the analyst |
| JS-only rendering, canvas text | ZeroFox, Netcraft | Static JS analysis: flag tiny HTML with heavy obfuscated JS, `atob`/`eval`, `document.write`, WebSocket or Telegram exfil endpoints. Optional async screenshot via Cloudflare/urlscan for OCR |
| Benign redirect for non-targets | Cofense | Treat "redirected to wikipedia/google from a new domain" as a cloaking signal in its own right |

---

## 4. Takedown practice: what the evidence export must contain

- **NetBeacon** (DNS Abuse Institute) is a centralised, free report router to registrars. It uses standard fields: **domain, abuse type, description, date of abuse, supporting evidence** ([PIR launch](https://pir.org/?p=11174), [DNSAI](https://dnsabuseinstitute.org/?p=7642)). [netbeacon.org](https://netbeacon.org/) is live [TESTED].
- **Registrar Stakeholder Group guide** (from search snippets; PDFs not opened tonight) (quoted in [ICANN78 CleanDNS deck](https://gac.icann.org/presentations/public/ICANN78%20-%20Clean%20DNS%20-%20Evidencing%20reports%20of%20DNS%20Abuse.pdf) and [register.ca guide v1.8](https://www.register.ca/local/html/forms/Guide-to-Registrar-Abuse-Reporting-v1.8.pdf)) asks for:
  - readable screenshots and/or links to supporting information;
  - links giving direct evidence of the abuse;
  - **date and time of the abuse including time zone**;
  - the reporter's identity and contact details.
- **ICANN** says a registrar may reasonably expect a report to identify the complainant with contact details. Under the 2024 DNS-abuse amendments, registrars must confirm receipt and investigate under RAA §3.18 ([ICANN advisory](https://www.icann.org/zh/contracted-parties/advisories/documents/advisory-compliance-with-dns-abuse-obligations-in-the-registrar-accreditation-agreement-and-the-registry-agreement-05-02-2024-en)).
- **Cloudflare** (front for many phishing sites) asks for the **specific URL** of the abusive asset and uses its abuse form ([provide specific URLs](https://developers.cloudflare.com/fundamentals/reference/report-abuse/provide-specific-urls/), [report abuse](https://developers.cloudflare.com/fundamentals/reference/report-abuse/)).
- **.ae domains** have no RDAP service. rdap.org returns 404 [TESTED]. Use port-43 WHOIS at `whois.aeda.net.ae`, which returns registrar and registrant [TESTED].

**Evidence-pack schema this implies (one JSON plus a PDF/HTML render per case):**
1. Case ID, detection timestamp (UTC and GST), and gateway/sensor ID.
2. Full original URL, the full redirect chain with each hop's status and timestamp, and the final URL.
3. Verdict, score and reasons, with the impersonated brand and its official domain.
4. Screenshot (PNG) and SHA-256 of the HTML/DOM, the HAR or headers, and the TLS certificate (issuer, SAN, notBefore).
5. WHOIS/RDAP: registrar plus IANA ID, registrar abuse email/phone, creation date, nameservers.
6. Hosting: resolved IPs, ASN, AS name, country, hosting abuse contact (RDAP for the IP via RIPEstat or the RIR).
7. Linked infrastructure: other domains sharing the IP, NS, cert or kit hash (the "network" view).
8. Prepared abuse-email bodies for the registrar, the host or Cloudflare and NetBeacon, plus an Arabic/English summary for police (see the UAE file for the channels).

---

## 5. Free data sources and APIs: callable tonight

Legend: **None** = no sign-up. **Key** = free account or key needed (team lead action). **Card** = billing account.

| # | Source | Endpoint (exact) | Auth / sign-up | Limits | Licence / terms | Use |
|---|---|---|---|---|---|---|
| 1 | **RDAP** (gTLDs, new gTLDs) | Bootstrap `https://data.iana.org/rdap/dns.json`. Then e.g. `https://rdap.verisign.com/com/v1/domain/X`, `https://rdap.centralnic.com/icu/domain/X`, `https://rdap.zdnsgtld.com/top/domain/X`, or the redirector `https://rdap.org/domain/X` [TESTED] | None | Per-registry, unpublished. Cache results | Public registration data | Domain age, registrar, NS |
| 2 | **.ae WHOIS** | TCP 43 `whois.aeda.net.ae` [TESTED] | None | Unpublished, be gentle | aeDA | Registrar, registrant for .ae (no RDAP) |
| 3 | **crt.sh** (Certificate Transparency) | `https://crt.sh/?q=%25keyword%25&output=json&exclude=expired` [TESTED, 2–25 s] | None | Slow and flaky. Do not use inline | Sectigo free service | Look-alike discovery by keyword (tamm, uaepass, salik...); cert age |
| 4 | **CertStream** (live CT) | `wss://certstream.calidog.io/` (site up [TESTED]; websocket not verified) | None | Best effort | Open source | Real-time look-alike alerts. Alternative: self-host certstream-server-go **[UNVERIFIED]** |
| 5 | **WhoisDS NRD** | Daily zip `https://www.whoisds.com/whois-database/newly-registered-domains/{base64(YYYY-MM-DD.zip)}/nrd` [TESTED: 70,000 domains on 24 Nov] | None | 1 file/day. Free list capped at 70k, likely partial | "may be reused, including for commercial purposes, without a license" ([page](https://www.whoisds.com/newly-registered-domains)) | NRD set and fuzzy match to UAE brands |
| 6 | **OpenPhish community feed** | `https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt` [TESTED] (`openphish.com/feed.txt` redirects) | None | Pull every ~12 h **[UNVERIFIED cadence]** | Community licence **[UNVERIFIED; FAQ 404]** | Known-bad URL match |
| 7 | **PhishTank** | `https://data.phishtank.com/data/online-valid.json` returned 404 without app key [TESTED] | **Registration "temporarily disabled"** [TESTED] | n/a | n/a | Skip |
| 8 | **URLhaus** (abuse.ch) | `POST https://urlhaus-api.abuse.ch/v1/url/` (`url=`), `/v1/host/` (`host=`), `GET /v1/urls/recent/` (max 1000) ([docs](https://urlhaus-api.abuse.ch/)) | **Key**: free Auth-Key from https://auth.abuse.ch/, sent as `Auth-Key` header | Fair-use volume limits | **Free = not-for-profit only**; commercial needs a Spamhaus subscription ([ToU §3.1](https://abuse.ch/terms-of-use/)) | Malware URLs (less phishing) |
| 9 | **ThreatFox** (abuse.ch) | `POST https://threatfox-api.abuse.ch/api/v1/` JSON `{"query":"search_ioc","search_term":"..."}`. Returned `Unauthorized` without key [TESTED] ([API](https://threatfox.abuse.ch/api/)) | **Key** (same abuse.ch Auth-Key) | Fair use | Not-for-profit (as above) | IOC/C2 enrichment, low priority |
| 10 | **Google Safe Browsing v4** | `POST https://safebrowsing.googleapis.com/v4/threatMatches:find?key=KEY` ([docs](https://developers.google.com/safe-browsing/v4/lookup-api)) | **Key**: GCP project, enable "Safe Browsing API", create API key | Default quota, viewable in console | **Non-commercial** ([limits](https://developers.google.com/safe-browsing/v4/usage-limits)) | Hard BLOCK signal |
| 11 | **Google Web Risk** | `GET https://webrisk.googleapis.com/v1/uris:search?threatTypes=SOCIAL_ENGINEERING&uri=...&key=KEY` (endpoint form **[UNVERIFIED]**) | **Card**: GCP billing | 100k/month free, then $0.50/1k ([pricing](https://cloud.google.com/web-risk/pricing)) | Commercial OK | Pilot-grade replacement for #10 |
| 12 | **urlscan.io** | Search `GET https://urlscan.io/api/v1/search/?q=domain:X` (no key, 30/min/IP [TESTED]). Scan `POST /api/v1/scan` needs key | **Key** for scans: sign up at https://urlscan.io/user/signup, Settings & API, New API key | Per tier, see `/api/v1/quotas` | urlscan ToS | Prior scans, screenshots, brand verdicts |
| 13 | **Cloudflare URL Scanner** | `POST https://api.cloudflare.com/client/v4/accounts/{acct}/urlscanner/v2/scan` ([docs](https://developers.cloudflare.com/radar/investigate/url-scanner/)) | **Token we already have.** Needs *Account > URL Scanner > Edit* and the account ID | Free: 5,000 public/month, 0 unlisted, 1 per 10 s ([limits](https://developers.cloudflare.com/security-center/investigate/scan-limits/)) | Scans are public | Async screenshot, HAR, verdict for the evidence pack |
| 14 | **Cloudflare Radar ranking** | `GET https://api.cloudflare.com/client/v4/radar/ranking/domain/{domain}` ([API](https://developers.cloudflare.com/api/resources/radar/subresources/ranking/subresources/domain/methods/get)) | Token (Radar read) | Unpublished | Cloudflare ToS | Popularity bucket, avoids FPs on real banks/gov |
| 15 | **Tranco top 1M** | `https://tranco-list.eu/api/lists/date/latest` then `download` URL [TESTED; list Q2464, 23 Nov] or `https://tranco-list.eu/top-1m.csv.zip` | None | Daily | Free; cite Tranco paper; underlying sources have their own licences (some CC BY-NC) ([site](https://tranco-list.eu/)) | Allowlist and popularity prior |
| 16 | **IPtoASN** | `https://iptoasn.com/data/ip2asn-v4.tsv.gz` [TESTED] | None | Hourly updates | **Public domain (PDDL 1.0)** | Offline IP to ASN/country, fastest option |
| 17 | **Team Cymru IP→ASN** | whois `whois.cymru.com` port 43 (` -v IP`) [TESTED] or DNS `IP-reversed.origin.asn.cymru.com TXT` | None | Bulk-friendly | Free service | ASN, AS name |
| 18 | **RIPEstat** | `https://stat.ripe.net/data/network-info/data.json?resource=IP` [TESTED] (also `abuse-contact-finder`) | None | Fair use | RIPE NCC | Prefix, ASN, **abuse contact** for evidence |
| 19 | **VirusTotal** | `GET https://www.virustotal.com/api/v3/domains/{d}` (path **[UNVERIFIED tonight]**) | **Key** (free account) | 500/day, 4/min ([docs](https://docs.virustotal.com/reference/public-vs-premium-api)) | Non-commercial | Secondary reputation |
| 20 | **CheckPhish** | API per [Bolster KB](https://bolster.ai/kbarticles/scan-apis-for-checkphish-users) | **Key** | 25 scans/day | Bolster ToS | Optional |
| 21 | **SerpApi** (Google Search incl. ads, Google Maps, Ads Transparency Center) | `https://serpapi.com/search.json?engine=google&q=...&gl=ae`, `engine=google_maps`, `engine=google_ads_transparency_center` ([ATC API](https://serpapi.com/google-ads-transparency-center-api)) | **Key**: sign-up at https://serpapi.com/users/sign_up (card need **[UNVERIFIED]**) | **Free: 250 searches/month, 50/hour** ([pricing](https://serpapi.com/pricing)) | SerpApi ToS (third-party scraping of Google) | **Covers "fresh ads, search results, Maps listings"**: query e.g. "Salik recharge", "TAMM traffic fine pay", "<bank> customer care" with `gl=ae`, then score every ad/organic/Maps URL and phone number |
| 22 | **Google Places API (New)** | Text Search `POST https://places.googleapis.com/v1/places:searchText` with field mask incl. phone (**[UNVERIFIED path]**) | **Card**: GCP billing | Per-SKU free monthly events since 1 Mar 2025 (Essentials 10k / Pro 5k / Enterprise 1k). Phone is likely "Contact Data", Enterprise ([March 2025 changes](https://developers.google.com/maps/billing-and-pricing/march-2025)) | Google Maps ToS (restricts storage) | Check Maps listings for a brand: compare listed phone/website against the official one |
| 23 | **Google Ads Transparency (BigQuery)** | `bigquery-public-data.google_ads_transparency_center.creative_stats` | GCP project (BigQuery sandbox free tier **[UNVERIFIED]**) | — | — | **Covers EEA and Turkey only**, so useless for UAE ([dev thread](https://discuss.google.dev/t/querying-public-google-ads-transparency-center-table-doesnt-show-all-the-needed-data/177804)) |
| 24 | **Google Custom Search JSON API** | — | — | **Closed to new customers; ends 1 Jan 2027** ([coverage](https://brave.com/learn/google-api-shutdown/)) | — | Do not use |
| 25 | **Brave Search API** | `https://api.search.brave.com/res/v1/web/search?q=` | **Key + card**: $5 monthly credit, about 1,000 queries ([pricing](https://api-dashboard.search.brave.com/documentation/pricing)) | 1 qps | Brave ToS | Organic results only (no ads), backup for #21 |
| 26 | **Meta Ad Library API** | Graph API `ads_archive` | ID verification at facebook.com/ID (takes days) | — | Political/issue ads only outside EU/UK ([3rd-party guide](https://dev.to/odeeb/building-a-facebook-ad-library-scraper-api-limits-and-the-real-approach-3bad)) | Not feasible tonight |

### Sign-ups for the team lead, in priority order (about 15 min total)
1. **Cloudflare:** confirm the existing token has *Account > URL Scanner > Edit* and *Radar read*, and note the **account ID**.
2. **Google Cloud:** create a project, enable **Safe Browsing API**, create an API key (no billing). Optionally enable billing to add Web Risk and Places API.
3. **SerpApi:** free account, copy the API key. This is our only quick route to the search, ads and Maps criterion. Spend the 250 monthly searches on a curated UAE-brand query list.
4. **urlscan.io:** free account, then Settings & API, New API key.
5. **abuse.ch:** https://auth.abuse.ch/ for one Auth-Key that covers URLhaus and ThreatFox. Declare a non-commercial hackathon or research use.
6. Optional: VirusTotal free key.

---

## 6. What to copy, ranked by impact per hour

1. **Brand-impersonation core: an official-domain registry, look-alike matching and a "brand on wrong domain" check.** Build a table of about 40 UAE brands (TAMM, UAE PASS, ICP, ADP, Dubai Police, RTA, Salik, Darb, Emirates Post, Aramex, DEWA, ADDC, Etisalat/du, the top 10 banks, CBUAE, Dubai Opera, Platinumlist ...) with their official domains, keywords (EN and AR) and logos/titles. Signals: (a) a brand keyword in the hostname but not under an official domain, such as `dubaipoli*`, `tamm-*`, `uaepass-*`; (b) edit distance, homoglyph and `rn→m` matching against official domains (Infoblox-style); (c) brand terms in page title or body while the final domain is not official. *This is the strongest signal for UAE smishing and the most visible one to judges. About 2 h.*
2. **Domain age and freshness from RDAP, .ae WHOIS and certificate age, plus Tranco and Cloudflare Radar rank as an allow-prior.** A young domain that is unranked and mentions a brand means BLOCK. An old, top-100k domain on the official list means ALLOW fast, which keeps false positives on real banks and government sites low (Cisco and NextDNS warn that age alone gives false positives). *About 1 h.*
3. **Victim-faithful fetch to defeat cloaking.** Use the victim's UA and Referer, an impersonated TLS fingerprint, UAE egress and a mobile profile. Follow all redirects, including meta-refresh, JS `location` and shorteners, and record every hop. Flag "new domain redirected to a benign site" as cloaking (Netcraft, Cofense). *About 1 h.*
4. **Known-bad list lookups in parallel with a short timeout:** OpenPhish (local set), Safe Browsing v4, a local cache of URLhaus and urlscan search. A hit means BLOCK with high confidence. *About 1 h.*
5. **Payment, credential and OTP form detector on static HTML/JS.** Look for card number, CVV, expiry and OTP inputs, "Emirates ID" fields, and amounts in AED, on a non-official domain. Add JS red flags: obfuscation, `atob`/`eval`, Telegram bot API or WebSocket exfiltration, anti-devtools code. The Smishing Triad flow is fine lookup, then card, then OTP. *About 1.5 h.*
6. **Bilingual lure-phrase scoring**, using the phrase lists in `uae_threat_landscape.md`: small fee plus urgency plus penalty, e.g. "AED 4 … avoid fine and black points today". Arabic and English regex plus a light classifier. *About 1 h.*
7. **Evidence pack plus abuse-report generator** following the section 4 schema. Produce prefilled registrar, host and Cloudflare emails, a NetBeacon-ready field set, and an Arabic/English police summary for Aman / eCrime / MOI. Add a Cloudflare URL Scanner screenshot asynchronously. *About 1.5 h.* This drives the 20% explainability score.
8. **Infrastructure linking ("scam network graph").** Group cases by shared IP/ASN, nameserver, registrar (Gname, 59.cn), cert issuer and time, TLD (.icu/.top), and HTML/JS kit hash. Show "this domain is one of N linked to the same kit". Resecurity linked 146 .icu/.top domains this way. *About 1.5 h.* Novelty points.
9. **Proactive hunting for "early detection".** A daily cron over the WhoisDS NRD file plus a crt.sh/CertStream keyword watch for UAE brand terms. Pre-score the hits and put them on a watch-list before any user clicks. *About 1 h.* Shows coverage of newly registered domains.
10. **Search, ads and Maps sweep via SerpApi.** Every few hours, run about 20 UAE queries ("Salik recharge", "Nol recharge", "TAMM fine payment", "<bank> customer service number", "Dubai Opera tickets") with `gl=ae`. Score every ad, organic and local result and flag phone numbers that do not match the official number. Abu Dhabi Police and RTA have both warned about fake sites ranking in search (see the UAE file). *About 1 h. Nothing else covers this criterion cheaply.*

Optional, if time allows: an LLM judge on extracted text and screenshot for borderline WARN cases only, to keep latency low. Perceptual-hash (pHash) of the screenshot or favicon against official brand pages for "visual similarity".
