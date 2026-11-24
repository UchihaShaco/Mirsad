import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ file: '' }));

// Run the real file loader against an isolated editable file.
vi.mock('node:fs', async importOriginal => {
  const native = await importOriginal<typeof import('node:fs')>();
  return {
    ...native,
    readFileSync: (file: Parameters<typeof fs.readFileSync>[0], encoding?: BufferEncoding) => {
      const target = file instanceof URL && file.pathname.endsWith('/prompts/ali.md') ? fixture.file : file;
      return encoding === undefined ? native.readFileSync(target) : native.readFileSync(target, encoding);
    },
  };
});

const earlier = '---\nminimum_distinct_indicators: 2\n---\nOld fixture instructions.\n';
const later = '---\r\nminimum_distinct_indicators: 4\r\n---\r\nNew fixture instructions.\r\n';
const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const twoReasons = JSON.stringify({
  case_status: 'READY_FOR_OFFICER_REVIEW', should_reply: false, external_reply: null, silence_reason: null,
  review_reasons: ['upfront_fee', 'payment_pressure'],
});

beforeAll(() => {
  const temporaryRoot = path.resolve('test-results');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  fixture.file = path.join(fs.mkdtempSync(path.join(temporaryRoot, 'prompt-reload-')), 'ali.md');
});
beforeEach(() => { vi.resetModules(); fs.writeFileSync(fixture.file, earlier); });
afterAll(() => fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true }));

it('reloads both instructions and decision threshold, keeping the last valid version on failure', async () => {
  const prompts = await import('../../src/replies/ali-prompt.ts');
  const replies = await import('../../src/replies/reply-generator.ts');
  const { parseAliDecision } = await import('../../src/replies/ali-decision.ts');
  expect(prompts.reloadAliPrompt()).toEqual({ version: version(earlier), changed: false });
  fs.writeFileSync(fixture.file, later);
  expect(prompts.reloadAliPrompt()).toEqual({ version: version(later), changed: true });
  expect(prompts.reloadAliPrompt()).toEqual({ version: version(later), changed: false });
  expect(replies.REPLY_SYSTEM_PROMPT).toBe(later);
  expect(replies.buildReplyMessages([])[0]?.content).toBe(later);
  expect(() => parseAliDecision(twoReasons)).toThrow();
  fs.writeFileSync(fixture.file, 'Do not echo this private invalid draft.');
  expect(() => prompts.reloadAliPrompt()).toThrow(prompts.AliPromptReloadError);
  fs.unlinkSync(fixture.file);
  expect(() => prompts.reloadAliPrompt()).toThrow(prompts.AliPromptReloadError);
  expect(prompts.ALI_PROMPT).toBe(later);
  expect(prompts.MINIMUM_DISTINCT_INDICATORS).toBe(4);
  expect(replies.buildReplyMessages([])[0]?.content).toBe(later);
});

it.each(['openrouter', 'lmstudio'] as const)('pins an in-flight %s draft and uses the new prompt for the next draft', async provider => {
  const prompts = await import('../../src/replies/ali-prompt.ts');
  const { createLmStudioReplyGenerator } = await import('../../src/replies/reply-generator.ts');
  const { createOpenRouterReplyGenerator, GEMINI_REPLY_MODEL } = await import('../../src/replies/openrouter-reply-generator.ts');
  const requests: string[] = [];
  const send: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body.messages[0].content);
    if (requests.length === 1) {
      fs.writeFileSync(fixture.file, later);
      prompts.reloadAliPrompt();
    }
    return Response.json({ model: GEMINI_REPLY_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: twoReasons } }] });
  };
  const generator = provider === 'openrouter'
    ? createOpenRouterReplyGenerator({ apiKey: 'synthetic', timeoutMs: 3_000, fetch: send })
    : createLmStudioReplyGenerator({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'sample', timeoutMs: 3_000, fetch: send });
  const prior = prompts.currentAliPrompt();
  const signal = new AbortController().signal;
  const context = { dispatchBrief: 'synthetic lead' };
  const decide = (snapshot?: typeof prior) => generator.decide!([], signal, undefined, undefined, undefined, context, snapshot);
  await expect(decide()).resolves.toMatchObject({ kind: 'review' });
  await expect(decide(prior)).resolves.toMatchObject({ kind: 'review' });
  await expect(decide()).rejects.toMatchObject({ code: 'invalid_response' });
  expect(requests[0]).toContain(earlier.trimEnd());
  expect(requests[1]).toBe(requests[0]);
  expect(requests[2]).toContain(later.trimEnd());
  expect(requests[2]).toContain('unverified lead');
});
