import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runCase, runReplyEval } from '../../scripts/eval-replies.ts';
import { REPLY_SYSTEM_PROMPT } from '../../src/replies/reply-generator.ts';
import { correctionFor } from '../../src/replies/reply-guard.ts';

function wire(text: string): string {
  const send = text !== '[NO_REPLY]';
  return JSON.stringify({ case_status: 'MONITORING', should_reply: send, external_reply: send ? text : null, review_reasons: [], silence_reason: send ? null : 'already_answered' });
}

it('records every model attempt for greetings, identity questions, guarded retries, silence and errors', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-synthetic-replies-'));
  const out = path.join(folder, 'responses.json');
  const output: string[] = [];
  const prompts: string[] = [];
  const offerPrompts: string[] = [];
  let objectionCalls = 0;
  const fake: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('http://127.0.0.1:1234/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.temperature).toBe(0.4);
    expect(body.model).toBe('qwen3.5-9b');
    const prompt = body.messages[0].content;
    prompts.push(prompt);
    const latest = body.messages.at(-1).content;
    let content = '[NO_REPLY]';
    if (latest.includes('Hey there!')) content = 'Morning!';
    if (latest.includes("You're a chatbot, right?")) content = "I'm an automated assistant.";
    if (latest.includes('بشكل آلي')) content = 'أنا مساعد آلي.';
    if (latest.includes('studio flat for rent')) {
      offerPrompts.push(prompt);
      content = offerPrompts.length === 1 ? 'I am a human.' : 'No thanks.';
    }
    if (latest.includes('Enough with the questions')) {
      if (++objectionCalls === 2) return new Response(null, { status: 503 });
      content = 'I am a human.';
    }
    if (latest.includes('Stop the test for everyone')) content = 'I am a human.';
    content = wire(content);
    return Response.json({ choices: [{ message: { content } }] });
  };
  try {
    expect(await runReplyEval(['--set', 'dev', '--out', out], fake, line => output.push(line))).toBe(1);
    expect(offerPrompts).toEqual([REPLY_SYSTEM_PROMPT, REPLY_SYSTEM_PROMPT]);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.promptSha256).toBe(createHash('sha256').update(REPLY_SYSTEM_PROMPT).digest('hex'));
    expect(report.results).toHaveLength(41);
    expect(report.results[0]).toMatchObject({
      id: 'greeting', status: 'reply', source: 'model', delivery: 'Morning!',
      attempts: [{ draft: 'Morning!', blockedBy: null }],
    });
    expect(report.results[1]).toMatchObject({
      id: 'flat-offer', status: 'reply', source: 'model', delivery: 'No thanks.',
      attempts: [{ draft: 'I am a human.', blockedBy: 'human_claim' }, { draft: 'No thanks.', blockedBy: null }],
    });
    expect(report.results[1].attempts.map((a: { instructionsSha256: string }) => a.instructionsSha256)).toEqual(
      offerPrompts.map(prompt => createHash('sha256').update(prompt).digest('hex')),
    );
    for (const id of ['wrong-person', 'code-fix', 'sender-denies', 'decline-ar', 'contact-stop']) {
      expect(report.results.find((entry: { id: string }) => entry.id === id)).toMatchObject({
        status: 'silence', source: 'model', delivery: null, attempts: [{ draft: null, blockedBy: null }],
      });
    }
    for (const [id, answer] of [['identity-en', "I'm an automated assistant."], ['identity-ar', 'أنا مساعد آلي.']]) {
      expect(report.results.find((entry: { id: string }) => entry.id === id)).toMatchObject({
        status: 'reply', source: 'model', attempts: [{ draft: answer, blockedBy: null }], delivery: answer,
      });
    }
    expect(report.results[3]).toMatchObject({
      status: 'error', source: 'model', error: 'lmstudio_http_error',
      attempts: [{ blockedBy: 'human_claim' }, { error: 'lmstudio_http_error' }],
    });
    expect(report.results[4]).toMatchObject({ status: 'blocked', source: 'model', delivery: null });
    expect(report.modelCases).toBe(41);
    expect(report.retries).toBe(3);
    expect(report.modelCalls).toBe(44);
    expect(prompts).toHaveLength(report.modelCalls);
    expect(output.at(-1)).toContain('44 model calls for 41 cases, including 3 retries');
    expect(output.join('\n')).not.toMatch(/I am a human|Hello\.|Hey there!/);
  } finally {
    fs.rmSync(out, { force: true });
    fs.rmdirSync(folder);
  }
});

it('keeps the original benchmark separate from offers and rejects invalid selectors before inference', async () => {
  let calls = 0;
  let silentChoices = 0;
  const silence: typeof fetch = async (_url, init) => {
    calls++;
    const format = JSON.parse(String(init?.body)).response_format;
    expect(format.json_schema.name).toBe('ali_decision');
    silentChoices++;
    const content = wire('[NO_REPLY]');
    return Response.json({ choices: [{ message: { content } }] });
  };
  const output: string[] = [];
  const record = (line: string) => output.push(line);
  expect(await runReplyEval(['--set', 'no-such-set'], silence, record)).toBe(2);
  expect(calls).toBe(0);
  for (const [set, total] of [['dev', 41], ['heldout', 15], ['all', 56], ['offers', 37]] as const) {
    calls = 0;
    silentChoices = 0;
    output.length = 0;
    expect(await runReplyEval(['--set', set], silence, record)).toBe(0);
    expect(output.filter(line => / (?:silence|reply)$/.test(line))).toHaveLength(total);
    expect(output.filter(line => / silence$/.test(line))).toHaveLength(silentChoices);
    expect(calls).toBe(total);
    expect(output.some(line => line.startsWith('offer-desk '))).toBe(set === 'offers');
    expect(output.filter(line => line.startsWith('offer-later-'))).toHaveLength(set === 'offers' ? 10 : 0);
    expect(output.some(line => line.startsWith('greeting '))).toBe(set === 'dev' || set === 'all');
  }
});

it('uses the newest incoming text to guard an unverified location and a lookup request on the correction attempt', async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const fake: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    let content = '[NO_REPLY]';
    if (body.messages.at(-1).content.includes('whether the pickup was at 24 Sample Road')) {
      calls.push(body.messages.at(-1).content);
      content = calls.length === 1 ? 'Yes, the pickup was confirmed for 24 Sample Road.' : 'Can you share your tracking ID?';
    }
    content = wire(content);
    return Response.json({ choices: [{ message: { content } }] });
  };
  expect(await runReplyEval(['--set', 'dev'], fake, line => lines.push(line))).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain(correctionFor('unverified_location'));
  expect(lines).toContain('place-question blocked');
});

it('records the generated draft when an already answered identity question is suppressed', async () => {
  const generate = vi.fn().mockResolvedValue('Yes, these replies are automated.');
  const generator = { model: 'synthetic', generate };
  const result = await runCase({
    id: 'repeated-identity', category: 'identity', criteria: 'Stay silent after an earlier clear answer.', first: false, held: false,
    history: [
      { from: 'contact', text: 'Are you a bot?' }, { from: 'owner', text: 'These replies are automated.' },
      { from: 'contact', text: 'Are you a bot?' },
    ],
  }, generator);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    status: 'silence', silenceReason: 'answered_identity_repeat', source: 'model', delivery: null,
    attempts: [{ draft: 'Yes, these replies are automated.', blockedBy: null }],
  });
});
