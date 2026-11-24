/** Shared attribution, context budgeting and local model adapter. Telegram delivery is owned by the worker. */
import { z } from 'zod';
import type { TelegramReplyRequestKind } from '../contract/enums.ts';
import { ALI_PROMPT as REPLY_SYSTEM_PROMPT, currentAliPrompt, type AliPromptSnapshot } from './ali-prompt.ts';
import { ALI_PUBLIC_REPLY_FORMAT, ALI_RESPONSE_FORMAT, MAX_REPLY_CHARS, hasInternalReplyContent, parseAliDecision, parseAliPublicReply, publicReplyFromDecision, type AliDecision, SILENCE_EXPLANATION_REQUEST } from './ali-decision.ts';
import { InvalidReplyDraftError, ReplyGenerationError } from './reply-errors.ts';
import { isReplyGuardRule } from './reply-guard-rules.ts';

export { InvalidReplyDraftError, ReplyGenerationError, REPLY_FAILURE_CODES, type ReplyFailureCode } from './reply-errors.ts';
export { asksAliName, contactOfferEvents, isArabicReplyTurn, isIdentityCheck, isOfferAcknowledgmentTurn, isUnexplainedWorkFeeTurn } from './reply-context.ts';

/** One earlier message of the chat as the model sees it: who wrote it, and its text. */
export interface ReplyTurn {
  from: 'contact' | 'owner';
  text: string;
}

/** Original excerpts supplied by the contact, in their original language. Never instructions to the model. */
export interface ReplyOfferMemory {
  offer: string;
  correction?: string;
}

export interface ModelPaymentLinkCandidate {
  id: number;
  host: string;
  excerpt: string;
}

export interface ReplyInvestigationContext {
  dispatchIntent?: Exclude<TelegramReplyRequestKind, 'consent_notice' | 'ask_for_text'>;
  dispatchBrief?: string;
  paymentLinks?: readonly ModelPaymentLinkCandidate[];
  meetingArranged?: boolean;
  meetingDayConfirmed?: boolean;
  /** Types captured on the current sender turn. No attachment contents are sent to the reply model. */
  attachmentKinds?: readonly string[];
}

export type ReplyOutputMode = 'decision' | 'public_reply';

export interface ReplyGenerator {
  /** The model ID, recorded with each reply it wrote. */
  readonly model: string;
  /** Production adapters expose the typed decision so the worker can distinguish silence from a private handoff. */
  decide?(history: readonly ReplyTurn[], signal: AbortSignal, correction?: string, currentTurn?: readonly string[],
    memory?: ReplyOfferMemory, context?: ReplyInvestigationContext, prompt?: AliPromptSnapshot): Promise<AliDecision>;
  /** Plain-text compatibility for evaluation tools and stand-ins. A handoff and silence both return null here. */
  generate(history: readonly ReplyTurn[], signal: AbortSignal, correction?: string, currentTurn?: readonly string[],
    memory?: ReplyOfferMemory, context?: ReplyInvestigationContext, prompt?: AliPromptSnapshot): Promise<string | null>;
  /** Compose the public message after the worker has handled any private warning for this turn. */
  composePublicReply?(...args: Parameters<ReplyGenerator['generate']>): Promise<string>;
}

export interface LmStudioReplyOptions {
  baseUrl: string;
  model: string;
  /** Reject substitutions when different locally loaded models handle different languages. */
  requireModelMatch?: boolean;
  timeoutMs: number;
  /** The context the model is loaded with (MIRSAD_LMSTUDIO_CONTEXT_TOKENS); sets how much history is sent. */
  contextTokens?: number;
  fetch?: typeof fetch;
  /** The model's instructions; defaults to REPLY_SYSTEM_PROMPT. */
  systemPrompt?: string;
}

const NO_REPLY = '[NO_REPLY]';
const ENGLISH_INTRODUCTION = 'I’m Mirsad’s automated assistant.';
const ARABIC_INTRODUCTION = 'أنا مساعد مرصاد الآلي.';

