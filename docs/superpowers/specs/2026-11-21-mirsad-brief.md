# Mirsad brief (agreed scope)

This file holds the project owner's brief verbatim, followed by their execution instructions for this build. It is the binding scope. The design notes in `2026-11-21-mirsad-design.md` and the plan in `../plans/2026-11-21-mirsad.md` argue from it; where they disagree with this file, this file wins.

---

# Mirsad Implementation Brief

Build the first working version of **Mirsad**, an evidence capture and review service for officer-led investigations. Make it runnable on its own and easy for a separate platform to integrate through an HTTP API. Build Telegram first and complete its readiness checks before starting the WhatsApp import and demo. Support both contact-first and officer-first conversations.

## Officer workflow

1. A conversation can start with an officer’s message in an authorized channel or with an incoming message from a contact. Show both directions when the source provides them. When the first message received for an in-scope, previously unseen conversation is inbound, create a conversation in **New inbound** and capture that message immediately. The officer can select one or more conversations and click **Dispatch** to start AI review for those chats in parallel.
2. Show **Contact started chat** or **Officer started chat** only when a reliable source establishes the start of the conversation. For partial imports or mid-chat connections, show **First observed: incoming** or **First observed: outgoing**. Treat these as timeline labels. A separate **Suspected fraud** finding needs specific evidence, such as a payment link that conflicts with independent merchant confirmation. An ordinary contact-first greeting goes to the inbox with no fraud finding.
3. The dashboard shows new conversation events live. On receipt, store the original message text and timestamps before asking the model to review it. Generate a timestamped screenshot from each saved incoming message and attach it to the case.
4. The officer can **Pause AI**, **Take over**, or **Resume AI** for each chat independently. Incoming evidence capture continues during a pause or takeover. **Take over** opens a message composer inside Mirsad for the officer who controls that chat. Leave it blank by default. The officer can type a reply and explicitly click **Send**, or choose **Leave unanswered** while keeping the chat open. Record that choice in the internal case log and keep recording incoming messages. An explicitly identified intake account can also offer a short, neutral acknowledgement such as “Message received.” It remains editable and requires the officer to click **Send**. Show each sent message with officer attribution, timestamp, and send status. The prototype records simulated sends locally. Real delivery from the composer requires an approved host integration for that channel.
5. The timeline shows each message’s direction, source, receipt time, screenshot status, and AI findings. If the source reports a later edit or deletion, record it as a separate event. Evidence already captured remains available according to the approved case retention policy.
6. When evidence review finds a phone number tied to a specific concern, add it to the internal **Phone watchlist** as **Needs review** or attach the evidence to an existing entry. When a new inbound chat matches an approved watchlist entry through its sender metadata, show **Watchlist match** and link to the supporting case evidence the officer is authorized to view.

Use synthetic message events in both directions. The integration ingests events and approved imports. The composer is an officer-only control for a single chat under takeover. Keep the AI reviewer separate from sending. Evidence capture begins when an event reaches Mirsad. Display the source and distinguish a **Mirsad-rendered capture** from an original screenshot supplied by an officer. Render each capture from the saved message and include its text, chat reference, and receipt time. Render message text as plain text and use local assets.

## Channel rollout

