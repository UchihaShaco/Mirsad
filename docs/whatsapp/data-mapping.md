# WhatsApp fixture and import data mapping

This mapping covers labeled synthetic fixtures and approved chat exports. The [import plan](import-plan.md) defines
their verification gate. Imports use the common intake API and the shared `ChannelAdapter` interface.
The [personal hackathon demo](demo.md) accepts signed callbacks on a dedicated listener and records those messages
with `whatsapp_business_live` provenance.

## Source and capture method are separate

`source` says which channel a conversation took place on; the capture method says how the content reached Mirsad. A
fixture that represents a WhatsApp conversation is still fixture content.

| | Labeled WhatsApp fixture | Approved import of a chat export |
|---|---|---|
| `source` | `whatsapp` | `whatsapp` |
| Capture method (provenance) | `fixture_replay`, from the fixture connector | `approved_import`, from a connector provisioned for that approved source account |
| Where the capture method comes from | The connector principal, fixed at provisioning; a payload can never set it | Same |

## Field mapping

| Intake field | Fixture | Chat export |
|---|---|---|
| `externalAccountId` | A symbolic account (`intake` or `officer`) that the replay caller maps to a real account, as Telegram fixtures do | The WhatsApp account the export was taken from: its number in E.164 (for example `+447700900010`) or an agreed account reference, recorded when the account is provisioned |
| `externalChatId` | Given in the fixture | Exports carry no chat ID, and the export's file name and display names are not stable. The officer supplies the conversation reference at import time (for example the case's reference for that conversation); it is stored only as the mapping |
| `chat.displayLabel` | Given in the fixture | The export's chat title, as written |
| `sourceMessageId` | Given in the fixture (`wa:<id>`) | Exports carry no message IDs. Derived, so that importing the same export twice, or a longer export that overlaps it, creates nothing new: `wa-export:` + SHA-256 of (conversation reference, timestamp as written, sender label as written, message text, occurrence number among identical lines) |
| `sourceEventId` | Given in the fixture | `<sourceMessageId>:rec` for a message; `<sourceMessageId>:del` for a deletion placeholder |
| `direction` | Given in the fixture | `outgoing` when the sender label is the exported account itself (the officer confirms which label that is at import time); otherwise `incoming` |
| `text` | Given in the fixture | The message text as exported; continuation lines belong to the message above them |
| `unsupportedContent` | Given in the fixture | `media` (or the kind, when the attachment is present) for lines such as "<Media omitted>"; the text is then empty |
| `sentAt` | Given in the fixture | The export's timestamp converted to UTC. Exports show local time with no time zone, in the phone's date format and to the minute, so the importer requires the export's time zone and date format as inputs. Without them `sentAt` is left out |
| `receivedAt` | Always Mirsad's clock when the event is stored | Same: the import time, never the export's time |
| `sender.displayName` | Given in the fixture | The sender label as exported (a saved contact name, or a number) |
| `sender.externalId` | Given in the fixture | The number, when the label is a number; otherwise left out |
| `sender.phone` | Given in the fixture (`{ raw, country?, internationalFormat? }`) | Only when the sender label is itself a number written with `+` (exports show unsaved contacts that way): `{ raw: <label>, internationalFormat: true }`. This is sender metadata. A number written inside a message is a mention, kept in the evidence and never linked to the sender |
| `conversationStart` | Only when the fixture asserts it, and only honoured from a trusted connector | Only when the officer confirms the export is the complete history from the first message (`confirmed_complete_history`); otherwise left out |

## Edits, deletions and system lines in exports

- An export holds only the latest version of an edited message (marked "<This message was edited>"). It is imported as
  one `message.recorded` event with the text as shown; there is no edit history to import.
- A deleted message appears as a placeholder line ("This message was deleted"). It is imported as `message.deleted` for
  a message Mirsad never saw, which creates a placeholder with no text (design section 7, step 6).
- System lines (the end-to-end encryption notice, number changes, members joining) are not messages. They are skipped
  and counted in the import report.

## Partial transcripts

An export can start part-way through a conversation, and an import can be partial. Mirsad shows what was actually
received: the timeline labels the chat `First observed: incoming` or `First observed: outgoing`, `initiatedBy` stays
`unknown`, and nothing is invented for the gap. Importing a later, longer export adds only the lines not yet stored.

## Example: one imported line

A synthetic export line from an unsaved contact, imported for conversation reference `case-0042-chat-1`:

```json
{
  "source": "whatsapp",
  "externalAccountId": "+447700900010",
  "externalChatId": "case-0042-chat-1",
  "chat": { "displayLabel": "+44 7700 900123" },
  "event": {
    "type": "message.recorded",
    "sourceEventId": "wa-export:4b1e...c2:rec",
    "sourceMessageId": "wa-export:4b1e...c2",
    "direction": "incoming",
    "text": "Hello, is the flat still available?",
    "sentAt": "2026-11-20T09:14:00.000Z",
    "sender": {
      "externalId": "+447700900123",
      "displayName": "+44 7700 900123",
      "phone": { "raw": "+44 7700 900123", "internationalFormat": true }
    }
  }
}
```

The import connector (capture method `approved_import`) posts it to `POST /v1/ingest`. The response, captures, review
rules and watchlist hooks are exactly those of any other channel.