export { REPLY_SYSTEM_PROMPT };

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const WEB_PROTOCOLS = ['http:', 'https:'];
const TRAILING_SLASHES = /\/+$/;
const REFUSED_REDIRECT_CAUSE = 'unexpected redirect';
const MAX_OUTPUT_TOKENS = 300;
const TEMPERATURE = 0.4;
/** Telegram allows 4,096 characters; a chat reply stays far shorter. */
export { MAX_REPLY_CHARS };
/** The context LM Studio is loaded with unless MIRSAD_LMSTUDIO_CONTEXT_TOKENS says otherwise. */
export const DEFAULT_CONTEXT_TOKENS = 4_096;
/** Characters per token, counted low: the English instructions take about four, Arabic chat text often only two. */
const PROMPT_CHARS_PER_TOKEN = 3;
const HISTORY_CHARS_PER_TOKEN = 2;
/** Tokens kept free for the chat template's wrapping around each message. */
const TEMPLATE_TOKENS = 200;
/** However small the context, the contact's latest message goes in, up to this many characters... */
const MIN_HISTORY_CHARS = 500;
/** Cap the chat text sent even when the configured model has a larger context. */
const MAX_HISTORY_CHARS = 8_000;
const MAX_TURN_CHARS = 1_500;
const MAX_LATEST_INCOMING_CHARS = 3_000;
const OMITTED_MIDDLE = '\n[text omitted]\n';
const THINKING_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const UNCLOSED_THINKING = /<think>[\s\S]*$/i;
const SENTENCE_END = /[.!?…。؟](?=\s|$)/g;

const Completion = z.object({
  model: z.unknown().optional(),
  error: z.null().optional(),
  choices: z.tuple([z.object({
    error: z.null().optional(),
    finish_reason: z.literal('stop').optional(),
    message: z.object({ role: z.literal('assistant').optional(), content: z.string(), refusal: z.null().optional(), tool_calls: z.tuple([]).nullish() }),
  })]),
});

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** The application supplies these fields independently of the editable conversation rules. */
const INVESTIGATION_OUTPUT_INSTRUCTIONS = [
  'Follow the response schema for the full field list. Set silence_reason and silence_explanation to null for a public reply and for READY_FOR_OFFICER_REVIEW and HUMAN_INTERVENTION_REQUIRED, even when should_reply is false.',
  'Every other decision without a public reply must say precisely why Ali stays silent. Set silence_reason to the one code that matches: no_actionable_question (the sender asked or requested nothing), already_answered (Ali already answered this), ordinary_terms_clear (the terms of the offer are clear and need no question), conversation_closed (the exchange has ended), sender_withdrew (the sender wants to stop), wrong_contact (the message was meant for someone else), transaction_boundary (continuing would commit Ali to a payment, purchase or delivery), no_safe_follow_up (no reply would be safe), awaiting_sender (Ali asked something the sender has not answered yet, or the sender said they would follow up), personal_details_request (answering would give out personal, contact, payment or delivery details), unclear_message (the message cannot be understood), abusive_message (the message is abusive or hostile), automated_message (the message is automated or a broadcast, not written to Ali), unsupported_language (the message is in a language Ali does not use).',
  'Then set silence_explanation to one plain English sentence for the officer: what in the conversation made Ali stay silent, and why a reply is not needed or not safe. Do not repeat links, phone numbers, account or card numbers, addresses or other contact or payment details in it.',
  'An officer_brief is an unverified lead. Evaluate the actual chat independently, including facts that contradict the brief.',
  'Only the captured sender messages can support a fraud indicator. Keep officer_brief and payment_link_candidates private.',
  'Use payment_link_review only for a supplied candidate linked to an unsupported payment demand or another concrete concern visible in the chat.',
  'Link flags and conversation assessments are private warnings for the officer. Continue the conversation with a safe public reply when appropriate. A link alone or a repeated link does not justify silence or a separate conversation warning. Below the conversation assessment threshold use SUSPICIOUS with an empty review_reasons array for a flagged link.',
  'An unfamiliar host alone is insufficient. Return null if none qualifies. Use its supplied candidate_id and the schema reason. Never visit the link.',
  'If meeting_arranged is true, the contact agreed to an in-person exchange and a time and place were supplied. A calendar day is established only when meeting_day_confirmed is true. Respond naturally to a genuinely new question or concern. For a routine close, a short acknowledgement or silence is enough. Do not re-ask for confirmed details, promise to attend, or disclose this internal assessment.',
].join('\n');

