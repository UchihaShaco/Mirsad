# Deployment notes

This version of Mirsad keeps all demo evidence local and synthetic. Before real case data is used, Mirsad must run in an
approved environment in the UAE. Case storage, screenshot processing, inference, logs and backups all stay inside that
environment's boundary. Nothing below exists in this repository. Each section says what Mirsad does today and what the
environment has to provide. The README lists which parts are fixture-backed and which need a host integration.

## 1. Case storage

**What Mirsad stores.** Everything lives under `MIRSAD_DATA_DIR`:

- `mirsad.sqlite`, the SQLite database, with its `-wal` and `-shm` side files;
- the evidence directory `evidence/`, which holds the Mirsad-rendered captures as PNG files;
- `demo-credentials.json`, demo only;
- `telegram-live-credentials.json`, only when a live connector has been provisioned.

Original message text is never updated or deleted. Each capture is stored with its SHA-256, which is verified on every
read. Evidence file names are built only from server-generated IDs.

**What the environment must provide.**

- **Location.** Storage located in the UAE, inside the approved boundary.
- **Encryption at rest.** The database and its side files, the evidence directory, temporary files and swap must all be
  encrypted. The local prototype encrypts nothing.
- **Separate key custody.** Keys are held apart from the data, for example in a key management service or hardware
  security module inside the boundary. Key rotation and key access are logged.
- **File access.** The data directory is readable and writable by the service account only.

## 2. Screenshot processing

**What Mirsad does.** Captures are rendered in-process with `@napi-rs/canvas` and the fonts bundled in `assets/fonts/`.
There is no network call and no external rendering service.

**What the environment must provide.**

- Rendering on hosts inside the same boundary as the storage.
- A separate render process or worker thread before production. Rendering currently runs on the service's main thread,
  and a crafted 65,536-character message can stall the service for about 1 to 2 s.
- The same `@napi-rs/canvas` version and fonts on every host, wherever byte-identical re-rendering matters. The text
  SHA-256 on each capture is the integrity anchor across platforms.

## 3. Model inference

**What Mirsad does.** Mirsad calls an OpenAI-compatible endpoint (LM Studio by default) only on a loopback URL. The
configuration rejects any other host, and redirects are refused. The reviewer has no tools and no store access.

**What the environment must provide.**

- **Inference inside the boundary**, on approved model weights and runtime, with no third-party API. A model server on
  another host inside the boundary needs a loopback endpoint on the Mirsad host, such as a local proxy, because the
  loopback-only rule stays in force.
- **A review-policy decision** by the approving authority on which capture methods may be reviewed
  (`MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS`; the default is `fixture_replay` only). Live Telegram content stays excluded
  from every model, local inference included; whether that may ever change is a legal-review item.
- **Capacity** for the expected load. One chat is reviewed at a time; parallel chats are set by
  `MIRSAD_REVIEW_CONCURRENCY`. The local model took 0.2 to 10 s per message in the held-out evaluation.

## 4. Logs

**What Mirsad does.** Mirsad writes JSON lines to standard output, holding IDs, codes, counts and durations. It never
logs message text, quotes, extracted values, phone numbers, display names or tokens.

**What the environment must provide.**

- Log collection, storage, access control and retention inside the boundary.
- Gateways and log shippers configured not to record request or response bodies, or `Authorization` headers.

## 5. Backups

**What the environment must provide.**

- **Encrypted backups, inside the boundary.** Back up the database and the evidence directory together, so that captures
  and their rows stay consistent.
- **A consistent database copy.** The database runs in WAL mode, so copying `mirsad.sqlite` while the service runs is not
  a safe backup. Use SQLite's online backup or a snapshot taken with the service stopped.
- **Tested restores.**
- **Backups under the retention policy.** A deletion must also reach the backups, on the policy's schedule.

## 6. Retention and deletion

**What Mirsad does.** Mirsad never deletes evidence. Edits and deletions reported by a source are kept as separate
events, and the captured original stays available. This version has no retention or deletion feature.

**What the environment must provide.**

- An approved case retention policy.
- A deletion path, including deletion on request where the terms require it. Telegram's terms do.
- That path applied to database rows, evidence files, logs and backups, with each deletion recorded for audit.

## 7. Identity and access

**What Mirsad does.** The demo identity adapter maps bearer tokens from the demo seed to two officers and a fixture
connector. Access is decided in the service: a principal sees a chat only through a grant on its channel account.

**What the environment must provide.**

- **The host's login** in place of the demo identity adapter. Replace the `IdentityProvider` port (`src/ports/identity.ts`,
  design section 3) with an adapter for the host's sign-in.
- **Principals and grants** for officers and channel accounts, taken from the host's directory.
- **Intake credentials.** A connector credential for each intake source, issued, rotated and revoked by the host.
- **No demo data.** Run with `MIRSAD_DEMO_SEED=false`, and no `demo-credentials.json`.

## 8. Network exposure

**What Mirsad does.** The service binds to loopback only and refuses to start on any other host. A request whose `Host`
header is not a loopback name with the bound port gets `403 host_not_allowed`. Mirsad serves plain HTTP, sends no CORS
headers, and rate-limits each token.

**What the environment must provide.**

- **An authenticated gateway in front**, on the same host. It terminates TLS, authenticates users, and forwards to
  `127.0.0.1:<port>`.
- **A rewritten `Host` header.** The gateway must send `Host: 127.0.0.1:<port>`, because many proxies pass the client's
  `Host` header through and Mirsad would refuse it.
- **No other exposure.** Keep the service unreachable except through the gateway.
- **Outbound access only for the live connector.** Mirsad needs no outbound internet access, except Telegram's Bot API
  when an approved live connector is enabled.

## 9. Telegram preconditions

Telegram's Bot Developer Terms and Content Licensing terms attach conditions to handling business messages. These come
from [docs/telegram/setup.md](telegram/setup.md). The environment for any live Telegram test must meet them before the
first live message:

1. Encrypt stored data at rest, the database and the evidence directory, with the key kept separately from the data.
2. Publish a privacy notice that says what is stored, how, for how long and why.
3. Set a retention limit and provide a way to delete a user's data on request.
4. Use business message content only to provide the service, and never share it with third parties or third-party APIs.
5. Never hide the bot's activity from the account owner, and tell the owner about significant changes.
6. Keep AI analysis of Telegram content off. It is a legal-review item, and Mirsad already refuses to review live
   content.

In addition, the account owner's written approval must name the test chats; its reference becomes
`TELEGRAM_APPROVAL_REFERENCE`. The bot token is kept only in `.env` on the test machine. The controlled test, and how to
roll it back, are described in [setup.md](telegram/setup.md) and [rollback.md](telegram/rollback.md).

## 10. Before the first real case

- [ ] Storage in the UAE, encrypted at rest, with keys held separately (section 1).
- [ ] Capture rendering and model inference inside the same boundary (sections 2 and 3).
- [ ] A review policy decided for each capture method (section 3).
- [ ] Logs and backups inside the boundary, with tested restores (sections 4 and 5).
- [ ] A retention and deletion policy, applied to data, logs and backups (section 6).
- [ ] The demo identity adapter replaced, and the demo seed off (section 7).
- [ ] An authenticated gateway in front of the loopback-bound service (section 8).
- [ ] Telegram preconditions met and approvals in hand, before any live test (section 9).
- [ ] An approved host integration for each channel through which composer replies are to be delivered. Until then,
      replies stay `Simulated send`.
