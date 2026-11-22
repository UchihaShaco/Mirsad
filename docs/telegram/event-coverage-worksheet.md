# Telegram event coverage worksheet

Fill this in during the controlled test. One row per event kind, then one row per open question from research (the
documents are silent on these; only a live test can answer them). The "Fixture replay" column states what the synthetic
fixtures in `fixtures/telegram/` (and the fake Bot API tests) already cover. The live columns stay
"pending approved test" until an approved test has run; write what was actually observed, including "not observed".

Columns:

- Fixture replay: covered locally, and where.
- Live capture: did the event arrive through the live connector, and was it stored correctly?
- Manual officer reply: with the chat under takeover, did the officer's reply from the composer behave as expected
  (recorded once as `Simulated send`; nothing is delivered to Telegram from this prototype)?

## Event kinds

| # | Event kind | Fixture replay | Live capture | Manual officer reply |
|---|---|---|---|---|
| E1 | Incoming text message from the contact (`business_message`) | Covered: `inbound-first-greeting.json`, `takeover-pair.json` and others. A new chat enters New inbound with `First observed: incoming`; each message gets its own capture. | pending approved test | pending approved test |
| E2 | Message the owner typed in their own Telegram app (`business_message`, `from` = owner) | Covered: `officer-first.json`, `payment-destination-change.json`. Labelled outgoing, captured, `First observed: outgoing` when first. | pending approved test (see U1) | pending approved test |
| E3 | Reply sent by a bot (`sender_business_bot` set) | Adapter maps it to outgoing (unit test). No replay fixture: Mirsad never sends, so only another tool could produce it. | pending approved test (see U2) | pending approved test |
| E4 | Message with media or a caption (photo, document, voice, sticker and the other kinds) | Adapter unit test: the caption becomes the text and media kinds are listed as unsupported content. No replay fixture. | pending approved test | pending approved test |
| E5 | Contact card the contact shares about themselves (`contact.user_id` = sender) | Covered: `watchlist-sequence.json`, `merchant-conflict.json`. Supplies the sender phone (sender metadata) for the Phone watchlist. | pending approved test (phone format: U12 notes) | pending approved test |
| E6 | Contact card about someone else | Adapter unit test: never used as the sender's phone. No replay fixture. | pending approved test | pending approved test |
| E7 | Edited message (`edited_business_message`) | Covered: `edit-and-delete.json`. A separate edited event with its own capture; the original text stays. | pending approved test (see U6) | pending approved test |
| E8 | Deleted messages (`deleted_business_messages`) | Covered: `edit-and-delete.json`. A separate deleted event; the captured message stays available. | pending approved test (see U7) | pending approved test |
| E9 | The same update delivered again | Covered: `edit-and-delete.json` (redelivered update) and replaying any fixture twice; fake Bot API test after a restart. Answered `duplicate_event`; nothing new is stored. | pending approved test | pending approved test |
| E10 | Business connection disabled, changed or for another owner (`business_connection`) | Fake Bot API test: disabled, a new connection ID for the owner, or another owner on the approved ID stops intake; another owner's connection is dropped and counted. Replay fixtures carry none. | pending approved test (see U8) | pending approved test |
| E11 | Update for a connection other than the approved one | Fake Bot API test: dropped before storage and counted; no ID, name or text kept or logged. | pending approved test | pending approved test |
| E12 | Update for a chat that is not on the approved list | Fake Bot API test: dropped before storage and counted; no ID, name or text kept or logged. | pending approved test (see U9) | pending approved test |
| E13 | Message with `message_id` 0 | Adapter unit test: skipped, since it cannot be deduplicated. | pending approved test | pending approved test |
| E14 | Start of a conversation | Fixtures may assert a start for tests only (`conversationStarts`); none of the shipped fixtures does. Live updates carry no marker, so live chats always show `First observed: ...`. | pending approved test | pending approved test |
| E15 | Officer reply from the composer during takeover | `Simulated send` verified locally (readiness check `takeover_simulated_send`; channel contract test). | pending approved test | pending approved test. Real delivery needs an approved host integration, which is not built. |
| E16 | Leave unanswered during takeover | Verified locally (channel contract test): only an internal case action; capture of later messages continues. | pending approved test | pending approved test |
| E17 | Formatted link: a `text_link` entity in `entities` or `caption_entities`, whose URL is not part of the visible text | Adapter unit test and replay test: the text is stored exactly as shown and `text_link` is listed as unsupported content (capture row "Unsupported content", timeline "Not captured"). The hidden URL is not stored in this version, so it is never reviewed or compared with a merchant confirmation. An edit cannot list it, so an edit that changes only the URL is recorded with unchanged text. No shipped fixture. | pending approved test (note whether the URL arrives in `entities`) | pending approved test |
| E18 | Message with buttons (`reply_markup.inline_keyboard`, for example sent through an inline bot) | Adapter unit test: `inline_keyboard` is listed as unsupported content; button labels and URLs are not stored. No shipped fixture. | pending approved test | pending approved test |
| E19 | Forwarded message (`forward_origin` set) | Adapter unit test and replay test: the forwarded text or media is stored as usual and `forwarded` is listed as unsupported content; who or where it came from is not stored. No shipped fixture. | pending approved test | pending approved test |
| E20 | Content of a kind Mirsad does not recognise (a story, a dice, a game, an invoice and so on), with no text and no known media kind | Adapter unit test and replay test: `other` is listed as unsupported content, so the message still gets its own capture. An unrecognised kind that comes with a caption (paid media, for example) keeps the caption as its text and is not listed. No shipped fixture. | pending approved test | pending approved test |

