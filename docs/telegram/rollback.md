# Telegram live connector: rollback

Three actions stop all live intake: turning the connector off in Mirsad (step 1), the account owner removing the bot
(step 2) and revoking the bot token (step 3). Any one of them on its own stops Mirsad storing new live content. For a
full rollback take all three, in this order: step 1 works inside Mirsad at once, whatever Telegram does or still has
queued, and steps 2 and 3 also remove access at Telegram's end.

Nothing else here stops all intake. Steps 4 and 5 are clean-up afterwards and stop nothing.
[Withdraw one chat](#withdraw-one-chat) stops intake from a single chat while the test continues; pausing the bot in a
chat is not a rollback step. Setup is in [setup.md](setup.md).

If automated replies are on (setup step 9), each of steps 1 to 3 stops them too. To stop only the replies and keep
intake running, see [Stop automated replies](#stop-automated-replies).

## Stop automated replies

- **In one chat**, choose **Take over** or **Pause AI** in the dashboard. Once the change succeeds, the worker discards
  drafts from the earlier control revision. Telegram can still deliver a reply that Mirsad already submitted.
- A contact can send **Stop messaging me** to end the exchange. This survives restart and officer actions. The same
  approved contact can open a new exchange with a fresh greeting or direct question. After an explicit **Never contact
  me again**, they can directly invite a reply. See [setup step 9](setup.md).
- **Everywhere:** set `TELEGRAM_AI_REPLIES_ENABLED=false` in `.env` and restart Mirsad. The reply worker is not created
  at all and nothing is sent; the connector keeps storing live messages.
- Clearing `TELEGRAM_AI_REPLY_CONSENT_REFERENCE`, or any live connector gate, also stops them: the worker refuses to
  start and logs `telegram_ai_replies_refused` with the missing names.

## 1. Turn the connector off in Mirsad

Set `TELEGRAM_LIVE_ENABLED=false` in `.env` and restart Mirsad.

- The connector is not created at all; `GET /v1/status` reports `channels.telegram.liveConnector: "disabled"`.
- Clearing any other gate (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_APPROVED_CONNECTION_ID`, `TELEGRAM_APPROVED_CHAT_IDS` in the
  approved scope or `TELEGRAM_ALL_CHATS_REFERENCE` in the all-private scope, `TELEGRAM_APPROVAL_REFERENCE`) has the same
  effect: the connector refuses to start and logs
  `telegram_live_connector_refused` with the missing names, while the rest of Mirsad keeps running.
- Stopping Mirsad (Ctrl+C) stops the connector immediately; the open long poll is abandoned.

## 2. The owner removes the bot

The account owner removes the bot in their own Telegram app (Settings, Telegram Business, Chatbots). That ends the
connection, and Telegram sends a `business_connection` update showing it disabled. When the connector reads that update
it stops, logs `telegram_live_connector_stopped` with reason `connection_disabled` (or `connection_changed` if the
update carries a new connection ID), and status shows the connector disabled. The reply worker then cancels its active
model request, stops taking work and records the outcome of any send it already submitted. If Mirsad was not running at the time,
the updates Telegram queued before the removal are still stored when the connector next starts, up to that update; take
step 1 first if they must not be.

The stop lasts for the running process. Startup uses the saved settings and provisioning. After a revocation, turn off
live intake in `.env` before restarting to keep pending messages out of the reply provider.

Pausing the bot in a single chat is not the same as removing it: see [Withdraw one chat](#withdraw-one-chat).

## 3. Revoke the bot token

In `@BotFather`, use `/revoke` (or `/token` to issue a new one) for the bot. The old token stops working at once; a
running connector stops with reason `token_rejected`, and an automated reply sent with the old token fails and is kept
in the case log as `AI reply failed`. Remove the old token from `.env` and from anywhere else it was copied.

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

To pause all automated Telegram replies immediately, open **Settings** and turn off **Auto-reply to every Telegram DM**.
This also stops new opt-in invitations. Incoming DMs continue to appear for officers. A send already submitted
to Telegram can still complete. The switch stays off across restarts.

To stop intake from one chat while the rest of the test continues, for example when that contact withdraws consent, add
the chat's ID to `TELEGRAM_EXCLUDED_CHAT_IDS` in `.env` (in the all-private scope this is the only way), or remove it
from `TELEGRAM_APPROVED_CHAT_IDS` in the approved scope, and restart Mirsad. From then on the connector
drops every update from that chat before storage, including edits and deletions of its earlier messages, and only
counts it; automated replies, if on, no longer answer it either. If it was the only approved chat, the connector
refuses to start, as in step 1.

To stop covering every private chat but keep the approved ones, set `TELEGRAM_CHAT_SCOPE=approved` (with
`TELEGRAM_APPROVED_CHAT_IDS` set) and `TELEGRAM_AI_AUTO_START=false`, restart Mirsad, and ask the owner to switch the
bot's chat access back to Only Selected Chats. Chats already stored stay, as described below. What was already stored from
the chat stays, as described below. To stop every chat at once, use step 1.

Then ask the owner to take the contact out of the bot's chat selection (Settings, Telegram Business, Chatbots), so that
Telegram stops sending that chat's updates too. Do not rely on this, or on the owner pausing the bot from the chat's
action bar, to stop Mirsad:

- A connection update does not list the selected chats, so the connector cannot tell that a chat was excluded or
  paused. It stops only if Telegram reports the connection disabled or under a new ID (`connection_disabled`,
  `connection_changed`). Otherwise it keeps running and stores whatever Telegram still sends for every chat in scope
  (on `TELEGRAM_APPROVED_CHAT_IDS`, or every private chat in the all-private scope), the excluded or paused chat
  included, unless it is on `TELEGRAM_EXCLUDED_CHAT_IDS`.
- Telegram kept the connection ID when the owner widened the chat selection on 2026-11-22 (worksheet U8).
  Whether excluding or pausing one chat stops delivery of earlier edits and deletions is still open (U9).
- After a stop with `connection_changed`, follow "What to watch" in [setup.md](setup.md) before setting the new ID.

## What happens to data already captured

- Messages, edits, deletions and Mirsad-rendered captures already stored from the approved chats stay in their cases.
  Mirsad never changes or deletes original message text; edits and deletions are separate events.
- Their review status stays `not_permitted`: live content is never reviewed for findings, before or after rollback.
- Automated replies remain in the chat as outgoing messages. Their case actions identify the model used.
  Rolling back stops future requests. It does not retract text previously processed by the reply provider.
  To switch back to local replies, set `MIRSAD_REPLY_PROVIDER=lmstudio` and restart Mirsad.
- Keeping or deleting that evidence follows the approved case retention policy, applied in the approved environment.
  Telegram's terms also require deleting a user's data on request and once it is no longer needed. The prototype has no
  per-message deletion feature; deleting the data directory removes everything in it, fixture cases included.
- Record what happened, and when, in the worksheet and in the controlled-test record's notes.
