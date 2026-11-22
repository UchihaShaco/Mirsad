# Telegram live connector: setup for a controlled test

Status: prepared, not run. The live connector is built and tested only against a fake Bot API server. No approved test
access exists yet, so nothing here has been run against Telegram, and the connector stays off
(`TELEGRAM_LIVE_ENABLED=false`) until the account owner has approved explicitly scoped test chats and test credentials
are available. Rollback steps are in [rollback.md](rollback.md).

## What the connector does, and what it never does

- It long-polls the Bot API (`getUpdates`, 30-second timeout) for the four business update types only:
  `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages`.
- It stores an update only when it belongs to the approved business connection (`TELEGRAM_APPROVED_CONNECTION_ID`) and
  to a chat on the approved list (`TELEGRAM_APPROVED_CHAT_IDS`). Every other update is dropped before storage and only
  counted: no text, ID or name from it is stored or logged.
- It stores through the same intake function as fixture replay, under its own connector principal with the capture
  method `telegram_business_live`. Content captured live is never sent to any model, including local inference; its
  review status is `not_permitted`.
- Telegram sends no start-of-conversation marker, so live chats always show `First observed: incoming` or
  `First observed: outgoing`, never `Contact started chat` or `Officer started chat`.
- It cannot send. The Bot API client has four read-only calls (`getMe`, `getWebhookInfo`, `getBusinessConnection`,
  `getUpdates`) and no send, edit, delete or read-marking method. Officer replies from the composer are recorded as
  `Simulated send` and are not delivered anywhere.
- It stops on its own when a `business_connection` update shows the approved connection disabled, replaced by a new
  connection ID, or owned by someone other than the provisioned account, and when Telegram rejects the token.

## Before any live test: conditions outside this prototype

Telegram's Bot Developer Terms and Content Licensing terms attach conditions to handling business messages. The local
prototype does not meet them on its own; the approved environment for the test must, before the first live message:

1. Encrypt stored data at rest (the database and the evidence directory), with the key kept separately from the data.
   The prototype's local SQLite file and evidence directory are not encrypted.
2. Publish a privacy notice that says what is stored, how, for how long and why.
3. Set a retention limit and provide a way to delete a user's data on request.
4. Use business message content only to provide the service, and never share it with third parties or third-party
   APIs.
5. Never hide the bot's activity from the account owner, and tell the owner about significant changes.
6. Keep AI analysis of Telegram content off. It is a legal-review item; Mirsad already refuses to review live content.

You also need the account owner's written approval naming the test chats. Its reference becomes
`TELEGRAM_APPROVAL_REFERENCE`.

## 1. Create the bot

1. In Telegram, open `@BotFather` and send `/newbot`. Choose a name and a username.
2. BotFather replies with the bot token. Treat it as a secret: put it only in `.env` on the test machine. Never put it
   in the repository, a ticket, a chat or a screenshot. Mirsad never logs it, prints it or writes it to a file.

## 2. Turn on business mode

In BotFather, open the bot's settings and turn on Business Mode. The exact menu path was not documented in the pages
read during research; record the path you used in the worksheet (row U11). `npm run telegram:verify` confirms the
result: check `bot_can_connect_to_business` passes only when `getMe` reports `can_connect_to_business: true`.

## 3. The owner connects the bot to the approved test chats only

The account owner does this in their own Telegram app (Settings, Telegram Business, Chatbots; the path can differ
between app versions):

1. Choose the bot by its username.
2. Select only the approved test chats, by explicitly choosing those users. Do not choose "all existing chats", "new
   chats", "contacts" or "non-contacts".
3. Grant no rights. Leave replying, reading, deleting and every profile, gift, stars and stories right off. Read-only
   intake needs none; whether Telegram still delivers updates with no rights is one of the things the test observes
   (row U3).

Only one business bot can be connected per account. Telegram's documents disagree on whether a Premium subscription is
needed (row U14); confirm on the test account.

## 4. Find the connection ID and the owner's user ID

With `TELEGRAM_BOT_TOKEN` set in `.env` (and the connector still off):

```
npm run telegram:verify -- --discover-connections
```

It prints each pending business connection: connection ID, owner user ID, enabled or disabled, and any rights granted.
It makes one short `getUpdates` call that asks for `business_connection` updates and passes no offset, so it confirms
nothing and the connector still receives every pending update later. Other pending updates are counted, never read.
Do not run it while the connector is running: two pollers on one bot conflict.

## 5. `.env` values

Copy `.env.example` to `.env` (git-ignored) and set:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from BotFather. Secret. |
| `TELEGRAM_APPROVED_CONNECTION_ID` | The connection ID from step 4. |
| `TELEGRAM_APPROVED_CHAT_IDS` | Comma-separated chat IDs of the approved test chats. In a private business chat the chat ID is normally the contact's Telegram user ID; the test confirms this (row U4). |
| `TELEGRAM_APPROVAL_REFERENCE` | The reference of the owner's written approval. |
| `TELEGRAM_LIVE_ENABLED` | Leave `false` until step 8. |

