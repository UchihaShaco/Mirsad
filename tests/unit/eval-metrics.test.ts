/**
 * Scoring of evaluation runs: reviewer items go through validateItem like in the pipeline, expected and extracted
 * values are compared after the pipeline's normalization, and the report holds only counts, IDs and timings.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedItem } from '../../src/ports/reviewer.ts';
import { scoreTranscripts, type ReviewedMessage, type TranscriptResult } from '../../src/review/eval/metrics.ts';
import type { Transcript } from '../../src/review/eval/transcript-schema.ts';

const reviewedId = (transcriptId: string, messageId: string) => `msg_${transcriptId}_${messageId}`;

function item(transcriptId: string, messageId: string, fields: Omit<ExtractedItem, 'sourceMessageId' | 'countryHint'> & { countryHint?: string | null }): ExtractedItem {
  return { sourceMessageId: reviewedId(transcriptId, messageId), countryHint: null, ...fields };
}

function reviewed(transcriptId: string, messageId: string, answer: ReviewedMessage['answer'], latencyMs = 100): ReviewedMessage {
  return { messageId, reviewedMessageId: reviewedId(transcriptId, messageId), answer, latencyMs };
}

const PAY = 'Please pay at https://pay.shop.test/inv/1. Or call +44 7700 900123 to confirm.';
const SETTLE = 'Settle at https://settle.shop.test/x today.';
const TRANSFER = 'حوّل المبلغ إلى شركة الاختبار للتجارة اليوم';
const TRACK = 'Track it at https://track.example.org/1 - رقم المكتب القديم 07700 900555';

const english: Transcript = {
  id: 'en-1',
  language: 'en',
  tags: ['payment_link'],
  description: 'English payment request',
  messages: [
    {
      id: 'm1',
      direction: 'incoming',
      text: PAY,
      expected: [
        { kind: 'payment_link', value: 'https://pay.shop.test/inv/1', concern: null },
        { kind: 'phone_number', value: '+44 7700 900123', concern: 'callback_request' },
      ],
    },
    { id: 'm2', direction: 'outgoing', text: 'OK, thanks.', expected: [] },
    { id: 'm3', direction: 'incoming', text: SETTLE, expected: [{ kind: 'payment_link', value: 'https://settle.shop.test/x', concern: null }] },
  ],
};
const arabic: Transcript = {
  id: 'ar-1',
  language: 'ar',
  tags: ['payment_recipient'],
  description: 'Arabic transfer request',
  messages: [{ id: 'm1', direction: 'incoming', text: TRANSFER, expected: [{ kind: 'payment_recipient', value: 'شركة الاختبار للتجارة', concern: null }] }],
};
const mixed: Transcript = {
  id: 'mx-1',
  language: 'mixed',
  tags: ['routine_only'],
  description: 'Mixed tracking message',
  messages: [{ id: 'm1', direction: 'incoming', text: TRACK, expected: [] }],
};

describe('evaluation metrics', () => {
  it('scores exact matches, misses, extras and unsupported findings', () => {
    const results: TranscriptResult[] = [
      {
        transcript: english,
        reviews: [
          reviewed('en-1', 'm1', {
            items: [
              // The same link with and without the sentence's full stop is one finding, as in the pipeline.
              item('en-1', 'm1', { kind: 'payment_link', quote: PAY, extractedValue: 'https://pay.shop.test/inv/1.', concern: null }),
              item('en-1', 'm1', { kind: 'payment_link', quote: PAY, extractedValue: 'https://pay.shop.test/inv/1', concern: null }),
              // Matches after normalization; the concern is a judgement call and does not decide the match.
              item('en-1', 'm1', { kind: 'phone_number', quote: PAY, extractedValue: '+447700900123', concern: 'payment_request' }),
            ],
          }),
          reviewed('en-1', 'm3', { errorCode: 'lmstudio_timeout' }),
        ],
      },
      { transcript: arabic, reviews: [reviewed('ar-1', 'm1', { items: [] })] },
      {
        transcript: mixed,
        reviews: [
          reviewed('mx-1', 'm1', {
            items: [
              item('mx-1', 'm1', { kind: 'payment_link', quote: TRACK, extractedValue: 'https://track.example.org/1', concern: null }),
              item('mx-1', 'm1', { kind: 'payment_link', quote: 'Pay at https://other.shop.test/x', extractedValue: 'https://other.shop.test/x', concern: null }),
              { ...item('mx-1', 'm1', { kind: 'payment_link', quote: TRACK, extractedValue: 'https://track.example.org/1', concern: null }), sourceMessageId: 'msg_other' },
              // A phone number without a concern is dropped, like in the pipeline: neither an extra nor unsupported.
              item('mx-1', 'm1', { kind: 'phone_number', quote: TRACK, extractedValue: '07700 900555', concern: null }),
            ],
          }),
        ],
      },
    ];

    const report = scoreTranscripts(results);

    expect(report.overall).toMatchObject({
      messages: 4,
      unavailable: 1,
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 2,
      precision: 2 / 3,
      recall: 0.5,
      unsupported: 2,
      concernAgreement: { matchedPhones: 1, agreeing: 0 },
    });
    expect(report.byLanguage.en).toMatchObject({ messages: 2, unavailable: 1, truePositives: 2, falsePositives: 0, falseNegatives: 1, precision: 1, recall: 2 / 3, unsupported: 0 });
    expect(report.byLanguage.ar).toMatchObject({ messages: 1, unavailable: 0, truePositives: 0, falsePositives: 0, falseNegatives: 1, precision: null, recall: 0 });
    expect(report.byLanguage.mixed).toMatchObject({ messages: 1, truePositives: 0, falsePositives: 1, falseNegatives: 0, precision: 0, recall: null, unsupported: 2 });
    const noPhones = { matchedPhones: 0, agreeing: 0 };
    expect(report.messages).toEqual([
      { transcriptId: 'en-1', messageId: 'm1', language: 'en', expected: 2, truePositives: 2, falsePositives: 0, falseNegatives: 0, unsupported: 0, missedKinds: [], extraKinds: [], concernAgreement: { matchedPhones: 1, agreeing: 0 }, latencyMs: 100, errorCode: null },
      { transcriptId: 'en-1', messageId: 'm3', language: 'en', expected: 1, truePositives: 0, falsePositives: 0, falseNegatives: 1, unsupported: 0, missedKinds: ['payment_link'], extraKinds: [], concernAgreement: noPhones, latencyMs: 100, errorCode: 'lmstudio_timeout' },
      { transcriptId: 'ar-1', messageId: 'm1', language: 'ar', expected: 1, truePositives: 0, falsePositives: 0, falseNegatives: 1, unsupported: 0, missedKinds: ['payment_recipient'], extraKinds: [], concernAgreement: noPhones, latencyMs: 100, errorCode: null },
      { transcriptId: 'mx-1', messageId: 'm1', language: 'mixed', expected: 0, truePositives: 0, falsePositives: 1, falseNegatives: 0, unsupported: 2, missedKinds: [], extraKinds: ['payment_link'], concernAgreement: noPhones, latencyMs: 100, errorCode: null },
    ]);

    // Counts, IDs and timings only: no message text and no extracted value.
    const serialized = JSON.stringify(report);
    for (const fragment of ['shop.test', 'track.example', '7700', 'الاختبار', 'Please pay']) expect(serialized).not.toContain(fragment);
  });

  it('aggregates latency', () => {
    const timed = (id: string, language: Transcript['language'], latencies: number[]): TranscriptResult => ({
      transcript: {
        id,
        language,
        tags: [],
        description: 'Timing only',
        messages: latencies.map((_, i) => ({ id: `m${i}`, direction: 'incoming' as const, text: 'Hello.', expected: [] })),
      },
      // Every review call counts, a failed one too: the officer waits for it all the same.
      reviews: latencies.map((latencyMs, i) => reviewed(id, `m${i}`, i === 0 ? { errorCode: 'lmstudio_http_error' } : { items: [] }, latencyMs)),
    });

    const report = scoreTranscripts([
      timed('en-1', 'en', [400, 100, 300, 200]),
      timed('ar-1', 'ar', [50]),
      timed('mx-1', 'mixed', Array.from({ length: 20 }, (_, i) => 20 - i)),
    ]);

    expect(report.byLanguage.en.latency).toEqual({ count: 4, minMs: 100, medianMs: 250, p95Ms: 400, maxMs: 400 });
    expect(report.byLanguage.ar.latency).toEqual({ count: 1, minMs: 50, medianMs: 50, p95Ms: 50, maxMs: 50 });
    expect(report.byLanguage.mixed.latency).toEqual({ count: 20, minMs: 1, medianMs: 10.5, p95Ms: 19, maxMs: 20 });
    expect(report.overall.latency).toEqual({ count: 25, minMs: 1, medianMs: 13, p95Ms: 300, maxMs: 400 });
    expect(report.overall.unavailable).toBe(3);

    const englishOnly = scoreTranscripts([timed('en-2', 'en', [120])]);
    expect(englishOnly.byLanguage.ar.latency).toEqual({ count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null });
    expect(englishOnly.byLanguage.ar).toMatchObject({ messages: 0, precision: null, recall: null });
  });
});