const PUBLIC_REPLY_INSTRUCTIONS = [
  'For this writing pass, follow Ali’s conversation instructions and use the ali_public_reply response format. The private assessment is handled separately. Return only external_reply with the message to send.',
  'Write as Ali in the language of the exchange. Answer what the sender actually said using the conversation so far. For a follow_up dispatch, write a natural follow-up grounded in that exchange.',
  'Keep warning labels and assessment fields private. Treat a supplied link as unvisited. Do not claim to have opened it, repeat private details, or promise a payment.',
].join('\n');

/** Parses the base URL and accepts only http(s) on exactly 127.0.0.1, localhost or [::1]. */
function loopbackBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!WEB_PROTOCOLS.includes(url.protocol) || !LOOPBACK_HOSTNAMES.includes(url.hostname)) {
    throw new Error('the LM Studio base URL must be an http(s) URL on a loopback host: 127.0.0.1, localhost or [::1]');
  }
  return baseUrl.replace(TRAILING_SLASHES, '');
}

/** How many characters of history fit beside these instructions and the reply in a context of this many tokens. */
export function historyCharsFor(contextTokens: number, systemPrompt: string): number {
  const promptTokens = Math.ceil(systemPrompt.length / PROMPT_CHARS_PER_TOKEN);
  const freeTokens = contextTokens - promptTokens - MAX_OUTPUT_TOKENS - TEMPLATE_TOKENS;
  return Math.min(MAX_HISTORY_CHARS, Math.max(MIN_HISTORY_CHARS, freeTokens * HISTORY_CHARS_PER_TOKEN));
}

/** Keep a late question or correction when the newest incoming text alone needs clipping. */
function fitTurn(text: string, budget: number, latestIncoming: boolean): string {
  const limit = Math.max(0, Math.min(budget, latestIncoming ? MAX_LATEST_INCOMING_CHARS : MAX_TURN_CHARS));
  if (text.length <= limit || limit === 0) return text.slice(0, limit);
  let headLength = limit;
  let ending = '';
  if (latestIncoming) {
    const marker = limit >= OMITTED_MIDDLE.length + 2 ? OMITTED_MIDDLE : '…';
    const available = limit - marker.length;
    headLength = Math.floor(available / 2);
    const tailStart = text.length - (available - headLength);
    ending = marker + text.slice(tailStart).replace(/^[\uDC00-\uDFFF]/u, '');
  }
  // JavaScript slice offsets count UTF-16 code units. Drop a partial code point at either cut.
  return text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, '') + ending;
}

/** The latest eligible turns that fit the history budget, returned oldest first. */
function recentTurns(history: readonly ReplyTurn[], maxChars: number): ReplyTurn[] {
  if (maxChars <= 0) return [];
  const kept: ReplyTurn[] = [];
  let used = 0;
  for (const turn of [...history].reverse()) {
    const source = turn.text.trim();
    const content = turn.from === 'owner' ? withoutAssistantIntroduction(source) : maskProjectName(source);
    if (turn.from === 'owner' && mentionsProjectName(content)) continue;
    const text = fitTurn(content, maxChars, kept.length === 0 && turn.from === 'contact');
    if (text === '') continue;
    if (kept.length > 0 && used + text.length > maxChars) break;
    kept.push({ from: turn.from, text });
    used += text.length;
  }
  return kept.reverse();
}

