import { expect, it, vi } from 'vitest';
import { runAssessmentPreview } from '../../scripts/preview-assessment.ts';
import { ALI_PROMPT } from '../../src/replies/ali-prompt.ts';
import { ALI_RESPONSE_FORMAT } from '../../src/replies/ali-decision.ts';

const model = 'google/gemini-3.8-flash';
const key = 'synthetic-test-credential';
const closed = { case_status: 'INSUFFICIENT_FRAUD_INDICATORS', should_reply: false, external_reply: null, review_reasons: [], silence_reason: 'sender_withdrew' };
const opened = { case_status: 'MONITORING', should_reply: true, external_reply: 'Hi there!', review_reasons: [], silence_reason: null };
const review = { ...closed, case_status: 'READY_FOR_OFFICER_REVIEW', review_reasons: ['upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request'], silence_reason: null };
function completion(content: string, id = model, finish = 'stop'): Response {
  return Response.json({ model: id, choices: [{ finish_reason: finish, message: { role: 'assistant', content } }] });
}

it('sends the live Ali prompt and only the fixed probes to the selected Gemini route', async () => {
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(completion(JSON.stringify(opened), model + '-20260902'))
    .mockResolvedValueOnce(completion(JSON.stringify(closed)))
    .mockResolvedValueOnce(completion(JSON.stringify(review)));
  const lines: string[] = [];
  expect(await runAssessmentPreview(key, send, line => lines.push(line))).toBe(0);
  expect(lines).toEqual(['PASS greeting REPLY', 'PASS opt_out SILENCE', 'PASS officer_review READY_FOR_OFFICER_REVIEW']);
  for (const [i, [url, init]] of send.mock.calls.entries()) {
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + key);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(model);
    expect(body.provider.only).toEqual(['google-ai-studio', 'google-vertex/global']);
    expect(body.messages).toEqual([
      { role: 'system', content: ALI_PROMPT },
      { role: 'user', content: ['Hello!', 'Please stop messaging me.', expect.stringContaining('pay me an upfront fee')][i] },
    ]);
    expect(body.response_format).toEqual(ALI_RESPONSE_FORMAT);
    expect(body).not.toHaveProperty('tools');
    expect(init?.body).not.toContain(key);
  }
});

it.each([
  ['bad_json', () => completion('private malformed content')],
  ['bad_type', () => completion('[]')],
  ['bad_status', () => completion(JSON.stringify({ ...opened, case_status: 'ANY' }))],
  ['bad_bool', () => completion(JSON.stringify({ ...opened, should_reply: 'yes' }))],
  ['inconsistent_reply', () => completion(JSON.stringify({ ...closed, external_reply: 'private content' }))],
  ['blank_reply', () => completion(JSON.stringify({ ...opened, external_reply: '  ' }))],
  ['terminal_reply', () => completion(JSON.stringify({ ...opened, case_status: 'HUMAN_INTERVENTION_REQUIRED' }))],
  ['wrong_model', () => completion(JSON.stringify(opened), model + '-lite')],
  ['truncation', () => completion(JSON.stringify(opened), model, 'length')],
  ['provider_error', () => Response.json({ error: 'private content' }, { status: 401 })],
])('fails closed with codes only for %s', async (_reason, respond) => {
  const lines: string[] = [];
  const send = vi.fn<typeof fetch>(async () => respond());
  expect(await runAssessmentPreview(key, send, line => lines.push(line))).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^FAIL greeting [A-Z_0-9]+$/u);
});

it('requires silence on the opt-out', async () => {
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(completion(JSON.stringify(opened)))
    .mockResolvedValueOnce(completion(JSON.stringify(opened)));
  const lines: string[] = [];
  expect(await runAssessmentPreview(key, send, line => lines.push(line))).toBe(1);
  expect(lines.at(-1)).toBe('FAIL opt_out UNEXPECTED_DECISION');
});

it('requires a real officer handoff on the unsolicited pressure and advance fee case', async () => {
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(completion(JSON.stringify(opened)))
    .mockResolvedValueOnce(completion(JSON.stringify(closed)))
    .mockResolvedValueOnce(completion(JSON.stringify(closed)));
  const lines: string[] = [];
  expect(await runAssessmentPreview(key, send, line => lines.push(line))).toBe(1);
  expect(lines.at(-1)).toBe('FAIL officer_review UNEXPECTED_DECISION');
});

it('fails without contacting OpenRouter when the key is blank', async () => {
  const send = vi.fn<typeof fetch>();
  const lines: string[] = [];
  expect(await runAssessmentPreview(' ', send, line => lines.push(line))).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(lines).toEqual(['FAIL setup KEY_MISSING']);
});
