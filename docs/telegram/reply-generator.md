# Editing Ali's live Telegram replies

**The file to edit for conversation rules is `prompts/ali.md`.** It contains Ali’s role, English and Emirati Arabic style, buyer and seller behavior, stopping rules, and officer handoff criteria. The first system message contains the file on every production turn, including a retry. Gemini, Cydonia and the local LM Studio adapter use the same contract. Mirsad reads the saved file at startup and when an officer chooses **Settings → Reload Ali’s prompt**.

For normal use, the approved contact sends a message in Telegram. There is no test prefix or command. An officer sees a handoff in Mirsad’s dashboard and can open the original chat message. The model supplies a decision. The application owns delivery and officer controls.

## Follow one incoming message

```mermaid
flowchart TD
    A[Telegram Business update] --> B[Scope check and local intake]
    B --> C{Eligible for an AI reply?}
    C -->|Yes| D[Build attributed history and offer memory]
    D --> E[Send ali.md and chat context to the configured model]
    E --> F[Validate the decision]
    F -->|Public reply| G[Check outgoing text and recheck chat state]
    G --> H[Send Telegram reply and record model]
    F -->|Silence| I[Record skipped turn and reason in the case log]
    F -->|Officer review| J[Recheck state, record handoff and hold replies]
    J --> K[Officer reviews the source in the dashboard]
```

1. **Intake.** `src/adapters/telegram/live-connector.ts` scopes the incoming update, normalizes it and calls `ingest` in `src/services/intake.ts`. The local store tracks source messages, edits and deletions. Replayed updates are deduplicated.
   With all-DM replies and **Test mode** on, a fresh eligible private message from the contact or the human account owner automatically activates new and returning chats. If the owner sends the opener, the worker waits for an incoming DM. It checks participant permission before building model context. Switching **Test mode** off in Settings stops automatic Dispatch and invitations for new contacts. Authorized active chats can continue. The single-chat Dispatch button in either mode lets an officer record existing permission for the selected chat.
2. **Eligibility.** `openSession`, `claim` and `waiting` in `src/workers/ai-reply-worker.ts` check account binding, participant permission, officer control, contact identity and freshness. Permission can come from pre-approval, accepting the chat invitation, or the officer recording existing permission in the single-chat Dispatch dialog. `src/services/telegram-dispatch-permission.ts` limits that last path to the selected incoming message and eligible subsequent history. Ordinary replies have a fifteen-minute freshness window. Confirming Dispatch for one chat or a unique verified phone match immediately requests a reply to its latest eligible unanswered DM under 24 hours old. That request stays eligible for up to fifteen minutes after Dispatch and within the original 24 hours. Later automatic replies wait for three quiet seconds so consecutive messages form one turn. Pauses, takeover and active holds apply.
3. **Context.** `historyFor` selects up to 32 eligible recent messages and applies their latest source edits. The full eligible history supports guard and race checks. The model-facing history additionally excludes attributable, unedited previous AI replies that wrongly claimed to sell or disclose details. The source record remains intact.
4. **Generation.** `aiReplyWorkerFor` in `src/app.ts` selects the configured adapter. `buildReplyMessages` constructs the request. The production worker uses `decide` to receive a reply, silence, or handoff. The text-only compatibility method `generate` maps both silence and handoff to `null`. A caller responsible for officer review must use `decide`.
5. **Dispatch.** The worker checks a public draft with `blockedRuleForTurn` and checks for an already answered identity question. A guard violation can trigger one retry, with only the guard code passed back as metadata. The system prompt stays identical. A stale draft is discarded when the source, control revision, or hold changes. A successful send goes through the Telegram Business sender and intake. Its case action records the model and the source message it answered. A network send already accepted by Telegram cannot be recalled by a subsequent database transaction.
6. **Handoff.** A validated review decision takes the internal path before any Telegram send. `recordConversationReview` in `src/services/telegram-reply-holds.ts` records a review request linked to the local source message and event. The report contains the status, indicator codes and model. Officers see it in the dashboard and case log. Further automatic replies are held until the officer inspects the source and uses **Mark reviewed**. Contact opt-outs and any additional evidence holds still apply independently.

