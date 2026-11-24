# Telegram live connector: setup for a controlled test

Status: a first approved test on the account owner's own test account began on 2026-11-22; what it observed is in the
[worksheet](event-coverage-worksheet.md). The live connector is tested against a fake Bot API server, and it stays off
(`TELEGRAM_LIVE_ENABLED=false`) until the account owner has approved explicitly scoped test chats and test credentials
are available. Rollback steps are in [rollback.md](rollback.md).

## What the connector does, and what it never does

- It long-polls the Bot API (`getUpdates`, 30-second timeout) for the four business update types only:
  `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages`.
- It stores an update only when it belongs to the approved business connection (`TELEGRAM_APPROVED_CONNECTION_ID`) and
  to a chat in scope: a chat on the approved list (`TELEGRAM_APPROVED_CHAT_IDS`) or, by the owner's decision, any private
  chat of the account (`TELEGRAM_CHAT_SCOPE=all_private`, step 10). Chats on `TELEGRAM_EXCLUDED_CHAT_IDS` and Telegram's
  own service chat are never in scope. Every other update is dropped before storage and only counted: no text, ID or
  name from it is stored or logged.
- It stores through the same intake function as fixture replay, under its own connector principal with the capture
  method `telegram_business_live`. Content captured live is never reviewed for findings: its review status is
  `not_permitted`. The optional reply provider receives eligible text from enrolled chats when replies are enabled (steps 9–10).
- Telegram sends no start-of-conversation marker, so live chats always show `First observed: incoming` or
  `First observed: outgoing`, never `Contact started chat` or `Officer started chat`.
- It cannot send. The Bot API client has four read-only calls (`getMe`, `getWebhookInfo`, `getBusinessConnection`,
  `getUpdates`) and no send, edit, delete or read-marking method. Officer replies from the composer are recorded as
  `Simulated send` and are not delivered anywhere. The opt-in replies of step 9 use a separate sender with one method,
  `sendMessage`, which the connector never holds.
- It stops on its own when a `business_connection` update shows the approved connection disabled, replaced by a new
  connection ID, or owned by someone other than the provisioned account, and when Telegram rejects the token.

## Before any live test: conditions outside this prototype

Telegram's Bot Developer Terms and Content Licensing terms attach conditions to handling business messages. The local
prototype does not meet them on its own; the approved environment for the test must, before the first live message:

1. Encrypt stored data at rest (the database and the evidence directory), with the key kept separately from the data.
   The prototype's local SQLite file and evidence directory are not encrypted.
2. Publish a privacy notice that says what is stored, how, for how long and why.
3. Set a retention limit and provide a way to delete a user's data on request.
4. Use business message content only to provide the service. Sharing eligible reply text with an external provider
   requires the user's authorization under [Telegram Business terms, section 5.4](https://telegram.org/tos/bot-developers#5-4-telegram-business).
5. Never hide the bot's activity from the account owner, and tell the owner about significant changes.
6. Keep AI use of Telegram content off unless everyone in the chat has given explicit, informed consent. It is a
   legal-review item. Mirsad never reviews live content for findings, and its opt-in automated replies (step 9) need
   a consent reference before they start.

You also need the account owner's written approval naming the test chats. Its reference becomes
`TELEGRAM_APPROVAL_REFERENCE`.

## 1. Create the bot

1. In Telegram, open `@BotFather` and send `/newbot`. Choose a name and a username.
2. BotFather replies with the bot token. Treat it as a secret: put it only in `.env` on the test machine. Never put it
   in the repository, a ticket, a chat or a screenshot. Mirsad never logs it, prints it or writes it to a file.

## 2. Turn on business mode

In BotFather, open the bot's settings and turn on Business Mode. The exact menu path was not documented in the pages
read during research; in the first test BotFather called it Secretary Mode. Record the path you used in the worksheet
(row U11). `npm run telegram:verify` confirms the
result: check `bot_can_connect_to_business` passes only when `getMe` reports `can_connect_to_business: true`.

