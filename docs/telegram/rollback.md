# Telegram live connector: rollback

Use these steps to stop live intake at any point of the controlled test, in this order. Each step on its own is enough
to stop Mirsad storing new live content; later steps remove access at Telegram's end too. Setup is in
[setup.md](setup.md).

## 1. Turn the connector off in Mirsad

Set `TELEGRAM_LIVE_ENABLED=false` in `.env` and restart Mirsad.

- The connector is not created at all; `GET /v1/status` reports `channels.telegram.liveConnector: "disabled"`.
- Clearing any other gate (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_APPROVED_CONNECTION_ID`, `TELEGRAM_APPROVED_CHAT_IDS`,
  `TELEGRAM_APPROVAL_REFERENCE`) has the same effect: the connector refuses to start and logs
  `telegram_live_connector_refused` with the missing names, while the rest of Mirsad keeps running.
- Stopping Mirsad (Ctrl+C) stops the connector immediately; the open long poll is abandoned.

## 2. The owner disconnects the bot

The account owner removes the bot in their own Telegram app (Settings, Telegram Business, Chatbots), or pauses it in a
single chat from that chat's action bar. If Mirsad is still running, the resulting `business_connection` update stops
intake on its own: the connector logs `telegram_live_connector_stopped` with reason `connection_disabled` (or
`connection_changed` if Telegram issued a new connection ID) and status shows the connector disabled.

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

## What happens to data already captured

- Messages, edits, deletions and Mirsad-rendered captures already stored from the approved chats stay in their cases.
  Mirsad never changes or deletes original message text; edits and deletions are separate events.
- Their review status stays `not_permitted`: live content is never sent to any model, before or after rollback.
- Keeping or deleting that evidence follows the approved case retention policy, applied in the approved environment.
  Telegram's terms also require deleting a user's data on request and once it is no longer needed. The prototype has no
  per-message deletion feature; deleting the data directory removes everything in it, fixture cases included.
- Record what happened, and when, in the worksheet and in the controlled-test record's notes.
