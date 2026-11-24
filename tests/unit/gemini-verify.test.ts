import { expect, it, vi } from 'vitest';
import { runGeminiVerify, runOpenRouterVerify } from '../../scripts/verify-gemini.ts';
import { aliReplyContent } from '../helpers/ali-reply-content.ts';
import { ALI_RESPONSE_FORMAT } from '../../src/replies/ali-decision.ts';

const syntheticKey = 'synthetic-key-for-verification-tests';
const env = { OPENROUTER_API_KEY: syntheticKey, TELEGRAM_BOT_TOKEN: 'synthetic-telegram-token' };

function completion(reply: string): Response {
  return Response.json({
    model: 'google/gemini-3.8-flash',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: aliReplyContent(reply) } }],
  });
}

it('reports a missing OpenRouter key and ignores credentials for unrelated providers', async () => {
  const fetchModel = vi.fn();
  const lines: string[] = [];
  expect(await runGeminiVerify({ OPENROUTER_API_KEY: ' ', GEMINI_API_KEY: 'unused-google-secret' }, fetchModel, line => lines.push(line))).toBe(1);
  expect(fetchModel).not.toHaveBeenCalled();
  expect(lines.join(' ')).toMatch(/gemini_key_missing.*OPENROUTER_API_KEY/);
});

it('verifies the configured Cydonia route in both languages and on seller recall', async () => {
  const model = 'thedrummer/cydonia-24b-v4.1';
  const answers = ['My name is Ali. I keep those details private.', 'اسمي علي، وباقي التفاصيل خاصة.', 'The sender did.'];
  const send = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(model);
    const reply = answers.shift()!;
    return Response.json({ model, choices: [{ finish_reason: 'stop', message: {
      role: 'assistant', content: aliReplyContent(reply),
    } }] });
  });
  const lines: string[] = [];
  expect(await runOpenRouterVerify({ ...env, MIRSAD_OPENROUTER_MODEL: model }, send, line => lines.push(line))).toBe(0);
  expect(lines).toEqual(['PASS english', 'PASS emirati_arabic', 'PASS seller_memory']);
});

it.each(['You did.', 'The offer came from you.', 'You were the one who offered the chair.'])(
  'checks both languages and an earlier Arabic offer through Gemini (%s)', async answer => {
  const fetchModel = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(completion('My name is Ali. I keep those details private.'))
    .mockResolvedValueOnce(completion('اسمي علي، وباقي التفاصيل خاصة.'))
    .mockResolvedValueOnce(completion(answer));
  const lines: string[] = [];
  expect(await runGeminiVerify(env, fetchModel, line => lines.push(line))).toBe(0);
  expect(lines).toEqual(['PASS english', 'PASS emirati_arabic', 'PASS seller_memory']);
  expect(fetchModel).toHaveBeenCalledTimes(3);
  for (const [url, init] of fetchModel.mock.calls) {
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.stringify(init)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  }
  const request = JSON.parse(String(fetchModel.mock.calls[2]![1]?.body));
  expect(request.response_format).toEqual(ALI_RESPONSE_FORMAT);
  expect(request.messages[0].role).toBe('system');
  expect(request.messages[0].content).not.toContain('عندي كرسي خشبي للبيع');
  expect(request.messages.some((m: { role: string; content: string }) =>
    m.role === 'user' && m.content.includes('عندي كرسي خشبي للبيع'))).toBe(true);
  expect(request.messages.at(-1).content).toContain('Which of us offered the chair earlier?');
});

it('identifies rejected credentials without printing provider diagnostics or the key', async () => {
  const fetchModel = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    error: { message: `provider debug material ${syntheticKey}` },
  }, { status: 403 }));
  const lines: string[] = [];
  expect(await runGeminiVerify(env, fetchModel, line => lines.push(line))).toBe(1);
  expect(lines.join(' ')).toMatch(/FAIL english gemini_auth_error/);
  expect(lines.join(' ')).not.toContain(syntheticKey);
  expect(lines.join(' ')).not.toContain('provider debug material');
  expect(fetchModel).toHaveBeenCalledTimes(1);
});

it('fails verification when the second response has the wrong language', async () => {
  const wrong = 'My name is Ali. I keep those details private.';
  const fetchModel = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(wrong)).mockResolvedValueOnce(completion(wrong));
  const lines: string[] = [];
  expect(await runGeminiVerify(env, fetchModel, line => lines.push(line))).toBe(1);
  expect(lines[0]).toBe('PASS english');
  expect(lines[1]).toMatch(/^FAIL emirati_arabic /);
  expect(lines.join(' ')).not.toContain(wrong);
});

it('distinguishes insufficient OpenRouter credits from a wrong key', async () => {
  const fetchModel = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    error: { code: 402, message: 'payment required for this request' },
  }, { status: 402 }));
  const lines: string[] = [];
  expect(await runGeminiVerify(env, fetchModel, line => lines.push(line))).toBe(1);
  expect(lines).toEqual(['FAIL english gemini_insufficient_credits']);
});

it.each(['I offered it to you.', "You didn't offer it. I did.", 'I am not sure.'])('fails ambiguous or reversed seller memory (%s)', async reply => {
  const fetchModel = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(completion('My name is Ali. I keep those details private.'))
    .mockResolvedValueOnce(completion('اسمي علي، وباقي التفاصيل خاصة.'))
    .mockResolvedValueOnce(completion(reply));
  const lines: string[] = [];
  expect(await runGeminiVerify(env, fetchModel, line => lines.push(line))).toBe(1);
  expect(lines.at(-1)).toBe('FAIL seller_memory unexpected_reply');
});
