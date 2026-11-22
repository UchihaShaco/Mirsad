# Headless client example

A host platform needs nothing but HTTP to use Mirsad. `run.ts` walks through the integration contract in five calls
and imports nothing from `src/`. The same payloads appear under `x-workflow-example` in `openapi.yaml`, and a test
runs this client against a live service and compares them.

| # | Call | Credential | What it shows |
|---|---|---|---|
| 1 | `POST /v1/chats` | officer token | Register a host conversation; the response carries a stable `chatId`. |
| 2 | `POST /v1/dispatches` | officer token | Start AI review. The `Idempotency-Key` header makes a retry safe. |
| 3 | `POST /v1/chats/{chatId}/events` | connector token | Report one incoming message (`message.recorded`). |
| 4 | `GET /v1/chats/{chatId}/timeline` | officer token | Read stored messages, case actions and the stream cursor. |
| 5 | `POST /v1/chats/{chatId}/control` | officer token | Take over at the revision the timeline reported. |

Tokens travel only in the `Authorization: Bearer` header.

## Run it

```
npm run demo                      # terminal 1: starts Mirsad on 127.0.0.1:8787 and seeds demo data
npx tsx examples/headless-client/run.ts   # terminal 2
```

The client reads `MIRSAD_BASE_URL` (default `http://127.0.0.1:8787`), `MIRSAD_OFFICER_TOKEN` and
`MIRSAD_CONNECTOR_TOKEN`. When a token variable is unset it falls back to `demo-credentials.json` in the data directory
(`MIRSAD_DATA_DIR`, default `./data`). Each run registers a fresh conversation, so it can be repeated.

It prints one line per step with the status and IDs (`chatId`, `dispatchId`, `messageId`, `revision`, `aiMode`).
It never prints message text.

## Use it from code

```ts
import { runExample } from './run.ts';

const trace = await runExample({ baseUrl, officerToken, connectorToken });
// trace.exchanges: every request (tokens replaced by labels) and response, in order
```

Options `externalAccountId` (default `tg-demo-officer`) and `externalChatId` choose the officer's channel account and
your own conversation ID, and `fetch` replaces the HTTP function. All data in the example is synthetic.
