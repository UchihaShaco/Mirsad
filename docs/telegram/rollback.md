# Telegram live connector: rollback

Three actions stop all live intake: turning the connector off in Mirsad (step 1), the account owner removing the bot
(step 2) and revoking the bot token (step 3). Any one of them on its own stops Mirsad storing new live content. For a
full rollback take all three, in this order: step 1 works inside Mirsad at once, whatever Telegram does or still has
queued, and steps 2 and 3 also remove access at Telegram's end.

Nothing else here stops all intake. Steps 4 and 5 are clean-up afterwards and stop nothing.
[Withdraw one chat](#withdraw-one-chat) stops intake from a single chat while the test continues; pausing the bot in a
chat is not a rollback step. Setup is in [setup.md](setup.md).

## 1. Turn the connector off in Mirsad

Set `TELEGRAM_LIVE_ENABLED=false` in `.env` and restart Mirsad.

- The connector is not created at all; `GET /v1/status` reports `channels.telegram.liveConnector: "disabled"`.
- Clearing any other gate (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_APPROVED_CONNECTION_ID`, `TELEGRAM_APPROVED_CHAT_IDS`,
  `TELEGRAM_APPROVAL_REFERENCE`) has the same effect: the connector refuses to start and logs
  `telegram_live_connector_refused` with the missing names, while the rest of Mirsad keeps running.
- Stopping Mirsad (Ctrl+C) stops the connector immediately; the open long poll is abandoned.

## 2. The owner removes the bot

The account owner removes the bot in their own Telegram app (Settings, Telegram Business, Chatbots). That ends the
connection, and Telegram sends a `business_connection` update showing it disabled. When the connector reads that update
it stops, logs `telegram_live_connector_stopped` with reason `connection_disabled` (or `connection_changed` if the
update carries a new connection ID), and status shows the connector disabled. If Mirsad was not running at the time,
the updates Telegram queued before the removal are still stored when the connector next starts, up to that update; take
step 1 first if they must not be.

Pausing the bot in a single chat is not the same as removing it: see [Withdraw one chat](#withdraw-one-chat).

## 3. Revoke the bot token

In `@BotFather`, use `/revoke` (or `/token` to issue a new one) for the bot. The old token stops working at once; a
running connector stops with reason `token_rejected`. Remove the old token from `.env` and from anywhere else it was
copied.

## 4. Webhook state

Mirsad never sets a webhook: it uses long polling, and its Bot API client has no method to set or delete one. If some
other tool set a webhook on this bot, `npm run telegram:verify` reports `polling_transport` as failed. Remove the
webhook with the Bot API's `deleteWebhook` call from a trusted machine, decide deliberately whether to pass
`drop_pending_updates`, and record that decision in the test notes.

## 5. Mirsad's own records of the connector

- The live channel account and the `telegram_business_live` connector principal stay in the database so the captured
  evidence keeps its provenance. The connector's position in the update stream stays in `connector_state`; if the
  connector is approved and enabled again, it resumes from there (updates older than 24 hours are gone at Telegram).
- Delete `<dataDir>/telegram-live-credentials.json` if that connector token will not be used again. The in-process
  connector never needs it.

## Withdraw one chat

To stop intake from one approved chat while the rest of the test continues, for example when that contact withdraws
consent, remove the chat's ID from `TELEGRAM_APPROVED_CHAT_IDS` in `.env` and restart Mirsad. From then on the connector
drops every update from that chat before storage, including edits and deletions of its earlier messages, and only
counts it. If it was the only approved chat, the connector refuses to start, as in step 1. What was already stored from
the chat stays, as described below. To stop every chat at once, use step 1.

Then ask the owner to take the contact out of the bot's chat selection (Settings, Telegram Business, Chatbots), so that
Telegram stops sending that chat's updates too. Do not rely on this, or on the owner pausing the bot from the chat's
action bar, to stop Mirsad:

- A connection update does not list the selected chats, so the connector cannot tell that a chat was excluded or
  paused. It stops only if Telegram reports the connection disabled or under a new ID (`connection_disabled`,
  `connection_changed`). Otherwise it keeps running and stores whatever Telegram still sends for every chat on
  `TELEGRAM_APPROVED_CHAT_IDS`, the excluded or paused chat included.
- Whether Telegram reports either change at all, issues a new connection ID for it, or still sends edits and deletions
  of the chat's earlier messages is untested (worksheet rows U8 and U9).
- After a stop with `connection_changed`, follow "What to watch" in [setup.md](setup.md) before setting the new ID.

## What happens to data already captured

- Messages, edits, deletions and Mirsad-rendered captures already stored from the approved chats stay in their cases.
  Mirsad never changes or deletes original message text; edits and deletions are separate events.
- Their review status stays `not_permitted`: live content is never sent to any model, before or after rollback.
- Keeping or deleting that evidence follows the approved case retention policy, applied in the approved environment.
  Telegram's terms also require deleting a user's data on request and once it is no longer needed. The prototype has no
  per-message deletion feature; deleting the data directory removes everything in it, fixture cases included.
- Record what happened, and when, in the worksheet and in the controlled-test record's notes.
