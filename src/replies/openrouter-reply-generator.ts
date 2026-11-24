/** Writes Telegram replies through the configured OpenRouter model. Evidence review and delivery have separate clients. */
import { z } from 'zod';
import { ALI_PUBLIC_REPLY_FORMAT, ALI_RESPONSE_FORMAT, parseAliDecision, parseAliPublicReply, publicReplyFromDecision } from './ali-decision.ts';
import { currentAliPrompt } from './ali-prompt.ts';
import { buildReplyMessages, InvalidReplyDraftError, ReplyGenerationError, type ReplyGenerator, type ReplyOutputMode } from './reply-generator.ts';

export const GEMINI_REPLY_MODEL = 'google/gemini-3.8-flash';
export const CYDONIA_REPLY_MODEL = 'thedrummer/cydonia-24b-v4.1';
export const OPENROUTER_REPLY_MODELS = [GEMINI_REPLY_MODEL, CYDONIA_REPLY_MODEL] as const;
export type OpenRouterReplyModel = (typeof OPENROUTER_REPLY_MODELS)[number];
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const PROFILES = {
  [GEMINI_REPLY_MODEL]: {
    contextTokens: 1_048_576,
    parameters: {
      provider: { only: ['google-ai-studio', 'google-vertex/global'], require_parameters: true },
      reasoning: { effort: 'low', exclude: true },
    },
  },
  [CYDONIA_REPLY_MODEL]: {
    contextTokens: 131_072,
    parameters: {
      provider: { only: ['parasail'], require_parameters: true, allow_fallbacks: false, zdr: true },
    },
  },
} as const;
// Includes reasoning tokens. The app separately caps the visible Telegram reply.
const OUTPUT_TOKENS = 2_048;

const Choice = z.object({
  finish_reason: z.string().nullable(),
  native_finish_reason: z.string().nullable().optional(),
  error: z.object({ code: z.number().optional() }).nullable().optional(),
  message: z.object({
    role: z.literal('assistant'), content: z.string().nullable(), refusal: z.string().nullable().optional(),
    tool_calls: z.array(z.unknown()).nullable().optional(),
  }).optional(),
});
const Result = z.object({
  model: z.string().optional(),
  choices: z.array(Choice).optional(),
  error: z.object({ code: z.number().optional() }).nullable().optional(),
});

export interface OpenRouterReplyOptions {
  model?: OpenRouterReplyModel;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type ProviderFailure = 'auth_error' | 'insufficient_credits' | 'rate_limited' | 'http_error' | 'incomplete'
  | 'blocked' | 'key_missing' | 'timeout' | 'unreachable';

export class OpenRouterReplyError extends Error {
  readonly code: `openrouter_${ProviderFailure}`;

  constructor(code: `openrouter_${ProviderFailure}`) {
    super(`reply generation failed: ${code}`);
    this.name = 'OpenRouterReplyError';
    this.code = code;
  }
}

function providerError(model: OpenRouterReplyModel, failure: ProviderFailure): ReplyGenerationError | OpenRouterReplyError {
  return model === GEMINI_REPLY_MODEL
    ? new ReplyGenerationError(`gemini_${failure}`)
    : new OpenRouterReplyError(`openrouter_${failure}`);
}

function httpError(model: OpenRouterReplyModel, status?: number): ReplyGenerationError | OpenRouterReplyError {
  if (status === 401 || status === 403) return providerError(model, 'auth_error');
  if (status === 402) return providerError(model, 'insufficient_credits');
  if (status === 429) return providerError(model, 'rate_limited');
  return providerError(model, 'http_error');
}

function completionContent(expected: OpenRouterReplyModel, status: number, raw: string): string {
  // Router errors may echo credentials or chat content. Only return fixed codes.
  if (status < 200 || status >= 300) throw httpError(expected, status);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ReplyGenerationError('invalid_response');
  }
  const result = Result.safeParse(json);
  if (!result.success) throw new ReplyGenerationError('invalid_response');
  const { error, model, choices: candidates } = result.data;
  if (error) throw httpError(expected, error.code);
  // Only Gemini has a verified canonical dated snapshot in addition to its catalog ID.
  const matchesModel = model === expected || (expected === GEMINI_REPLY_MODEL && model === GEMINI_REPLY_MODEL + '-20260902');
  if (!matchesModel || candidates?.length !== 1)
    throw new ReplyGenerationError('invalid_response');
  const candidate = candidates[0]!;
  if (candidate.error) throw httpError(expected, candidate.error.code);
  if (candidate.finish_reason === 'error') throw httpError(expected);
  const nativeFinish = candidate.native_finish_reason?.toUpperCase();
  if (candidate.finish_reason === 'length' || nativeFinish === 'MAX_TOKENS' || nativeFinish === 'LENGTH')
    throw providerError(expected, 'incomplete');
  if (candidate.finish_reason === 'content_filter' || candidate.message?.refusal
    || (nativeFinish && nativeFinish !== 'STOP')) throw providerError(expected, 'blocked');
  if (candidate.finish_reason !== 'stop' || !candidate.message || candidate.message.tool_calls?.length)
    throw new ReplyGenerationError('invalid_response');
  if (candidate.message.content === null) throw new ReplyGenerationError('empty_reply');
  if (!candidate.message.content.trim()) throw new InvalidReplyDraftError('empty_reply');
  return candidate.message.content;
}

export function createOpenRouterReplyGenerator(options: OpenRouterReplyOptions): Required<ReplyGenerator> {
  const model = options.model === undefined ? GEMINI_REPLY_MODEL : options.model;
  if (!OPENROUTER_REPLY_MODELS.includes(model)) throw new Error('unsupported OpenRouter reply model');
  const profile = PROFILES[model];
  const key = options.apiKey.trim();
  const send = options.fetch ?? fetch;
  const complete = async (output: ReplyOutputMode, args: Parameters<ReplyGenerator['generate']>) => {
    const [history, signal, correction, currentTurn, memory, context, prompt = currentAliPrompt()] = args;
    if (signal.aborted) throw new ReplyGenerationError('reply_aborted');
    if (!key) throw providerError(model, 'key_missing');
    const messages = buildReplyMessages(history, prompt, undefined, correction, profile.contextTokens, currentTurn, memory, context, output);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await send(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, timeout]),
        body: JSON.stringify({
          model, messages, max_tokens: OUTPUT_TOKENS,
          response_format: output === 'public_reply' ? ALI_PUBLIC_REPLY_FORMAT : ALI_RESPONSE_FORMAT, ...profile.parameters,
        }),
      });
      body = await response.text();
    } catch {
      if (signal.aborted) throw new ReplyGenerationError('reply_aborted');
      if (timeout.aborted) throw providerError(model, 'timeout');
      throw providerError(model, 'unreachable');
    }
    return { content: completionContent(model, response.status, body), prompt };
  };
  const decide: NonNullable<ReplyGenerator['decide']> = async (...args) => {
    const { content, prompt } = await complete('decision', args);
    return parseAliDecision(content, prompt.minimumDistinctIndicators);
  };
  return Object.freeze({
    model, decide,
    async generate(...args: Parameters<ReplyGenerator['generate']>) {
      return publicReplyFromDecision(await decide(...args));
    },
    async composePublicReply(...args: Parameters<ReplyGenerator['generate']>) {
      const { content } = await complete('public_reply', args);
      return parseAliPublicReply(content);
    },
  });
}
