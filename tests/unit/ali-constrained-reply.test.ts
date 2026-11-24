import { describe, expect, it } from 'vitest';
import { ALI_RESPONSE_FORMAT } from '../../src/replies/ali-decision.ts';
import { buildReplyMessages, createLmStudioReplyGenerator, type ReplyTurn } from '../../src/replies/reply-generator.ts';

const model = 'arabic-fixture-model';
const history: ReplyTurn[] = [
  { from: 'contact', text: 'I have a lamp for sale.' },
  { from: 'owner', text: 'How large is it?' },
  { from: 'contact', text: 'طرش لي صورة المصباح اللي عندك.' },
];
const signal = new AbortController().signal;

function localModel(content: string) {
  return createLmStudioReplyGenerator({
    baseUrl: 'http://127.0.0.1:1234/v1', model, timeoutMs: 2000, requireModelMatch: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.response_format).toEqual(ALI_RESPONSE_FORMAT);
      expect(body.messages).toEqual(buildReplyMessages(history));
      return Response.json({ model, choices: [{ finish_reason: 'stop', message: { content } }] });
    },
  });
}

describe('local structured reply decisions', () => {
  it('returns the model’s public text and keeps speaker attribution through a language switch', async () => {
    const text = 'ما عندي شي للبيع، أنا أسأل عن المصباح اللي عندك.';
    const generator = localModel(JSON.stringify({ case_status: 'MONITORING', should_reply: true, external_reply: text, review_reasons: [], silence_reason: null }));
    expect(await generator.decide!(history, signal)).toEqual({ kind: 'reply', text });
    expect(await generator.generate(history, signal)).toBe(text);
  });

  it('returns review codes internally and no text to a legacy caller', async () => {
    const generator = localModel(JSON.stringify({
      case_status: 'HUMAN_INTERVENTION_REQUIRED', should_reply: false, external_reply: null, review_reasons: ['sensitive_request'], silence_reason: null,
    }));
    expect(await generator.decide!(history, signal)).toEqual({ kind: 'review', status: 'HUMAN_INTERVENTION_REQUIRED', reasons: ['sensitive_request'] });
    expect(await generator.generate(history, signal)).toBeNull();
  });

  it.each(['Okay.', '{"reply":"Okay."}', '{"case_status":"MONITORING"}', '<think>notes</think>{}', '{} private body'])(
    'rejects malformed output even if the provider ignores the schema (%#)', async content => {
      await expect(localModel(content).generate(history, signal)).rejects.toMatchObject({ code: 'invalid_response' });
    },
  );

  it('keeps intentional silence distinct from a request for officer review', async () => {
    const generator = localModel(JSON.stringify({
      case_status: 'INSUFFICIENT_FRAUD_INDICATORS', should_reply: false, external_reply: null, review_reasons: [], silence_reason: 'ordinary_terms_clear',
    }));
    expect(await generator.decide!(history, signal)).toEqual({ kind: 'silence', reason: 'ordinary_terms_clear' });
    expect(await generator.generate(history, signal)).toBeNull();
  });
});