## 3. The owner connects the bot to the approved test chats only

The account owner does this in their own Telegram app (Settings, Telegram Business, Chatbots; the path can differ
between app versions):

1. Choose the bot by its username.
2. Select only the approved test chats, by explicitly choosing those users. Do not choose "all existing chats", "new
   chats", "contacts" or "non-contacts".
3. Grant no rights. Leave replying, reading, deleting and every profile, gift, stars and stories right off. Read-only
   intake needs none; whether Telegram still delivers updates with no rights is one of the things the test observes
   (row U3). Only the opt-in replies of step 9 add one right, Reply to Messages.

To cover every private chat of the account instead, see step 10. Only one business bot can be connected per account. Telegram's documents disagree on whether a Premium subscription is
needed (row U14); confirm on the test account.

## 4. Find the connection ID and the owner's user ID

With `TELEGRAM_BOT_TOKEN` set in `.env` (and the connector still off):

```
npm run telegram:verify -- --discover-connections
```

It prints each pending business connection's ID, owner user ID, enabled status and granted rights. Mirsad displays
recognized rights by name and uses `unrecognized_right` when Telegram reports any other grant.
It makes one short `getUpdates` call that asks for `business_connection` updates and passes no offset, so it confirms
nothing: updates already queued stay queued for the connector. Other pending updates are counted, never read.
Telegram keeps that `allowed_updates=["business_connection"]` setting until the next `getUpdates` call, which is the
connector's first poll in step 8. Message, edit and deletion updates created in between are therefore never queued and
can never be fetched, so start the test conversations only after the log shows `telegram_live_connector_started`.
Do not run it while the connector is running: two pollers on one bot conflict.

## 5. `.env` values

Copy `.env.example` to `.env` (git-ignored) and set:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from BotFather. Secret. |
| `TELEGRAM_APPROVED_CONNECTION_ID` | The connection ID from step 4. |
| `TELEGRAM_APPROVED_CHAT_IDS` | Comma-separated chat IDs of the approved test chats. In a private business chat the chat ID is the contact's Telegram user ID (row U4, observed). |
| `TELEGRAM_APPROVAL_REFERENCE` | The reference of the owner's written approval. |
| `TELEGRAM_LIVE_ENABLED` | Leave `false` until step 8. |
| `TELEGRAM_CHAT_SCOPE`, `TELEGRAM_ALL_CHATS_REFERENCE`, `TELEGRAM_EXCLUDED_CHAT_IDS` | Leave the scope `approved` (the default) unless the owner decides to cover every private chat (step 10). Excluded chat IDs are never stored or answered, in either scope. |

## 6. Provision the live account and connector

```
npm run telegram:provision -- --owner-user-id <owner user ID> --officer "Demo Officer 1" --officer "Demo Officer 2"
```

This creates, in the local database:

- the live channel account: source `telegram`, `externalAccountId` = the owner's user ID;
- the connector principal with the capture method `telegram_business_live`, granted on that account;
- grants for the officers named (by principal ID or exact display name), so they can open the live chats.

It prints IDs only. The connector's token is written only to `<dataDir>/telegram-live-credentials.json` (under the data
directory, which is git-ignored). The connector runs inside Mirsad. A separate intake process using that token can
submit normalized HTTP events for explicitly approved chats while the connector is running in approved scope.
All-private intake requires a raw Telegram update so Mirsad can check chat type and sender before storage.
Running the command again keeps the existing connector and its token and adds any new
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
| `connection_rights_none` | Intake alone accepts zero granted rights. With automated replies enabled, the permitted grants are **Reply to Messages** and optional **Read Messages**. |
| `ai_replies_can_reply` | Telegram reports the reply right for the connection. Checked when automated replies are enabled. |
| `ai_reply_chats_configured` | The approved scope has an eligible reply chat, or all-private intake can enroll contacts directly from their DMs. |
| `ai_reply_consent_configured` | The recorded consent reference is set for automated replies. |
| `approved_chats_configured` | Approved scope has at least one chat ID. All-private scope has a decision reference. Each ID in the active list and the exclusions is a nonzero, safe decimal integer written without leading zeros. |
| `approval_reference_configured` | `TELEGRAM_APPROVAL_REFERENCE` is set. |