/** A follow-up can have many intervening outgoing messages. Keep the sender's own words and the newest replies. */
function followUpTurns(history: readonly ReplyTurn[], maxChars: number): ReplyTurn[] {
  const sourceIndex = history.findLastIndex(turn => turn.from === 'contact' && turn.text.trim().length > 0);
  if (sourceIndex < 0 || sourceIndex === history.length - 1) return recentTurns(history, maxChars);
  const source = maskProjectName(history[sourceIndex]!.text.trim());
  const sourceText = fitTurn(source, Math.ceil(maxChars / 2), true);
  if (!sourceText) return [];
  const after = recentTurns(history.slice(sourceIndex + 1), maxChars - sourceText.length);
  const remaining = maxChars - sourceText.length - after.reduce((sum, turn) => sum + turn.text.length, 0);
  const before = recentTurns(history.slice(0, sourceIndex), remaining);
  return [...before, { from: 'contact', text: sourceText }, ...after];
}


/** Keep conversation rules from the selected file. Case material stays outside the system instructions. */
export function buildReplyMessages(
  history: readonly ReplyTurn[],
  prompt: string | AliPromptSnapshot = currentAliPrompt(),
  historyChars?: number,
  correction?: string,
  contextTokens: number = DEFAULT_CONTEXT_TOKENS,
  currentTurn?: readonly string[],
  memory?: ReplyOfferMemory,
  context?: ReplyInvestigationContext,
  output: ReplyOutputMode = 'decision',
): ChatMessage[] {
  const systemPrompt = typeof prompt === 'string' ? prompt : prompt.text;
  const production = typeof prompt !== 'string' || prompt === REPLY_SYSTEM_PROMPT;
  let modelInstructions = systemPrompt;
  if (output === 'public_reply') {
    modelInstructions += '\n\n' + PUBLIC_REPLY_INSTRUCTIONS;
  } else if (context && production) {
    modelInstructions = systemPrompt.trimEnd() + '\n\n' + INVESTIGATION_OUTPUT_INSTRUCTIONS;
  }
  if (context?.dispatchIntent && production && output === 'decision') {
    modelInstructions += '\nThe officer requested a message now. For reply or retry, respond to the latest sender turn. A short acknowledgement is enough when there is no question. For follow_up, write a new, natural follow-up to the recent exchange. Choose a public reply when the conversation can continue safely. Keep officer actions private and use the usual review decisions when needed.';
  }
  if (correction === SILENCE_EXPLANATION_REQUEST && output === 'decision') {
    modelInstructions += '\nYour previous decision chose silence without silence_explanation. Decide again. If Ali still should not reply, give the precise silence_reason and a one-sentence silence_explanation for the officer.';
  }
  if (context?.attachmentKinds?.length) {
    modelInstructions += '\nThe latest attachment arrived without a caption. You know only its type. Ask the sender naturally for the information in text, without claiming to have seen or heard the contents.';
  }
  const messages: ChatMessage[] = [{ role: 'system', content: modelInstructions }];
  let projection = history;
  if (currentTurn?.length) {
    const start = history.length - currentTurn.length;
    if (start > 0 && history[start - 1]?.from === 'contact' && history[start]?.from === 'contact') {
      // The earlier burst ended without an outgoing message. Keep that boundary in model input only.
      projection = [...history.slice(0, start), { from: 'owner', text: NO_REPLY }, ...history.slice(start)];
    }
  }
  const dispatchBrief = output === 'decision' ? context?.dispatchBrief : undefined;
  const paymentLinks = output === 'decision' ? context?.paymentLinks : undefined;
  const investigationData = context && (context.dispatchIntent || dispatchBrief || paymentLinks?.length || context.meetingArranged || context.attachmentKinds?.length)
    ? JSON.stringify({
      officer_dispatch_request: context.dispatchIntent,
      officer_brief: dispatchBrief && maskProjectName(dispatchBrief),
      payment_link_candidates: paymentLinks,
      attachment_kinds: context.attachmentKinds,
      ...(context.meetingArranged && { meeting_arranged: true, meeting_day_confirmed: context.meetingDayConfirmed === true }),
    })
    : '';
  const totalBudget = historyChars ?? historyCharsFor(contextTokens, modelInstructions);
  // A briefing or candidate must never displace the sender's fresh message.
  const budget = Math.max(Math.min(MIN_HISTORY_CHARS, totalBudget), totalBudget - investigationData.length);
  const selectTurns = context?.dispatchIntent === 'follow_up' ? followUpTurns : recentTurns;
  let kept = selectTurns(projection, budget);
  if (memory && production) {
    const source = [memory.offer, ...(memory.correction ? [memory.correction] : [])];
    if (!source.every(excerpt => kept.some(t => t.from === 'contact' && t.text.includes(maskProjectName(excerpt))))) {
      const note = 'Earlier from the sender about their offer, oldest first (quoted): ' +
        JSON.stringify(source.map(maskProjectName));
      // Reserve room for the current question even if an embedder requests an unusually small budget.
      if (note.length < budget / 2) {
        messages.push({ role: 'user', content: note });
        kept = selectTurns(projection, budget - note.length - 1);
      }
    }
  }
  for (const turn of kept) {
    if (messages.length === 1 && turn.from === 'owner' && turn.text === NO_REPLY) continue;
    const role = turn.from === 'contact' ? 'user' : 'assistant';
    const last = messages.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n${turn.text}`;
    else messages.push({ role, content: turn.text });
  }
  const metadata = [
    investigationData,
    isReplyGuardRule(correction) ? JSON.stringify({ previous_draft_blocked_by: correction }) : '',
  ].filter(Boolean).join('\n');
  if (metadata) {
    const last = messages.at(-1);
    if (last?.role === 'user') last.content += '\n' + metadata;
    else messages.push({ role: 'user', content: metadata });
  }
  return messages;
}

/** Cuts a long reply after its last whole sentence within MAX_REPLY_CHARS, else at the last space. */
function shorten(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  const head = text.slice(0, MAX_REPLY_CHARS);
  const ends = [...head.matchAll(SENTENCE_END)];
  const lastEnd = ends.at(-1);
  if (lastEnd?.index !== undefined && lastEnd.index > MAX_REPLY_CHARS / 2) return head.slice(0, lastEnd.index + 1);
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trimEnd();
}

const normalizeIntroduction = (text: string): string => text.toLowerCase().replace(/[’‘]/g, "'");
/** The local product name has appeared under these English and Arabic spellings in older replies. */
export function mentionsProjectName(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/gu, '');
  return /m(?:irs|isr|ers)[aā]d|مي?ر[صس]اد/iu.test(normalized);
}

/** Preserve the source transcript. Only mask the name in the copy prepared for inference. */
function maskProjectName(text: string): string {
  if (!mentionsProjectName(text)) return text;
  return text.replace(/[\p{L}\p{M}]+/gu, word => mentionsProjectName(word) ? '[name]' : word);
}

/** Ignore the historical first-reply prefix in model input and when comparing previous outgoing answers. */
export function withoutAssistantIntroduction(reply: string): string {
  const normalized = normalizeIntroduction(reply);
  for (const introduction of [ENGLISH_INTRODUCTION, ARABIC_INTRODUCTION]) {
    if (normalized.startsWith(normalizeIntroduction(introduction))) return reply.slice(introduction.length).trimStart();
  }
  return reply;
}



function visibleReply(raw: string): string {
  const visible = raw.replace(THINKING_BLOCK, '').replace(UNCLOSED_THINKING, '').trim();
  return /^(["“«]).*(["”»])$/s.test(visible) ? visible.slice(1, -1).trim() : visible;
}

/** The model's answer as message text: thinking removed, surrounding quotes and space trimmed, length capped. */
export function cleanReply(raw: string): string {
  return shorten(visibleReply(raw));
}

function isRefusedRedirect(error: unknown): boolean {
  return error instanceof TypeError && error.cause instanceof Error && error.cause.message === REFUSED_REDIRECT_CAUSE;
}

function failureOf(error: unknown, caller: AbortSignal, timeout: AbortSignal): ReplyGenerationError {
  if (timeout.aborted) return new ReplyGenerationError('lmstudio_timeout');
  if (caller.aborted) return new ReplyGenerationError('reply_aborted');
  if (isRefusedRedirect(error)) return new ReplyGenerationError('lmstudio_redirect_refused');
  return new ReplyGenerationError('lmstudio_unreachable');
}

function completionContent(status: number, body: string, expectedModel?: string): string {
  if (status < 200 || status > 299) throw new ReplyGenerationError('lmstudio_http_error');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ReplyGenerationError('invalid_response');
  }
  const completion = Completion.safeParse(json);
  if (!completion.success || (expectedModel !== undefined && completion.data.model !== expectedModel)) {
    throw new ReplyGenerationError('invalid_response');
  }
  return completion.data.choices[0].message.content;
}

/** An explicit plain-text evaluation prompt uses the legacy text format, outside the production decision path. */
export function parseGeneratedReply(raw: string): string | null {
  const reply = visibleReply(raw);
  if (!reply) throw new InvalidReplyDraftError('empty_reply');
  if (reply === NO_REPLY) return null;
  if (hasInternalReplyContent(reply)) throw new InvalidReplyDraftError('invalid_response');
  return shorten(reply);
}

export function createLmStudioReplyGenerator(options: LmStudioReplyOptions): ReplyGenerator {
  const url = `${loopbackBaseUrl(options.baseUrl)}/chat/completions`;
  const send = options.fetch ?? fetch;
  const configuredPrompt = options.systemPrompt === REPLY_SYSTEM_PROMPT ? undefined : options.systemPrompt;

  const complete = async (output: ReplyOutputMode, args: Parameters<ReplyGenerator['generate']>) => {
    const [history, signal, correction, currentTurn, memory, context, turnPrompt = currentAliPrompt()] = args;
    if (signal.aborted) throw new ReplyGenerationError('reply_aborted');
    const prompt = configuredPrompt ?? turnPrompt;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const body = JSON.stringify({
      model: options.model,
      messages: buildReplyMessages(history, prompt, undefined, correction, options.contextTokens, currentTurn, memory, context, output),
      response_format: output === 'public_reply' ? ALI_PUBLIC_REPLY_FORMAT : typeof prompt === 'string' ? undefined : ALI_RESPONSE_FORMAT,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning_effort: 'none',
    });
    let status: number;
    let text: string;
    try {
      const response = await send(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error',
        signal: AbortSignal.any([signal, timeout]),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw failureOf(error, signal, timeout);
    }
    const content = completionContent(status, text, options.requireModelMatch ? options.model : undefined);
    return { content, prompt };
  };
  const decide: NonNullable<ReplyGenerator['decide']> = async (...args) => {
    const { content, prompt } = await complete('decision', args);
    if (typeof prompt !== 'string') return parseAliDecision(content, prompt.minimumDistinctIndicators);
    const reply = parseGeneratedReply(content);
    return reply === null ? { kind: 'silence', reason: 'reason_unavailable' } : { kind: 'reply', text: reply };
  };

  return Object.freeze({
    model: options.model,
    decide,
    generate: async (...args: Parameters<ReplyGenerator['generate']>) => publicReplyFromDecision(await decide(...args)),
    async composePublicReply(...args: Parameters<ReplyGenerator['generate']>) {
      const { content } = await complete('public_reply', args);
      return parseAliPublicReply(content);
    },
  });
}
