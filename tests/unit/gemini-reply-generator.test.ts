import { describe, expect, it, vi } from 'vitest';
import { createGeminiReplyGenerator, GEMINI_REPLY_MODEL } from '../../src/replies/gemini-reply-generator.ts';
import { type ReplyTurn } from '../../src/replies/reply-generator.ts';
import { ALI_RESPONSE_FORMAT } from '../../src/replies/ali-decision.ts';
import { ALI_PROMPT } from '../../src/replies/ali-prompt.ts';
import { aliReplyContent } from '../helpers/ali-reply-content.ts';

const key = 'synthetic-openrouter-credential';
const greeting: ReplyTurn[] = [{ from: 'contact', text: 'Hello!' }];
const signal = () => new AbortController().signal;
const make = (fetch: typeof globalThis.fetch, timeoutMs = 3_000) =>
  createGeminiReplyGenerator({ apiKey: key, timeoutMs, fetch });
const response = (content: string | null, finish = 'stop', model = 'google/gemini-3.8-flash') => ({
  model, choices: [{ finish_reason: finish, message: { role: 'assistant', content, reasoning: 'private reasoning' } }],
});

describe('Gemini replies via OpenRouter', () => {
  it('can start with a blank key and fails a draft before contacting OpenRouter', async () => {
    const send = vi.fn<typeof fetch>();
    const generator = createGeminiReplyGenerator({ apiKey: '  ', timeoutMs: 1_000, fetch: send });
    await expect(generator.generate(greeting, signal())).rejects.toMatchObject({ code: 'gemini_key_missing' });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses one fixed endpoint, model and header-only credential for English and Arabic conversations', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json(response(aliReplyContent('Hi there.'), 'stop', 'google/gemini-3.8-flash-20260902')));
    const generator = make(send);
    expect(generator.model).toBe('google/gemini-3.8-flash');
    expect(GEMINI_REPLY_MODEL).toBe(generator.model);
    for (const contact of ['What kind of item is that?', 'شو تقصد بهالكلام؟']) {
      const history: ReplyTurn[] = [...greeting, { from: 'owner', text: 'Hi.' }, { from: 'contact', text: contact }];
      expect(await generator.generate(history, signal())).toBe('Hi there.');
      const [url, request] = send.mock.calls.at(-1)!;
      expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(request?.redirect).toBe('error');
      expect(new Headers(request?.headers).get('authorization')).toBe('Bearer ' + key);
      expect(String(request?.body)).not.toContain(key);
      const payload = JSON.parse(String(request?.body));
      expect(payload.model).toBe(generator.model);
      expect(payload.models).toBeUndefined();
      expect(payload.provider).toMatchObject({ require_parameters: true, only: ['google-ai-studio', 'google-vertex/global'] });
      expect(payload.messages.slice(1)).toEqual([
        { role: 'user', content: 'Hello!' }, { role: 'assistant', content: 'Hi.' }, { role: 'user', content: contact },
      ]);
      expect(payload.messages[0]).toEqual({ role: 'system', content: ALI_PROMPT });
      expect(payload.response_format).toEqual(ALI_RESPONSE_FORMAT);
      expect(payload.reasoning).toEqual({ effort: 'low', exclude: true });
      expect(payload.tools).toBeUndefined();
    }
  });

  it('uses the shared decision schema for a name question and rejects the obsolete reply envelope', async () => {
    const name: ReplyTurn[] = [{ from: 'contact', text: 'شو اسمك؟' }];
    const allowed = 'اسمي علي.';
    const send = vi.fn<typeof fetch>(async () => Response.json(response(aliReplyContent(allowed))));
    const generator = make(send);
    expect(await generator.generate(name, signal())).toBe(allowed);
    const format = JSON.parse(String(send.mock.calls[0]![1]?.body)).response_format;
    expect(format).toEqual(ALI_RESPONSE_FORMAT);
    send.mockResolvedValueOnce(Response.json(response('{"reply":"I will send my photo."}')));
    await expect(generator.generate(name, signal())).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('preserves the model’s silence reason for the officer and rejects leaked codes in public text', async () => {
    const silence = JSON.stringify({
      case_status: 'MONITORING', should_reply: false, external_reply: null, review_reasons: [], silence_reason: 'already_answered',
    });
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(response(silence)))
      .mockResolvedValueOnce(Response.json(response(silence)))
      .mockResolvedValueOnce(Response.json(response(aliReplyContent('already_answered'))))
      .mockResolvedValueOnce(Response.json(response('[NO_REPLY] plus a reply')));
    const generator = make(send);
    expect(await generator.decide(greeting, signal())).toEqual({ kind: 'silence', reason: 'already_answered' });
    expect(await generator.generate(greeting, signal())).toBeNull();
    await expect(generator.generate(greeting, signal())).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(generator.generate(greeting, signal())).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('preserves sender-attributed offer memory for both a recall question and a viewing request', async () => {
    const memory = { offer: 'عندي رف للبيع.', correction: 'تصحيح، الرف من خشب.' };
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const reply = body.messages.at(-1).content.includes('Want to see it?') ? 'You can describe it here.' : 'What size is the shelf?';
      return Response.json(response(aliReplyContent(reply)));
    });
    const generator = make(send);
    const early = [{ from: 'contact' as const, text: 'What did we discuss?' }];
    await generator.generate(early, signal(), undefined, [early[0]!.text], memory);
    const messages = JSON.parse(String(send.mock.calls[0]![1]?.body)).messages;
    expect(messages.some((m: { role: string; content: string }) =>
      m.role === 'user' && m.content.includes(memory.offer) && m.content.includes(memory.correction))).toBe(true);
    const current = [{ from: 'contact' as const, text: 'Want to see it?' }];
    expect(await generator.generate(current, signal(), undefined, [current[0]!.text], memory)).toBe('You can describe it here.');
    const second = JSON.parse(String(send.mock.calls[1]![1]?.body));
    expect(second.messages.some((m: { role: string; content: string }) =>
      m.role === 'user' && m.content.includes(memory.offer) && m.content.includes(memory.correction))).toBe(true);
    expect(second.messages[0].content).toBe(ALI_PROMPT);
  });

  it.each([
    [response('partial', 'length'), 'gemini_incomplete'],
    [response('blocked', 'content_filter'), 'gemini_blocked'],
    [response('partial', 'error'), 'gemini_http_error'],
    [response('wrong', 'stop', 'google/gemini-3.8-flash-lite'), 'invalid_response'],
    [response(null), 'empty_reply'],
    [{ error: { code: 402, message: 'private' } }, 'gemini_insufficient_credits'],
    [{ ...response('draft'), choices: [{ ...response('draft').choices[0], native_finish_reason: 'SAFETY' }] }, 'gemini_blocked'],
    [{ ...response('draft'), choices: [{ ...response('draft').choices[0], error: { code: 429 } }] }, 'gemini_rate_limited'],
    [{ ...response('draft'), choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'private', refusal: 'private' } }] }, 'gemini_blocked'],
    [{ ...response('draft'), choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [{}] } }] }, 'invalid_response'],
    [{ model: GEMINI_REPLY_MODEL, choices: [] }, 'invalid_response'],
  ])('rejects incomplete, refused or invalid results (%#)', async (body, code) => {
    const generator = make(async () => Response.json(body));
    await expect(generator.generate(greeting, signal())).rejects.toMatchObject({ code });
  });

  it.each([
    [400, 'gemini_http_error'], [401, 'gemini_auth_error'], [403, 'gemini_auth_error'],
    [402, 'gemini_insufficient_credits'], [429, 'gemini_rate_limited'], [503, 'gemini_http_error'],
  ])('sanitizes HTTP errors (%i)', async (status, code) => {
    const generator = make(async () => Response.json({ error: { message: 'private text ' + key } }, { status: Number(status) }));
    const error = await generator.generate(greeting, signal()).catch((e: Error & { code: string }) => e);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toMatch(/private text|synthetic-openrouter-credential/u);
  });

  it('honors cancellation and timeouts without exposing transport errors', async () => {
    const caller = new AbortController();
    caller.abort();
    const send = vi.fn<typeof fetch>();
    await expect(make(send).generate(greeting, caller.signal)).rejects.toMatchObject({ code: 'reply_aborted' });
    expect(send).not.toHaveBeenCalled();
    const wait: typeof fetch = (_url, init) => new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error(key)), { once: true }));
    await expect(make(wait, 15).generate(greeting, signal())).rejects.toMatchObject({ code: 'gemini_timeout' });
    await expect(make(async () => { throw new Error(key); }).generate(greeting, signal())).rejects.toMatchObject({ code: 'gemini_unreachable' });
  });
});
