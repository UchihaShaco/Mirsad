# Deployment notes

The fixture walkthrough uses synthetic conversations. A provisioned Telegram Business connection can store real messages
and deliver automated replies. The project calls for an approved environment in the UAE before using real case data.
Record where evidence, logs and backups reside and whether the deployment permits conversation data to leave for inference.
For installation, first sign-in and startup commands, see the [README](../README.md).

## 1. Case storage

**Application data.** Mirsad writes these files under `MIRSAD_DATA_DIR`.

- `mirsad.sqlite`, the SQLite database, along with its `-wal` and `-shm` side files.
- `evidence/`, which holds the Mirsad-rendered PNG captures.
- `demo-credentials.json`, created by the demo seed.
- `telegram-live-credentials.json`, which holds the Mirsad intake credential issued during live provisioning.

Intake records source edits and deletions as separate events. Each capture has a SHA-256 digest that Mirsad verifies on
read. Evidence file names use server-generated IDs. Confirmed erasure is described in section 6.

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

**Case review.** `MIRSAD_REVIEWER` defaults to `lmstudio`. Its endpoint must be on loopback. The reviewer has no tools
or store access. `MIRSAD_REVIEW_ALLOWED_CAPTURE_METHODS` defaults to `fixture_replay`. The review policy always excludes
live Telegram captures from this worker.

**Live Telegram replies and screening.** `TELEGRAM_AI_REPLIES_ENABLED` defaults to `false`. When enabled for a
permitted conversation, Ali's reply model receives eligible conversation text and can return a reply, choose silence or
flag a concern for an officer. The request can also include earlier seller context, an officer's dispatch brief and
payment-link candidates. Choose the reply provider independently of the case reviewer.

- `MIRSAD_REPLY_PROVIDER=lmstudio` is the default. Reply requests go to a loopback endpoint.
- `MIRSAD_REPLY_PROVIDER=openrouter` sends that context to OpenRouter and the provider serving the selected
  `MIRSAD_OPENROUTER_MODEL`. It requires `OPENROUTER_API_KEY`. The supported hosted models are
  `google/gemini-3.8-flash` and `thedrummer/cydonia-24b-v4.1`. Gemini is the default within the OpenRouter option.

**What the environment must provide.**

- Approve the capture methods used for case review. Size local inference for the number of chats reviewed concurrently
  (`MIRSAD_REVIEW_CONCURRENCY`).
- For deployments that require inference inside the boundary, keep the reply provider on LM Studio and run its model
  there. Before selecting OpenRouter for live chats, approve the external processing, destination and retention terms
  and record permission covering the content sent. Section 9 covers the Telegram controls.

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

**What Mirsad does.** Starting a fresh test preserves earlier evidence. An officer can separately confirm erasure of one
chat or the officer's entire inbox. Local erasure covers messages, case history, captures and Ali's conversation memory.
Opt-out controls and records needed to prevent re-ingestion survive. If the officer also needs to clear Telegram history,
use **Delete from Telegram for both** before local erasure, check the result and clear any remaining history in Telegram.
Mirsad can request Telegram deletion only for eligible messages it knows about.

**What the environment must provide.**

- An approved case retention policy.
- A process for retention deadlines and deletion requests, covering the application, logs and backups. Record the outcome
  and any follow-up required in Telegram or with a hosted model provider.

## 7. Identity and access

**What Mirsad does.** The demo seed issues bearer tokens for two officers and a fixture connector. A live officer
can sign in with a local username and password after the Telegram account has been provisioned. The operator sets a
temporary password using `npm run officer:create -- <username>`. The officer chooses a new password at first sign-in
and receives an eight-hour session. To reset it, run `npm run officer:create -- --reset <username>`. A password reset
revokes that officer's existing sessions. Each officer sees only chats on accounts the service has granted them.

**What the environment must provide.**

- **Host sign-in integration** if the deployment requires organizational single sign-on. The integration point is the
  `IdentityProvider` port in `src/ports/identity.ts`.
- **Principals and grants** for officers and channel accounts, taken from the host's directory.
- **Intake credentials.** A connector credential for each intake source, issued, rotated and revoked by the host.
- **A separate live data directory.** Set `MIRSAD_DEMO_SEED=false` before initializing it. Turning off seeding does
  not remove credentials previously issued in a demo directory.
- **Restricted secrets.** Keep the Telegram bot token, any OpenRouter key and generated intake credentials accessible
  only to the appropriate operators and service account. Keep credential files and the local `.env` out of source control.

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
- **Outbound destinations.** Permit HTTPS to `api.telegram.org` for live Telegram operation. If OpenRouter is selected,
  the reply client also needs HTTPS to `openrouter.ai`. A fixture walkthrough with local inference can run offline
  after dependencies, fonts and model weights are available.

## 9. Telegram preconditions

Before enabling live intake, record the account owner's approval in `TELEGRAM_APPROVAL_REFERENCE`. The default
`TELEGRAM_CHAT_SCOPE=approved` uses an explicit list. An owner-approved all-private scope also requires
`TELEGRAM_ALL_CHATS_REFERENCE`. Provide encrypted storage with separate key custody, a privacy notice, a retention
limit and a deletion process. Inform the account owner about the bot's activity and significant changes.

For automated replies, record informed participant permission for replies and screening, including any authorized
external processing, and set `TELEGRAM_AI_REPLY_CONSENT_REFERENCE`. **Test mode** controls automatic Dispatch.
A contact can be marked **AI active** while the worker still waits for recorded permission to use a reply model.
See the [live setup and permission flow](telegram/setup.md) and [rollback procedure](telegram/rollback.md).

## 10. Before the first real case

- [ ] Storage in the UAE, encrypted at rest, with keys held separately (section 1).
- [ ] Capture rendering inside the approved boundary and a documented processing destination for each model path
      (sections 2 and 3).
- [ ] A review policy decided for each capture method (section 3).
- [ ] Logs and backups inside the boundary, with tested restores (sections 4 and 5).
- [ ] A retention and deletion policy, applied to data, logs and backups (section 6).
- [ ] Officer authentication and account grants approved, with the demo seed off and live credentials protected (section 7).
- [ ] An authenticated gateway in front of the loopback-bound service (section 8).
- [ ] Telegram preconditions met and approvals in hand, before any live test (section 9).
- [ ] An approved host integration for each channel through which composer replies are to be delivered. Until then,
      replies stay `Simulated send`.
