# Telegram fixtures

Everything under `fixtures/telegram/` is synthetic. Each file has `synthetic: true`, a one-line `description`, a symbolic
`account` (`intake` or `officer`), the business owner user ID `5000000001` and the connection ID `TestBizConn-0001`.
Names are "Test Owner" and "Test Contact N"; domains end in `.test` or use `example.*`; phone numbers come only from
`+44 7700 900000`-`900999` and `+1 <area> 555 0100`-`0199`.

Replay: `npm run replay -- fixtures/telegram/<file>.json` (needs a running Mirsad; reads `MIRSAD_BASE_URL`, default
`http://127.0.0.1:8787`, and `MIRSAD_CONNECTOR_TOKEN`, else `demo-credentials.json` in the data directory). The demo account
map is `intake=tg-demo-intake`, `officer=tg-demo-officer`. The replay refuses a file that is not synthetic or that holds a
domain or phone number outside the reserved ranges (`validateFixture`), and its report lists IDs and result codes only.
Phone numbers are checked exactly as in the evaluation transcripts (`src/domain/reserved-numbers.ts`; the layout rules
are in `fixtures/eval/README.md`): every run of seven or more digits, in any spacing or digit set, must be a reserved
number, so write any other number (a reference, a date, an amount) without such a run.

`conversationStarts` is the fixture author's assertion about a synthetic conversation. Only fixtures may carry it; real
Telegram updates have no start marker, so live intake always yields `First observed: ...`. No shipped fixture sets it; tests
add it to a copy to exercise `Contact started chat`.

| File | Account | Exercises |
|---|---|---|
| `inbound-first-greeting.json` | intake | A contact's benign first message: New inbound, `First observed: incoming`. |
| `officer-first.json` | officer | The owner writes first, the contact replies in Arabic: open chat, `First observed: outgoing`, both directions. |
| `edit-and-delete.json` | intake | A message, its edit, its deletion and a redelivered update: separate events, original text stays, no duplicate. |
| `payment-destination-change.json` | officer | Exactly six messages; five routine with no link, number or payee, the sixth introduces the only payment link as a change of where to pay. |
| `watchlist-sequence.json` | intake | Chat A: number plus payment request. Chat B: new inbound chat sharing its own contact card with the same number. |
| `takeover-pair.json` | intake | Two chats with several incoming messages, one carrying a payment link; used for dispatch and takeover. |
| `merchant-conflict.json` | intake | Own contact card, then a payment link whose host differs from the case-reference merchant host `pay.merchant.example`. |

## What the adapter does not store

The adapter keeps a message's text (or caption) exactly as Telegram sent it and lists what it leaves out as unsupported
content: media kinds (`photo`, `contact` and the others), a formatted link's hidden URL (`text_link`, from `entities`
or `caption_entities`), buttons (`inline_keyboard`), a forward's origin (`forwarded`), and `other` for a message with
neither text nor a known media kind (a story or a dice, say), which still gets its own capture. The capture's
"Unsupported content" row and the timeline's "Not captured" line show the list.

Known gaps in this version:

- The URL behind a `text_link` is not stored, so it is never reviewed or compared with a merchant confirmation; only the
  marker says a hidden link existed.
- An edit cannot list unsupported content (the intake contract's `message.edited` has no such field), so an edit that
  changes only a hidden URL is recorded as an edit with unchanged text.

No shipped fixture contains formatted links, buttons, forwards or unknown kinds; adapter unit tests and a replay test
cover them, and the event coverage worksheet (rows E17 to E20) lists them for the controlled test.