It exits 0 only when every check passes. Without a token it lists what is missing and exits 1 without calling Telegram.

## 8. Enable

Set `TELEGRAM_LIVE_ENABLED=true` and restart Mirsad (`npm start`).

- The log shows `telegram_live_connector_started`. If any gate is missing, it shows `telegram_live_connector_refused`
  with the names of the missing settings, and Mirsad keeps running with the connector off.
- `GET /v1/status` reports `channels.telegram.liveConnector: "enabled"` while the connector runs.
- Telegram keeps undelivered updates for up to 24 hours. Updates queued before connection discovery (step 4) arrive on
  the first poll; only those from the approved connection and chats are stored. Message updates created after discovery
  and before that first poll were filtered out by discovery's `allowed_updates` setting and never arrive (step 4).

## 9. Optional automated replies

Record the consent of everyone in each test chat. List those chat IDs in `TELEGRAM_APPROVED_CHAT_IDS`, set
`TELEGRAM_AI_REPLY_CONSENT_REFERENCE` to the consent reference and set `TELEGRAM_AI_REPLIES_ENABLED=true`.
In Telegram Business grant the bot **Reply to Messages**. You can leave **Read Messages** enabled. It allows marking
messages as read on the account's behalf, an action Mirsad does not perform. Run `npm run telegram:verify`, restart Mirsad, then
Dispatch the approved chat or Resume AI if the officer had paused it. The connector and reply worker each log their
startup. LM Studio is the default reply provider. To use OpenRouter for both languages, set
`MIRSAD_REPLY_PROVIDER=openrouter` and place the key in `OPENROUTER_API_KEY` in `.env`. Set
`MIRSAD_OPENROUTER_MODEL=thedrummer/cydonia-24b-v4.1` to use Parasail or `google/gemini-3.8-flash`
to use Google. OpenRouter and the selected host process eligible reply text. Run
`npm run openrouter:verify` with the saved key, then restart the service.
Live evidence stays ineligible for automated findings review.

### Retest from the approved contact account

1. After a previous **Stop**, start a fresh exchange from the same approved account by sending **Hi** or a direct
   question. That message is eligible for a reply after the quiet period. If the contact previously said
   **Never contact me again**, they can ask to talk again in their own words. The dashboard records the return.
2. Send two short messages less than three seconds apart. Mirsad waits at least three seconds after the second one.
   It can issue one reply for the burst or stay silent. Send **Hi** on its own for a brief greeting, then try
   **AI?** and **Are you a bot?** as separate turns. Compare the response when you repeat an answered question.
   The model chooses the words and can leave a turn unanswered. A subsequent stop, edit, deletion or takeover can discard a pending draft.
3. Share a synthetic document. Open the chat in the dashboard and follow the first item's source-message link.
   Automatic replies are still available. Share a second distinct item, such as a Telegram location.
   The dashboard now shows the chat needs officer review. Examine both items and choose **Mark reviewed**
   for each. The case log records each decision. A clearly identified payment link can also count as an item.
   To test the immediate-pause exception, use a fresh synthetic fixture that supplies payment-recipient bank details.
   The source-linked bank-details flag should hold the chat even if this is the first item.
   For documents and native map pins, Mirsad records the type of share. Open the original in Telegram for the file
   or exact pin. A typed address remains part of the source message.
   Each flagged item needs its own review. Marking it reviewed leaves officer controls and contact consent intact.
4. Send **Please stop messaging me** while a reply is pending. The pending reply is cancelled. A closing **Thanks**
   keeps the exchange closed. Start a new one later with **Hi again**. **Stop testing now** from a contact
   cannot switch off the service or change officer controls.