## Open questions to observe

| # | Open question (from research) | Fixture replay | Live capture | Manual officer reply |
|---|---|---|---|---|
| U1 | Do messages the owner types in their own Telegram app arrive as `business_message`? | Fixtures assume they do (E2). | pending approved test | pending approved test |
| U2 | Do the bot's own replies come back as `business_message` updates, with `sender_business_bot` set? | Not covered; Mirsad sends nothing. | pending approved test | pending approved test |
| U3 | Are business updates delivered when the connection grants no rights at all? | Not coverable locally. | pending approved test | pending approved test |
| U4 | Does `chat.id` equal the contact's user ID in business private chats? | Fixtures assume it does. | pending approved test | pending approved test |
| U5 | Do offline messages (away, greeting or scheduled) arrive as `business_message` with `from` = owner? | Not covered. | pending approved test | pending approved test |
| U6 | Do several edits made while the bot is offline arrive as one update (latest state) or several? | Fixtures cover one edit. | pending approved test | pending approved test |
| U7 | Does `deleted_business_messages` fire for "delete for me", for deletions by the owner versus the contact, and for messages sent before the connection? | Fixtures cover one deletion. | pending approved test | pending approved test |
| U8 | Does the business connection ID change when the owner edits the selected chats or the rights? | Fake Bot API test: a changed ID stops intake. | pending approved test | pending approved test |
| U9 | Does excluding or pausing a chat stop all its updates, including edits and deletions of earlier messages? | Not covered. | pending approved test | pending approved test |
| U10 | Can group chats ever produce `business_message`? | Not covered. | pending approved test | pending approved test |
| U11 | What are the exact BotFather path for business mode and the app path for connecting a bot and choosing chats? | Not a fixture item. Record the paths used during setup. | pending approved test | not a test item |
| U12 | What are the exact Bot API error texts for an invalid or not-allowed business connection? Also note the format of `contact.phone_number`. | The fake server uses an assumed text. | pending approved test | not a test item |
| U13 | Does local model inference over Telegram content count as "deploy" or "engage" under the Content Licensing terms, section 2? | Not a test item: legal review. Mirsad keeps live content out of every model regardless. | not a test item | not a test item |
| U14 | Is a Premium subscription needed to connect a business bot (the terms and Bot API 10.0 disagree)? | Not a fixture item. | pending approved test | not a test item |
| U15 | Do older Bot API changelog entries, outside the part read during research, change any of the above? | Not a test item: documentation review. | not a test item | not a test item |
| U16 | Do service messages (a pinned message, for example) arrive as `business_message`, and with which fields? | Not covered. Such a message, with no text and no known media kind, would be listed as `other` (E20). | pending approved test | not a test item |
