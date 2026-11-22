/**
 * The LM Studio reviewer (design sections 10, "Model request", and 19.7): an OpenAI-compatible chat completion on a
 * loopback URL with a strict JSON schema answer. Every failure is a ReviewerUnavailableError with its own code. It
 * logs nothing, so message text, quotes and values never reach a log.
 */
import { z } from 'zod';
import { ReviewerUnavailableError, type ExtractedItem, type Reviewer, type ReviewerHealth } from '../ports/reviewer.ts';
import {
  buildMessages,
  chunkCharsFor,
  ModelAnswer,
  RESPONSE_SCHEMA,
  splitForContext,
  toExtractedItem,
  type PromptInput,
} from './prompt.ts';

export interface LmStudioReviewerOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  contextTokens: number;
  fetch?: typeof fetch;
}

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const WEB_PROTOCOLS = ['http:', 'https:'];
const REFUSED_BASE_URL = 'the LM Studio base URL must be an http(s) URL on a loopback host: 127.0.0.1, localhost or [::1]';
const TRAILING_SLASHES = /\/+$/;
/** Settings verified against the local model (design section 19.7). */
const MAX_OUTPUT_TOKENS = 512;
const TEMPERATURE = 0;
const SCHEMA_NAME = 'mirsad_review';
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_BAD_REQUEST = 400;
const CONTEXT_OVERFLOW_ERROR = 'exceed_context_size_error';
const REFUSED_REDIRECT_CAUSE = 'unexpected redirect';
/** LM Studio's own REST list, at the server origin, reports each model's load state (the /v1 list does not). */
const MODELS_PATH = '/api/v0/models';
const LOADED_STATE = 'loaded';
/** A status check should answer quickly whatever the review timeout is. */
const HEALTH_TIMEOUT_MS = 5_000;

/** LM Studio's model list (GET /api/v0/models); entries carry more fields than these. */
const ModelList = z.object({ data: z.array(z.object({ id: z.string(), state: z.string().optional() })) });
const UNHEALTHY: ReviewerHealth = { reachable: false, modelId: null };

const Choice = z.object({
  finish_reason: z.string().nullable(),
  message: z.object({ content: z.string().nullable().optional() }),
});
const Completion = z.object({ choices: z.tuple([Choice], Choice) });

interface HttpReply {
  status: number;
  text: string;
}

/** One deadline for the whole review, and the code for whatever interrupted a request. */
interface Deadline {
  signal: AbortSignal;
  failure(error: unknown): ReviewerUnavailableError;
}

/** Parses the base URL and accepts only http(s) on exactly 127.0.0.1, localhost or [::1]. */
function loopbackBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(REFUSED_BASE_URL);
  }
  if (!WEB_PROTOCOLS.includes(url.protocol) || !LOOPBACK_HOSTNAMES.includes(url.hostname)) throw new Error(REFUSED_BASE_URL);
  return url;
}

/** fetch with `redirect: 'error'` rejects a redirect with this cause (Node 24's undici). */
function isRefusedRedirect(error: unknown): boolean {
  return error instanceof TypeError && error.cause instanceof Error && error.cause.message === REFUSED_REDIRECT_CAUSE;
}

function startDeadline(caller: AbortSignal, timeoutMs: number): Deadline {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any([caller, timeout]),
    failure(error) {
      if (timeout.aborted) return new ReviewerUnavailableError('lmstudio_timeout');
      if (caller.aborted) return new ReviewerUnavailableError('review_aborted');
      if (isRefusedRedirect(error)) return new ReviewerUnavailableError('lmstudio_redirect_refused');
      return new ReviewerUnavailableError('lmstudio_unreachable');
    },
  };
}

function completionBody(model: string, input: PromptInput): string {
  return JSON.stringify({
    model,
    messages: buildMessages(input),
    temperature: TEMPERATURE,
    max_tokens: MAX_OUTPUT_TOKENS,
    reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema: RESPONSE_SCHEMA } },
  });
}

async function post(send: typeof fetch, url: string, body: string, deadline: Deadline): Promise<HttpReply> {
  try {
    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: deadline.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw deadline.failure(error);
  }
}

