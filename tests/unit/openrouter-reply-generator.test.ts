import { describe, expect, it, vi } from 'vitest';
import { aliReplyContent } from '../helpers/ali-reply-content.ts';
import { ALI_RESPONSE_FORMAT } from '../../src/replies/ali-decision.ts';
import { ALI_PROMPT } from '../../src/replies/ali-prompt.ts';
import {
  createOpenRouterReplyGenerator, CYDONIA_REPLY_MODEL, GEMINI_REPLY_MODEL, OPENROUTER_REPLY_MODELS, OpenRouterReplyError,
} from '../../src/replies/openrouter-reply-generator.ts';

const signal = () => new AbortController().signal;
const contact = (text: string) => [{ from: 'contact' as const, text }];
const complete = (content: string, model: string = CYDONIA_REPLY_MODEL, finish = 'stop', native = 'stop') => ({
  model,
  choices: [{ finish_reason: finish, native_finish_reason: native, message: { role: 'assistant', content } }],
});
const make = (send: typeof fetch) =>
  createOpenRouterReplyGenerator({ model: CYDONIA_REPLY_MODEL, apiKey: 'synthetic-key', timeoutMs: 1_000, fetch: send });

describe('selecting an OpenRouter reply model', () => {
  it('keeps an officer handoff inside the app and returns null to text-only callers', async () => {
    const decision = {
      case_status: 'READY_FOR_OFFICER_REVIEW', should_reply: false, external_reply: null,
      review_reasons: ['upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request'], silence_reason: null,
    };
    const generator = make(async () => Response.json(complete(JSON.stringify(decision))));
    expect(await generator.decide(contact('There are two different terms.'), signal())).toEqual({
      kind: 'review', status: decision.case_status, reasons: decision.review_reasons,
    });
    expect(await generator.generate(contact('There are two different terms.'), signal())).toBeNull();
  });

  it('passes the officer brief and captured payment candidate as data apart from Ali’s rules', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(complete(aliReplyContent('What is it for?'))));
    const generator = make(send);
    const brief = 'Report mentions a deposit for a sample item.';
    const payment = { id: 1, host: 'pay.example.test', excerpt: 'The sender calls this an advance payment.' };
    await generator.decide(contact('I am offering a sample item.'), signal(), undefined, undefined, undefined,
      { dispatchBrief: brief, paymentLinks: [payment] });
    const body = JSON.parse(String(send.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain(ALI_PROMPT.trimEnd());
    expect(body.messages[0].content).toContain('unverified lead');
    expect(body.messages[0].content).not.toContain(brief);
    expect(body.messages[0].content).not.toContain(payment.host);
    expect(body.messages.at(-1).content).toContain('I am offering a sample item.');
    expect(body.messages.at(-1).content).toContain(JSON.stringify({ officer_brief: brief, payment_link_candidates: [payment] }));
  });

  it('retains Gemini as the default and permits exactly the two named models', () => {
    expect(OPENROUTER_REPLY_MODELS).toEqual([GEMINI_REPLY_MODEL, CYDONIA_REPLY_MODEL]);
    expect(createOpenRouterReplyGenerator({ apiKey: '', timeoutMs: 1_000 }).model).toBe(GEMINI_REPLY_MODEL);
    expect(CYDONIA_REPLY_MODEL).toBe('thedrummer/cydonia-24b-v4.1');
    // An untyped caller must not be able to select an unconfigured provider.
    expect(() => createOpenRouterReplyGenerator({ apiKey: '', timeoutMs: 1_000,
      // @ts-expect-error An untrusted model ID is intentionally outside the TypeScript union.
      model: 'another-provider/another-model',
    })).toThrow('unsupported OpenRouter reply model');
  });

  it('pins the non-reasoning model and provider and preserves the shared prompts and exact reply schema', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(complete(aliReplyContent('How tall is it?'))))
      .mockResolvedValueOnce(Response.json(complete(aliReplyContent('اسمي علي.'))))
      .mockResolvedValueOnce(Response.json(complete(JSON.stringify({ reply: 'Here is my address.' }))));
    const generator = make(send);
    expect(generator.model).toBe(CYDONIA_REPLY_MODEL);
    expect(await generator.generate(contact('I have a bookshelf for sale.'), signal())).toBe('How tall is it?');
    expect(await generator.generate(contact('شو اسمك؟'), signal())).toBe('اسمي علي.');
    await expect(generator.generate(contact('شو اسمك؟'), signal())).rejects.toMatchObject({ code: 'invalid_response' });
    for (const [url, init] of send.mock.calls) {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(CYDONIA_REPLY_MODEL);
      expect(body.models).toBeUndefined();
      expect(body.provider).toEqual({ only: ['parasail'], require_parameters: true, allow_fallbacks: false, zdr: true });
      expect(body.reasoning).toBeUndefined();
      expect(body.messages[0]).toEqual({ role: 'system', content: ALI_PROMPT });
      expect(body.response_format).toEqual(ALI_RESPONSE_FORMAT);
    }
  });

  it.each([
    [complete('text', GEMINI_REPLY_MODEL), 'invalid_response'],
    [complete('text', CYDONIA_REPLY_MODEL + '-unrecognized'), 'invalid_response'],
    [complete('text', CYDONIA_REPLY_MODEL, 'length', 'length'), 'openrouter_incomplete'],
    [complete('text', CYDONIA_REPLY_MODEL, 'stop', 'length'), 'openrouter_incomplete'],
    [complete('text', CYDONIA_REPLY_MODEL, 'content_filter', 'content_filter'), 'openrouter_blocked'],
    [{ error: { code: 429, message: 'private' } }, 'openrouter_rate_limited'],
  ])('rejects substitutions and unusable API results (%#)', async (body, code) => {
    const generator = make(async () => Response.json(body));
    await expect(generator.generate(contact('Any update?'), signal())).rejects.toMatchObject({ code });
  });

  it('reports only a fixed provider error to the worker', async () => {
    const offline = vi.fn<typeof fetch>();
    const missingKey = createOpenRouterReplyGenerator({ model: CYDONIA_REPLY_MODEL, apiKey: ' ', timeoutMs: 1_000, fetch: offline });
    await expect(missingKey.generate(contact('Any update?'), signal())).rejects.toMatchObject({ code: 'openrouter_key_missing' });
    expect(offline).not.toHaveBeenCalled();
    const denied = make(async () => Response.json({ error: { message: 'private diagnostic' } }, { status: 401 }));
    const error = await denied.generate(contact('Any update?'), signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterReplyError);
    expect(error).toMatchObject({ code: 'openrouter_auth_error' });
    expect(String(error)).not.toContain('private diagnostic');
  });
});