## What belongs in each file

| Owner | Responsibility |
| --- | --- |
| `prompts/ali.md` | All model-facing conversation and assessment rules. Change wording, dialect, examples and the ordinary review threshold here. |
| `src/replies/ali-prompt.ts` | Load the exact file and validate its numeric header. A malformed header fails startup. |
| `src/replies/reply-generator.ts` | Adapter interface, message roles, context budget, history construction, shared error and detector exports, and the loopback LM Studio adapter. |
| `src/replies/reply-context.ts` | Recognize language, identity questions, explicit offers, corrections, withdrawals and contextual guard cases. These classifications support routing, memory and safety checks. |
| `src/workers/offer-memory.ts` | Rebuild the sender’s latest explicit offer and correction from eligible SQLite rows, including offers older than the recent window. |
| `src/replies/ali-decision.ts` | Provider JSON schema, local validation, and conversion to the internal reply/silence/review type. Changes to field names or allowed reason codes must also update the prompt, adapters, tests and officer display. |
| `src/replies/reply-errors.ts` | Shared fixed failure codes carried by `ReplyGenerationError`. Provider diagnostics and message text stay out of logs. |
| `src/replies/openrouter-reply-generator.ts` | Fixed OpenRouter endpoint, model and provider allowlists, cancellation, timeout, completion validation and sanitized errors. The Gemini compatibility wrapper is in `gemini-reply-generator.ts`. |
| `src/replies/reply-guard.ts`, `reply-guard-rules.ts`, `reply-duplicates.ts` | Outbound privacy and action checks, fixed rule codes and repeated-identity suppression. The application enforces these even if a draft ignores the prompt. |
| `src/workers/ai-reply-worker.ts`, `src/services/telegram-reply-holds.ts`, `src/services/officer.ts` | Claim work, perform final checks, send, persist, queue a review, and resolve it under officer control. |
| `src/dashboard/js/views/`, `src/dashboard/js/format.js` | Display officer reports, readable indicator labels and pointers to the original source. |

## The generator contract in detail

`ReplyTurn` contains `from` and `text`. Map `contact` to the model’s `user` role and `owner` to its `assistant` role. An outgoing message may have been written by an officer or a previous model. `ReplyOfferMemory` contains the sender’s original offer and optional latest correction. Always preserve who supplied a statement when the contact switches languages.

Both adapter methods accept `history, signal, correction?, currentTurn?, memory?`. Keep the cancellation signal connected through the network request. `currentTurn` identifies the latest incoming burst, including multiple short messages. The builder can insert a model-only silence marker between an earlier unanswered burst and a later burst. Adjacent messages from the same speaker are joined. A guard retry carries a fixed code alongside context. Neither sender text nor remembered excerpts belong in the system message.

`historyCharsFor`, `fitTurn` and `recentTurns` bound the amount of history leaving the worker. The default range is 500–8,000 UTF-16 units, even with a hosted model that has a much larger context window. Older turns are capped at 1,500 units each. The most recent incoming text can use 3,000, keeping both ends when clipped so a late correction survives. The builder returns the retained turns oldest first. It masks project-name mentions in its inference copy and strips a historical assistant introduction from prior outgoing turns. It never rewrites the evidence.

`OfferMemory.read` uses source positions, edits, deletion state, enrollment and evidence exclusions. The sender’s explicit correction can update an offer and a withdrawal clears it. On restart the cache can be rebuilt from eligible sources. The builder includes missing excerpts as quoted user data if they fit within the memory budget. A model cannot infer forgotten, withdrawn or excluded facts merely by selecting a larger context window.

`createLmStudioReplyGenerator` permits HTTP(S) on the loopback hosts only, rejects redirects and combines timeout and caller cancellation. It can check the returned local model ID when language routing uses different local models. Explicit custom prompts used by evaluation tools can use legacy plain text and the exact `[NO_REPLY]` marker. Production Ali calls use the structured decision. `cleanReply` is a text utility. Production output must pass `parseAliDecision` and the worker’s outgoing checks.

