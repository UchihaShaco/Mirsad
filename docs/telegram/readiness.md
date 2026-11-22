# Telegram readiness

State: **Ready for controlled test** (`ready_for_controlled_test`)

Recorded at: 2026-11-22T01:34:09.511Z

Written by `npm run telegram:readiness`. It runs the local checks of design section 13 against a temporary Mirsad instance (temporary data directory, demo seed, deterministic reviewer) using only the synthetic fixtures in `fixtures/telegram/`, through the HTTP API. This run can never report `Controlled test verified`: that needs a controlled-test record written after an approved live test (see `setup.md`).

## Fixture replay

| Check | Result | Detail |
|---|---|---|
| An inbound-first chat is flagged New inbound | passed | inbox status new_inbound; origin label First observed: incoming |
| An officer-first chat shows both directions | passed | 2 messages, directions outgoing, incoming; origin label First observed: outgoing |
| Every received message has its own capture | passed | 21 received messages and 1 edit in 9 chats; 22 distinct ready captures |
| An edit and a deletion are separate events and the original stays | passed | 1 message; separate events edited, deleted; original text unchanged |
| A redelivered update creates nothing new | passed | 6 of 6 redelivered updates answered duplicate_event; 2 chats unchanged |
| Officer-sent fixture messages arrive and are labelled outgoing | passed | 2 of 2 owner-sent messages arrived labelled outgoing, each with a capture; 4 incoming |
| A takeover followed by a composer reply is recorded as Simulated send | passed | AI mode officer_control; 1 composer message recorded as Simulated send; nothing delivered to Telegram |
| The live connector refuses to start without its gates | passed | each of 5 settings and the provisioned connector principal named when missing; 0 Bot API calls made |

## Live capture

Pending: needs the account owner's approval of explicitly scoped test chats and test credentials. Until then the live connector stays disabled (`TELEGRAM_LIVE_ENABLED=false`). Record what the approved test covers in `event-coverage-worksheet.md` and in the controlled-test record.

## Manual officer reply

Simulated send verified locally: check `takeover_simulated_send` passed. Real delivery from the composer is pending an approved host integration for the channel; Mirsad has no code path that sends to Telegram.