Native location and venue shares count as explicit location evidence. Text recognition is conservative. A location given
as an address or a map pin can trigger review. A city in casual conversation alone does not. Human review is local and
the flag makes no determination of wrongdoing. A Telegram send already submitted before a stop may still be delivered.

Repeated textual payment links, addresses and recipient accounts can be matched within a review cycle. Native files
and pins have only a type marker and a source message. Sending the same file as a separate message can count again.
The portal links to the captured payment instructions. The officer assesses the source and any supplied beneficiary name.

## 10. Optional all-private intake

The default intake scope is the approved list. On a dedicated account with a documented decision to capture other
private chats, set `TELEGRAM_CHAT_SCOPE=all_private` and `TELEGRAM_ALL_CHATS_REFERENCE`, then restart Mirsad.
An officer with access to the connected account can open **Settings** and use **Auto-reply to every Telegram DM**.
The switch takes effect immediately and the selection persists across restarts.

With all-DM replies on, **Test mode** controls automatic Dispatch. The switch starts off on a new installation
and remembers your choice across restarts. An installation that previously disabled **Send consent prompt to new
contacts** already has **Test mode** on.

- **On.** A fresh eligible private message from you or the contact automatically activates new and returning chats.
  Ali waits for an incoming DM and can answer the first one from an approved contact. Other DMs appear in the
  inbox and stay local until permission is recorded. Turning the switch on applies to fresh messages.
- **Switched off in Settings.** New contacts wait for manual Dispatch and receive no invitation. Switching Test
  mode off preserves existing approvals. Active, approved chats can continue automatically.

To record permission for your own account or a participant who already agreed to AI replies and fraud screening,
including sending their messages to Gemini through OpenRouter when configured, open **Dispatch this chat**. Confirm
with **Dispatch test chat** in Test mode or **Dispatch** when Test mode is off. This single confirmation approves
the selected chat and immediately requests a reply to its latest eligible unanswered DM if it is less than 24 hours old.
The contact does not need to write again. Dispatch by phone works the same way for a unique verified match.
Later incoming messages use the usual three-second wait to group consecutive messages. Earlier messages stay outside this new permission.

Installations using the earlier invitation setting can still send consent invitations. When a contact receives one, they can reply
**I AGREE** or **أوافق**, then send the message they want Ali to answer. The AI provider receives only subsequent
eligible messages. **STOP** or **توقف** withdraws consent. Contacts on the pre-approved list use the existing
consent record. Pauses, officer takeover and pending officer reviews still apply. With **Auto-reply to every Telegram DM** off, incoming
DMs continue to appear in the Inbox and Mirsad stops automated messages, including invitations. Turning it back on
applies to new incoming messages. A request already submitted to Telegram can still be delivered.

In Telegram Business, select the private chats the bot should receive, for example **All Private Chats Except…**
on a dedicated account. Only DMs Telegram forwards on the linked connection can appear in Mirsad.

Telegram kept its connection ID when the owner switched the account from Only Selected Chats to All Private Chats
Except… on 2026-11-22 (worksheet U8). Telegram’s service chat and `TELEGRAM_EXCLUDED_CHAT_IDS` are excluded in both
scopes. All-private intake also excludes the account’s own chat, non-private chats and incoming bot messages.
Senderless deletions in that scope are accepted only for previously observed live messages. See [rollback.md](rollback.md)
to withdraw a chat or stop the connector.

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
  - `telegram_live_offset_stale`: the stored position was committed more than 24 hours ago, so polling went on without
    it (see the next point).
- Mirsad keeps its position in the update stream (`connector_state`) and commits it with each stored update, so a
  restart within 24 hours neither loses nor duplicates updates. Telegram keeps undelivered updates for at most 24 hours:
  updates sent while the connector was stopped for longer are gone, and there is no backfill. A position committed more
  than 24 hours ago, found at start or while the connector waits without updates, is treated as stale and the connector
  polls without it, because after a week without updates Telegram numbers new updates from a random value that can be
  lower than the stored position (polling with it would confirm, and lose, those updates).
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