## Decision and threshold

The wire fields are `case_status`, `should_reply`, `external_reply`, `review_reasons` and `silence_reason`. The model selects a fixed `silence_reason` when it chooses silence. Public replies and officer handoffs use `null` for that field. Only validated `external_reply` text is eligible for the chat. The application rejects malformed JSON, extra fields, oversized or internally formatted public text, inconsistent flags and invalid reason codes.

| Model status | Effect |
| --- | --- |
| `MONITORING` or `SUSPICIOUS` | A public reply or a reason for silence. The list of handoff reasons is empty. |
| `INSUFFICIENT_FRAUD_INDICATORS` | Silence on this exchange. |
| `READY_FOR_OFFICER_REVIEW` | A local officer report and a reply hold. Requires distinct ordinary indicator codes meeting `minimum_distinct_indicators` in the prompt header. Allowed threshold values are 2, 3 and 4. |
| `HUMAN_INTERVENTION_REQUIRED` | An immediate local officer report and hold. Requires an urgent reason such as a threat, a sensitive request or unresolved material uncertainty. |

A bookcase offer can get an ordinary buyer response. An unexplained advance fee and independently stated pressure to pay can justify review. Repeating one demand is one fact. The parser can enforce unique codes. The model judges whether the underlying facts are independent, and the officer checks the source. A report requests human review and makes no finding of guilt. Separately, the existing intake rules can hold a chat before generation when material evidence or a contact preference requires it.

For example, with the default threshold, this model response records a review for the officer and sends zero Telegram messages:

```json
{
  "case_status": "READY_FOR_OFFICER_REVIEW",
  "should_reply": false,
  "external_reply": null,
  "review_reasons": ["upfront_fee", "payment_pressure"],
  "silence_reason": null
}
```

The other ordinary codes are `contradictory_terms` and `unverified_payment_request`. The immediate-review codes are `sensitive_request`, `threat` and `uncertain`. The code list is part of the API contract. The prompt explains what each code means. Model-generated names, bank details, timestamps, free-form accusations and quotations have no field in this report. The officer can inspect the locally recorded source and surrounding timeline.

## How to change and verify it

For a wording or threshold edit, change `prompts/ali.md`. Keep the header and wire field names intact. Keep tests synthetic, and use only IDs, codes and counts in operational logs. Credentials are held in the ignored environment and data files.

For a new decision or review reason, update the prompt, parser, structured schema, worker handling, dashboard labels and contract tests together. For memory changes, test both language directions, a source correction or deletion, a withdrawal, and a restart. For delivery changes, test a hold or takeover arriving while inference is in flight. Store model-generated indicators alongside links to locally recorded source events. The local store supplies the actual IDs and timestamps.

| Developer verification | What it exercises |
| --- | --- |
| `npm run typecheck` and `npm test` | Type contracts, message construction, output parsing, memory, guards, provider adapters and worker integration. |
| `tests/integration/telegram-conversation-review.test.ts` | Handoff from an eligible chat, source attribution and the officer hold. |
| `npm run test:e2e` | Officer dashboard behavior in a browser. |
| `npm run openrouter:verify` and `npm run prompt:preview` | Invented exchanges through the hosted adapter. These tools do not send Telegram messages. |

After saving an edit, click **Settings → Reload Ali’s prompt**. The new wording and review threshold take effect together on the next model turn. A turn already in progress, including a correction attempt, keeps its original version. If the saved file is unreadable or the header is invalid, the current version stays active. Fix the file and click the button again.

In an approved, AI-active Telegram chat, an ordinary message uses the live path directly. If no reply appears, check the officer queue, contact consent, AI mode and case-action outcome before changing the prompt. Legitimate silence, review, a blocked draft, and provider failure are different outcomes.

A temporary wording test can relax length, repetition, language and follow-up wording checks for a single explicitly approved chat. At launch the service accepts a process-level deadline up to fifteen minutes ahead. The deadline is checked during drafting and again before sending a draft that could cross the cutoff. Consent, officer handoffs, financial and identity information checks, and the structured output contract apply throughout.