## 6. Provision the live account and connector

```
npm run telegram:provision -- --owner-user-id <owner user ID> --officer "Demo Officer 1" --officer "Demo Officer 2"
```

This creates, in the local database:

- the live channel account: source `telegram`, `externalAccountId` = the owner's user ID;
- the connector principal with the capture method `telegram_business_live`, granted on that account;
- grants for the officers named (by principal ID or exact display name), so they can open the live chats.

It prints IDs only. The connector's token is written only to `<dataDir>/telegram-live-credentials.json` (under the data
directory, which is git-ignored). The connector runs inside Mirsad and does not use that token; keep the file for audit
or for a separate intake process. Running the command again keeps the existing connector and its token and adds any new
officer grants. It refuses a second owner account: one connector serves one owner. Pass `--workspace <id>` when the
database holds more than one workspace.

## 7. Verify

```
npm run telegram:verify
```

It calls `getMe`, `getWebhookInfo` and `getBusinessConnection` only (it reads no messages) and prints one line per check:

| Check | Passes when |
|---|---|
| `token_accepted` | Telegram accepts the token. |
| `bot_can_connect_to_business` | Business mode is on. |
| `polling_transport` | No webhook is set, so long polling can be used. |
| `connection_enabled` | The approved connection exists and is enabled. |
| `connection_owner_provisioned` | Its owner is the account provisioned in step 6. |
| `connection_rights_none` | No rights are granted. |
| `approved_chats_configured` | `TELEGRAM_APPROVED_CHAT_IDS` is set. |
| `approval_reference_configured` | `TELEGRAM_APPROVAL_REFERENCE` is set. |

It exits 0 only when every check passes. Without a token it lists what is missing and exits 1 without calling Telegram.

## 8. Enable

Set `TELEGRAM_LIVE_ENABLED=true` and restart Mirsad (`npm start`).

- The log shows `telegram_live_connector_started`. If any gate is missing, it shows `telegram_live_connector_refused`
  with the names of the missing settings, and Mirsad keeps running with the connector off.
- `GET /v1/status` reports `channels.telegram.liveConnector: "enabled"` while the connector runs.
- Telegram keeps undelivered updates for up to 24 hours. Updates queued before you enabled the connector arrive on the
  first poll; only those from the approved connection and chats are stored.

## What to watch during the test

- `GET /v1/status`: `liveConnector` turns `disabled` when the connector stops for any reason.
- Log events (IDs, codes and counts only):
  - `telegram_live_batch`: per poll, the number of updates received, stored, duplicates, rejected and dropped. A rising
    dropped count means updates from outside the approved scope are arriving: check the owner's chat selection.
  - `telegram_live_poll_failed`: a failed poll by code, status and attempt. Polls are retried with growing delays (up
    to a minute).
  - `telegram_live_connector_stopped` with a reason: `connection_disabled` (the owner disabled or removed the bot),
    `connection_changed` (Telegram issued a new connection ID, for example after the owner edited the chat selection;
    re-run discovery and update `TELEGRAM_APPROVED_CONNECTION_ID` only if the new scope is still the approved one),
    `connection_owner_mismatch`, `token_rejected`, or `stopped` (normal shutdown).
  - `telegram_live_update_rejected`: an update in scope that intake refused, by error code.
- Mirsad keeps its position in the update stream (`connector_state`) and commits it with each stored update, so a
  restart neither loses nor duplicates updates. Downtime longer than 24 hours loses updates; there is no backfill.
- Fill in [event-coverage-worksheet.md](event-coverage-worksheet.md) as events are observed, including which
  officer-sent messages actually arrive.

## Recording the result

- Local readiness: `npm run telegram:readiness` runs the eight local checks against a temporary instance and writes
  `readiness.json` and `readiness.md` here. Status then reports `Ready for controlled test`.
- After the approved test, write `docs/telegram/controlled-test-record.json` by hand from what was observed. The schema
  is in `src/contract/controlled-test-record.ts`: approval reference, test date, tester, approved scope (connection ID
  and chat IDs), per-event coverage (`passed`, `failed` or `not_observed` for fixture replay and live capture) and the
  manual reply result. Status reports `Controlled test verified` only when the record validates, the manual reply
  passed, at least one event was captured live, nothing failed, and the approval reference matches
  `TELEGRAM_APPROVAL_REFERENCE` when that is set. No code in Mirsad writes this file.
- [controlled-test-record.example.json](controlled-test-record.example.json) shows the shape with fictional values.
  Never copy it as the real record. Its approval reference starts with `EXAMPLE-ONLY-`, and a record whose reference
  starts that way is never counted as verified, whatever its results and whether or not `TELEGRAM_APPROVAL_REFERENCE`
  is set.
- A verified record is also what allows `MIRSAD_WHATSAPP_IMPORT_ENABLED=true` (see `docs/whatsapp/import-plan.md`).