/** LM Studio reports a request that does not fit the loaded context as HTTP 400 naming this error type. */
function isContextOverflow(reply: HttpReply): boolean {
  return reply.status === HTTP_BAD_REQUEST && reply.text.includes(CONTEXT_OVERFLOW_ERROR);
}

/** Any other HTTP 400 is retried once: one was seen at warm-up and not again (design section 19.7). */
function isRetryable(reply: HttpReply): boolean {
  return reply.status === HTTP_BAD_REQUEST && !isContextOverflow(reply);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The answer text, usable only when the model finished with stop and wrote something (design section 19.7). */
function contentOf(reply: HttpReply): string {
  const completion = Completion.safeParse(parseJson(reply.text));
  if (!completion.success) throw new ReviewerUnavailableError('lmstudio_invalid_response');
  const [choice] = completion.data.choices;
  if (choice.finish_reason !== 'stop') throw new ReviewerUnavailableError('lmstudio_unfinished');
  const content = choice.message.content ?? '';
  if (content.trim() === '') throw new ReviewerUnavailableError('lmstudio_empty_content');
  return content;
}

function itemsOf(content: string): ExtractedItem[] {
  const parsed = parseJson(content);
  if (parsed === undefined) throw new ReviewerUnavailableError('lmstudio_invalid_json');
  const answer = ModelAnswer.safeParse(parsed);
  if (!answer.success) throw new ReviewerUnavailableError('lmstudio_invalid_output');
  return answer.data.items.map(toExtractedItem);
}

/**
 * Healthy only when LM Studio lists the configured model as loaded: it answers a request for any other model name
 * with whichever model is loaded, so a completion alone proves nothing (design section 19.7). Any failure to tell is
 * reported as unreachable, never thrown.
 */
async function checkHealth(send: typeof fetch, modelsUrl: string, model: string, timeoutMs: number): Promise<ReviewerHealth> {
  try {
    const response = await send(modelsUrl, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return UNHEALTHY;
    const list = ModelList.safeParse(parseJson(await response.text()));
    const loaded = list.success && list.data.data.some((entry) => entry.id === model && entry.state === LOADED_STATE);
    return loaded ? { reachable: true, modelId: model } : UNHEALTHY;
  } catch {
    return UNHEALTHY;
  }
}

/** Items of all chunks in order, each exact duplicate (an item seen in an overlap or repeated text) once. */
function mergeItems(perChunk: readonly ExtractedItem[][]): ExtractedItem[] {
  const seen = new Set<string>();
  return perChunk.flat().filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createLmStudioReviewer(options: LmStudioReviewerOptions): Reviewer {
  const base = loopbackBaseUrl(options.baseUrl);
  const send = options.fetch ?? fetch;
  const completionsUrl = `${base.origin}${base.pathname.replace(TRAILING_SLASHES, '')}/chat/completions`;
  const modelsUrl = `${base.origin}${MODELS_PATH}`;
  const chunkChars = chunkCharsFor(options.contextTokens);

  async function reviewChunk(input: PromptInput, deadline: Deadline): Promise<ExtractedItem[]> {
    const body = completionBody(options.model, input);
    const first = await post(send, completionsUrl, body, deadline);
    const reply = isRetryable(first) ? await post(send, completionsUrl, body, deadline) : first;
    if (isContextOverflow(reply)) throw new ReviewerUnavailableError('lmstudio_context_overflow');
    if (reply.status < HTTP_OK_MIN || reply.status > HTTP_OK_MAX) throw new ReviewerUnavailableError('lmstudio_http_error');
    return itemsOf(contentOf(reply));
  }

  return {
    name: 'lmstudio',
    async review(request, signal) {
      const deadline = startDeadline(signal, options.timeoutMs);
      const perChunk: ExtractedItem[][] = [];
      // In order, one at a time: a long message never takes more than one of LM Studio's parallel slots.
      for (const text of splitForContext(request.text, chunkChars)) {
        perChunk.push(await reviewChunk({ messageId: request.messageId, text }, deadline));
      }
      return { items: mergeItems(perChunk) };
    },
    health: () => checkHealth(send, modelsUrl, options.model, Math.min(HEALTH_TIMEOUT_MS, options.timeoutMs)),
  };
}