- **Telegram first.** Build an end-to-end local replay with Telegram-shaped fixtures and prepare the official connected Business intake for a controlled test. Provide an `.env.example`, setup and rollback instructions, endpoint and connection verification, replayable sample events, health/status checks, and a worksheet for the observed event coverage. Keep credentials out of the repo. Leave the live connector disabled until the account owner has approved explicitly scoped test chats and test credentials are available. [Telegram Business updates](https://core.telegram.org/api/updates) · [Telegram Bot Developer Terms](https://telegram.org/tos/bot-developers)
- **Telegram readiness.** Verify inbound-first and officer-first cases, separate screenshots for each received message, edit and deletion events, deduplication, and which officer-sent messages actually arrive. Exercise takeover and a manual officer reply. The composer sends locally during replay. A real test reply is a separate capability for an explicitly approved test conversation where the channel supports it. Mark the connector **Ready for controlled test** if only the local checks ran. Mark **Controlled test verified** only after an approved test and record what it covered. Keep live Telegram content out of model analysis, including local inference. [Telegram content licensing and AI terms](https://telegram.org/tos/content-licensing)
- **WhatsApp second.** Prepare the shared adapter interface, data mapping, and a short import plan while building Telegram. Start WhatsApp-specific implementation after the Telegram controlled test is verified. Use labeled WhatsApp fixtures and approved evidence imports through the common intake API. Meta’s published Business Messaging Policy prohibits law-enforcement agencies from using the WhatsApp Business Platform. The planned WhatsApp phase covers fixture replay and import. [WhatsApp Business Messaging Policy, Government and Political Use](https://whatsappbusiness.com/policy/)
- Model source and capture method separately. A fixture that represents a WhatsApp conversation still has fixture provenance. An imported transcript can remain partial. The platform should surface which events were actually received.

## Integration contract

The reference dashboard is a client of the same API available to another platform. Keep case and evidence rules in the service. A host platform can register its conversations, submit inbound events, control AI review, and subscribe to updates. Use internal IDs for authorization and store the host’s conversation ID as a mapping.

| Route | Contract |
|---|---|
| `POST /v1/chats` | Register an existing authorized conversation with `source`, `externalAccountId`, `externalChatId`, and `displayLabel`. Return a stable `chatId` for that workspace, source, account, and conversation. |
| `POST /v1/ingest` | Accept a normalized fixture or authorized intake event with the channel, external account ID, and conversation ID. Resolve the workspace from the authenticated connector. Create or find the chat and append its first event in one transaction. An inbound message for a new chat enters **New inbound**. |
| `POST /v1/dispatches` | Accept `chatIds` and an `Idempotency-Key` header. Start AI review on selected chats and return a per-chat status. Validate caller access to the full selection before changing any chat state. An officer-controlled chat requires an explicit resume. |
| `POST /v1/chats/{chatId}/events` | Use the same ingestion logic for already registered chats. Accept `message.recorded`, `message.edited`, or `message.deleted`. For messages, store `direction` (`incoming` or `outgoing`), `sourceEventId`, `sourceMessageId`, original text, server-generated `receivedAt`, and source-supplied `sentAt` when available. Deduplicate events by their source event ID and message creation by source message ID within the chat. Treat edits and deletions as separate events linked to the original. |
| `POST /v1/chats/{chatId}/control` | Accept `pause`, `take_over`, or `resume` and `expectedRevision`. Return the resulting mode and revision. Return a conflict for a stale revision. Record the operator and time for each transition. |
| `POST /v1/chats/{chatId}/officer-messages` | Submit one message from the composer with `text`, `expectedRevision`, and an `Idempotency-Key`. Require the authenticated officer to control the chat at the supplied revision. In the prototype, save one outbound message labeled **Simulated send** and publish it to the timeline. A future approved host adapter supplies real delivery status. |
| `POST /v1/chats/{chatId}/officer-decisions` | Record `leave_unanswered` for the selected incoming message with the expected control revision. Require the authenticated officer to control the chat. Save an internal case action and keep the chat open for further evidence. |
| `GET /v1/chats/{chatId}/timeline` | Return stored messages, case actions, source references, screenshot status and artifact IDs, AI findings, and the latest event cursor. Include `initiatedBy` (`contact`, `officer`, or `unknown`) separately from `firstObservedDirection`. Resolve initiation only from a trusted start-of-chat marker or a confirmed complete history. |
| `GET /v1/artifacts/{artifactId}` | Return a screenshot to an authorized caller with access to the chat. Keep files in private storage. |
| `GET /v1/events` | Stream notifications for authorized chats using server-sent events. Include an event ID and chat ID. Publish a chat-created notification to the authorized inbox when the first message arrives. Accept the snapshot cursor when connecting and resume after the last seen event ID on reconnect. If a cursor is outside retained history, direct the client to reload the timeline or inbox. |
| `GET /v1/chats` | List authorized conversations with channel, origin label, inbox status, and AI mode so a host can build its own queue. |
| `GET /v1/watchlist` | List phone entries the caller can access in their workspace, with review status, first and last seen times, and authorized evidence references. |
| `POST /v1/watchlist/{entryId}/review` | Let an authorized officer approve, clear, or reopen an entry. Require a reason and the expected revision. Record the officer, timestamp, and decision. |

Maintain an `openapi.yaml` with request and response schemas and one example of the complete workflow. Document the event stream separately in the README. Use a local reference client to test integration through the HTTP boundary. [OpenAPI specification](https://spec.openapis.org/oas/v3.1.2.html) · [Server-sent events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)

## Implementation defaults

- Use a single service and a minimal web dashboard. If the repository is empty, use TypeScript, a small HTTP framework, SQLite, and a local evidence directory. Keep storage, screenshot rendering, model inference, and inbound evidence behind small interfaces. Use the existing stack if the repository already has one.
- Bind the fixture service to localhost. Use a demo operator identity and a separate credential for ingestion. Authorize chat and artifact access consistently. Let the host replace the demo identity adapter when integrating its own login.
- Save message text and pending screenshot work together. If screenshot rendering fails, retain the message and surface a retryable capture error. Store successfully written image files with a SHA-256 checksum. Keep AI findings separate from original messages and associate each finding with its source message ID.
- Keep model review separate from evidence capture. Give each chat its own review state. Check the current mode and revision again before publishing a model result so a result finishing after takeover cannot appear as an active AI finding. Use a deterministic reviewer in tests. Keep message content out of application logs.
- Keep demo evidence local. A real deployment requires an approved environment in the UAE for case storage, screenshot processing, inference, logs, and backups. Document which parts are fixture-backed and which need a host integration.

## Local model setup

- Use the already downloaded **Qwen3.5 9B Q4_K_M** as the default, with a **4,096-token initial context**. Verify its available model ID through LM Studio and make the loopback URL and model ID configurable. Use the existing installation and weights. Use schema-constrained JSON when the local endpoint supports it. [LM Studio local server](https://lmstudio.ai/docs/developer/core/server) · [Structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
- Send only synthetic case messages for the initial model evaluation. Require the source message ID, exact quote, and extracted value for each finding. Check the ID and quote against the stored record before displaying a finding. When a field is absent or unclear, leave it unknown. The reviewer has read-only access and no messaging tools.
- Keep the AI reviewer quiet by default. Save every received message, including greetings and routine replies. Use **No new finding** internally for messages that add no case evidence and suppress repeated alerts about the same detail. When a message changes the case, such as by introducing a different payment link or recipient, show one short officer-facing note with the exact quote and source. The officer decides whether to reply and writes the message in the takeover composer.
- Evaluate on held-out Arabic, English, and mixed-language synthetic transcripts. Include a benign first message, a quoted third-party number, a missing payment recipient, and text that tries to instruct the model. Record extraction accuracy, unsupported findings, and response time. On model failure, keep ingestion, screenshots, and officer controls available and show review as unavailable.

## Phone watchlist

- Keep one private watchlist per authorized workspace. Normalize a number for exact matching when its country context is known, and preserve the source representation in the evidence. A Telegram account ID, username, or partial number is insufficient for an exact phone match.
- Record whether a number came from sender metadata or was mentioned in a message. Require an exact source reference and a reason for adding a lead. A number in the message body belongs in the evidence as a mention. Linking it to the sender requires separate support.
- Let Mirsad create **Needs review** entries and append new observations to existing entries. Update last seen time from new evidence. Deduplicate repeat delivery and keep historical observations visible after a review decision.
- Approved entries can generate an inbox match for officer review. Treat a match as a lead because numbers can be shared or reassigned. Keep approval, clearing, and reopening with the officer. If a cleared number appears in new material, record the new evidence and surface it for review without automatically restoring approval.

## Build order and acceptance

### 1. Prove the first end-to-end flow through the API

- [ ] Write a failing integration test that creates a new Telegram fixture chat from its first incoming message, registers a second officer-first Telegram fixture chat, dispatches both, and reads both timelines.
- [ ] Implement new-chat intake, batch dispatch, deduplicated ingestion, and timeline reads. Replay the new inbound event and verify there is one chat and one message. Submit a deletion event and verify the previously captured message is still present. Test that a partial transcript shows the first observed direction without asserting who started it. A benign inbound greeting produces an inbox alert and no fraud finding.

### 2. Prove screenshots and handover

- [ ] Test a screenshot failure and retry. The original message remains readable while capture is pending or failed. A successful retry produces one linked image. When a second message arrives before the first image is rendered, each image shows its own saved message.
- [ ] Test takeover while a review request is in flight. The officer controls chat A, its incoming messages still record, and its stale AI result is discarded. Chat B continues to receive AI findings. Test that the controlling officer can submit a message inside Mirsad and see it once in the live timeline as **Simulated send**. A stale control revision or a different officer receives an error. Reopen the service and verify the evidence is still there.
- [ ] Test **Leave unanswered** on an incoming Telegram fixture. Verify that only an internal case action is added, no outgoing message is created, and the next incoming message and screenshot still appear. If an identified intake acknowledgement is available, verify that selecting it fills the composer and sending still requires an explicit officer click.
- [ ] Add the minimal screenshot and review workers and pass both tests. Expose capture and review status independently in the timeline.

### 3. Make the first slice usable by another platform

- [ ] Build the reference dashboard from the API and event stream. Show a **New inbound** queue, channel labels, messages in both directions, readable screenshots, and independent takeover controls. In takeover mode, render the composer for the controlling officer and show outbound messages alongside incoming evidence. Test that an event arriving between snapshot and subscription still appears, and that callers outside the chat get no timeline, event, or artifact access.
- [ ] Add a small headless integration example that uses only HTTP to register a chat, dispatch review, submit an inbound event, fetch its timeline, and take over. Use `openapi.yaml` to document the exact payloads it sends.
- [ ] Verify the walkthrough on a clean start with demo fixtures. Record the start and test commands in the README. Report the observed test results and identify any fixture-only behavior.

### 4. Add watchlist updates to the same demo

- [ ] Test the sequence from source-backed phone candidate to officer approval to a new inbound sender match. Show the linked evidence in the inbox and publish the status change through the same event stream.
- [ ] Test that duplicate observations create one logical entry, a number mentioned in a message stays distinct from the sender’s number, and a cleared entry stays cleared when new evidence arrives. Test that watchlist access and evidence links stay within their authorized scope.

### 5. Verify Telegram readiness, then add WhatsApp

- [ ] Run the local model evaluation and the controlled Telegram test if approved test access is available. Record results separately for the fixture replay, live capture, and manual officer reply. Deliver the complete setup instructions and clearly mark the live test as pending when approval or access is unavailable.
- [ ] Test a synthetic chat with five routine messages and one changed payment destination. Verify all six are captured, the routine messages produce zero alerts, and the changed destination produces one short note linked to the original quote. Replaying the same event creates no duplicate note.
- [ ] After the controlled Telegram test is verified, add the WhatsApp fixture and approved import through the same API. Run the shared contract tests and verify the inbox, evidence, watchlist, and takeover workflow without requiring any WhatsApp credentials.

---

# Execution instructions (sent with the brief)

Use Superpowers to build Mirsad end to end. Treat the latest Mirsad brief as the agreed scope. Inspect the repository, make a short implementation plan, and execute it in this session. Use parallel subagents where tasks are independent, systematic debugging when a check fails, and verification before declaring the work done.

Make routine, reversible decisions yourself. Choose the simplest option that satisfies the brief, record any material assumptions in the README, and keep working. Skip separate approval rounds for the plan, file structure, library choices, UI details, and ordinary local fixes.

Finish Telegram first. Build and verify the local replay with the installed Qwen3.5 9B model, inbound-first flags, screenshots, batch dispatch, the phone watchlist, and officer takeover with replies inside Mirsad. Verify that a separate client can use the API without the dashboard. Prepare the controlled Telegram test and follow the brief’s readiness criteria before moving to WhatsApp.

If a step requires credentials, external access, or a mandatory approval that you do not already have, leave that step pending and finish everything else you can verify locally. Respect tool permissions and preserve existing work.

Run the tests and demo walkthrough before handing back. In your final report, give me the commands to start Mirsad, what you verified, what remains simulated, and any blocker that genuinely prevented completion.
