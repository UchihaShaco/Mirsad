/**
 * Opt-in local-model replies (design section 20), unit level: the configuration, the reply generator against a fake
 * fetch, the one-method Bot API sender, and the setup checks for the reply right and the consent reference. All IDs,
 * texts and tokens are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { BotApiError, createBotSender, type BotApi, type BusinessConnection } from '../../src/adapters/telegram/bot-api.ts';
import { verifyConnection } from '../../src/adapters/telegram/verify.ts';
import { loadConfig } from '../../src/config.ts';
import {
  buildReplyMessages,
  cleanReply,
  createLmStudioReplyGenerator,
  DEFAULT_CONTEXT_TOKENS,
  historyCharsFor,
  isArabicReplyTurn,
  MAX_REPLY_CHARS,
  REPLY_SYSTEM_PROMPT,
  ReplyGenerationError,
  type ReplyTurn,
} from '../../src/replies/reply-generator.ts';
import { blockedRule, blockedRuleForTurn, correctionFor, REPLY_GUARD_RULES, type ReplyGuardRule } from '../../src/replies/reply-guard.ts';
import type { MessageRow } from '../../src/storage/rows.ts';
import { isAnswerable, REPLY_FRESHNESS_MS } from '../../src/workers/ai-reply-worker.ts';

const BOT_TOKEN = '5000000999:TEST_token_not_real_0123456789abcd';
const OWNER_ID = 5000000001;
const CONNECTION_ID = 'TestBizConn-0101';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const completion = (content: string | null): Response =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 });

function publicDecision(text: string | null): string {
  return JSON.stringify({ case_status: 'MONITORING', should_reply: text !== null, external_reply: text, review_reasons: [], silence_reason: text === null ? 'already_answered' : null });
}

const generatorWith = (fetchFn: typeof fetch, timeoutMs = 5_000) =>
  createLmStudioReplyGenerator({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen3.5-9b', timeoutMs, fetch: fetchFn });

const HISTORY: ReplyTurn[] = [
  { from: 'contact', text: 'Hello, is the service available this week?' },
  { from: 'owner', text: 'Thanks, noted.' },
  { from: 'contact', text: 'Great.' },
  { from: 'contact', text: 'Can I book Friday?' },
];

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReplyGenerationError) return error.code;
    throw error;
  }
  throw new Error('expected a ReplyGenerationError');
}

describe('AI reply configuration', () => {
  it('is off by default and reads the switch and the consent reference', () => {
    expect(loadConfig({}).telegram.aiReplies).toEqual({ enabled: false, consentReference: null, autoStart: false });
    const config = loadConfig({ TELEGRAM_AI_REPLIES_ENABLED: 'true', TELEGRAM_AI_REPLY_CONSENT_REFERENCE: ' TEST-CONSENT-01 ' });
    expect(config.telegram.aiReplies).toEqual({ enabled: true, consentReference: 'TEST-CONSENT-01', autoStart: false });
    expect(() => loadConfig({ TELEGRAM_AI_REPLIES_ENABLED: 'yes' })).toThrow('TELEGRAM_AI_REPLIES_ENABLED');
  });
});

describe('reply history and language', () => {
  it.each([
    ['هلا والله', true], ['Could you reply in Arabic?', true],
    ['لو سمحت رد بالإنجليزي', false], ['What does “مرحبا” mean?', false],
    ['Pixel شو سعره؟', true], ['Hello there', false],
  ] as const)('classifies the current language for optional local routing (%s)', (text, arabic) => {
    expect(isArabicReplyTurn([{ from: 'contact', text }])).toBe(arabic);
  });

  it('retains the earlier contact language on neutral turns', () => {
    const history: ReplyTurn[] = [{ from: 'contact', text: 'وين العرض؟' }, { from: 'owner', text: 'أي عرض؟' }, { from: 'contact', text: '12' }];
    expect(isArabicReplyTurn(history)).toBe(true);
  });

  it('keeps the active burst separate when an older turn ended in silence', () => {
    const history: ReplyTurn[] = [{ from: 'contact', text: 'Hi!' }, { from: 'contact', text: 'Are you there?' }];
    const messages = buildReplyMessages(history, undefined, undefined, undefined, undefined, ['Are you there?']);
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'Hi!' }, { role: 'assistant', content: '[NO_REPLY]' }, { role: 'user', content: 'Are you there?' },
    ]);
    expect(history).toHaveLength(2);
  });

  it('removes old introductions and masks the project name in model input while preserving the source messages', () => {
    const history: ReplyTurn[] = [
      { from: 'contact', text: 'You mentioned Mirsad.' },
      { from: 'owner', text: 'I’m Mirsad’s automated assistant. Which fee?' },
      { from: 'owner', text: 'My product is Misrad.' },
      { from: 'contact', text: 'أنت قلت مرصاد' },
      { from: 'owner', text: 'أنا مساعد مرصاد الآلي. أي مبلغ؟' },
      { from: 'owner', text: 'أهلا! أنا مساعد ميرساد.' },
      { from: 'contact', text: 'What did I say?' },
    ];
    const original = structuredClone(history);
    expect(buildReplyMessages(history).slice(1)).toEqual([
      { role: 'user', content: 'You mentioned [name].' },
      { role: 'assistant', content: 'Which fee?' },
      { role: 'user', content: 'أنت قلت [name]' },
      { role: 'assistant', content: 'أي مبلغ؟' },
      { role: 'user', content: 'What did I say?' },
    ]);
    expect(history).toEqual(original);
    const enrollment = 'I agree to receive automated replies from Mirsad.';
    const request = buildReplyMessages([{ from: 'contact', text: enrollment }, { from: 'contact', text: 'What was the fee?' }]);
    expect(JSON.stringify(request.slice(1))).not.toMatch(/mirsad/iu);
    expect(request.at(-1)?.content).toContain('What was the fee?');
  });

  it('delivers only the public text from the structured decision', async () => {
    const fake = fakeFetch(() => completion(publicDecision('Which field was rejected?')));
    const generator = generatorWith(fake.fetch);
    expect(await generator.generate([{ from: 'contact', text: 'My form was rejected.' }], new AbortController().signal)).toBe('Which field was rejected?');
    expect(JSON.parse(String(fake.calls[0]?.init.body)).messages[0].content).toBe(REPLY_SYSTEM_PROMPT);
  });

  it('drops empty turns and the oldest turns once the history is too long', () => {
    const long = 'x'.repeat(1_400);
    const history: ReplyTurn[] = [
      ...Array.from({ length: 8 }, (_, i): ReplyTurn => ({ from: i % 2 === 0 ? 'contact' : 'owner', text: `${i} ${long}` })),
      { from: 'owner', text: '   ' },
      { from: 'contact', text: 'latest question' },
    ];
    const messages = buildReplyMessages(history);
    const kept = messages.slice(1).map((m) => m.content).join('\n');
    expect(kept.endsWith('latest question')).toBe(true);
    expect(kept).not.toContain('0 xxx');
    expect(kept.length).toBeLessThanOrEqual(historyCharsFor(DEFAULT_CONTEXT_TOKENS, REPLY_SYSTEM_PROMPT) + 8);
  });

  it('sizes the history to the loaded context, within fixed bounds, and always sends the latest turn', () => {
    const prompt = 'p'.repeat(1_500); // about 500 tokens by the estimate
    expect(historyCharsFor(4_096, prompt)).toBe((4_096 - 500 - 300 - 200) * 2);
    expect(historyCharsFor(16_384, prompt)).toBe(8_000);
    expect(historyCharsFor(512, prompt)).toBe(500);
    const tight = buildReplyMessages([{ from: 'contact', text: 'an older question' }, { from: 'contact', text: 'y'.repeat(900) }], prompt, 500);
    expect(tight.slice(1)).toHaveLength(1);
    expect(tight[1]?.content).toHaveLength(500);
    expect(tight[1]?.content).toContain('[text omitted]');
  });

  it('keeps a late correction in the newest incoming message and caps earlier messages at 1,500 characters', () => {
    const older = 'x'.repeat(2_000);
    const latest = 'The old notice says Tuesday. ' + 'The chairs are ready. '.repeat(95)
      + 'Correction: the rehearsal is Saturday. Which day did I say?';
    const request = buildReplyMessages([
      { from: 'contact', text: older }, { from: 'owner', text: 'Noted.' }, { from: 'contact', text: latest },
    ], undefined, 8_000);
    expect(request.slice(1).map(message => message.content)).toEqual([older.slice(0, 1_500), 'Noted.', latest]);
  });

  it.each(['decision', 'public_reply'] as const)('retains the sender behind many outgoing follow-ups for %s', output => {
    const question = 'Is the oak shelf wide enough for your room?';
    const history: ReplyTurn[] = [
      { from: 'contact', text: question },
      ...Array.from({ length: 18 }, (_, i): ReplyTurn => ({ from: 'owner', text: `Follow-up ${i}. ${'x'.repeat(600)}` })),
    ];
    const messages = buildReplyMessages(history, 'Synthetic buyer prompt.', 500, undefined, DEFAULT_CONTEXT_TOKENS,
      [], undefined, { dispatchIntent: 'follow_up' }, output);
    const sender = messages.findIndex(message => message.role === 'user' && message.content.includes(question));
    expect(sender).toBeGreaterThan(0);
    expect(messages.slice(sender + 1).some(message => message.role === 'assistant' && message.content.includes('Follow-up 17.'))).toBe(true);
  });

  it('keeps both ends of a clipped latest message within the smaller of the history budget and 3,000 characters', () => {
    const text = 'Start ' + '🔵'.repeat(880) + 'unneeded middle' + '🔴'.repeat(880) + ' End';
    for (const budget of [500, 2_999, 3_000, 8_000]) {
      const packed = buildReplyMessages([{ from: 'contact', text }], 'Test prompt.', budget).at(-1)!.content;
      expect(packed.length).toBeLessThanOrEqual(Math.min(budget, 3_000));
      expect(packed).toMatch(/^Start .*\[text omitted\].* End$/su);
      expect(packed).not.toContain('unneeded middle');
      expect(packed).not.toMatch(/\p{Surrogate}/u);
    }
  });

  it('respects tiny explicit budgets without splitting emoji or overflowing the omission marker', () => {
    for (const budget of [0, 1, 2, 3, 4, 5]) {
      const rows = buildReplyMessages([{ from: 'contact', text: '😀 some omitted material 😃' }], 'Test prompt.', budget);
      const packed = rows.slice(1).map(row => row.content).join('');
      expect(packed.length).toBeLessThanOrEqual(budget);
      expect(packed).not.toMatch(/\p{Surrogate}/u);
      if (budget > 0) expect(packed).toContain('…');
    }
  });

  it('cleans the answer: thinking removed, quotes trimmed, long replies cut after a sentence', () => {
    expect(cleanReply('<think>plan the reply</think>\n Sure, Friday works. ')).toBe('Sure, Friday works.');
    expect(cleanReply('Hello!<think>unfinished')).toBe('Hello!');
    expect(cleanReply('"Thanks, the owner will confirm."')).toBe('Thanks, the owner will confirm.');
    const long = `${'A short sentence. '.repeat(80)}`;
    const cut = cleanReply(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(cut.endsWith('.')).toBe(true);
  });
});

describe('LM Studio reply generator', () => {
  it('keeps an intentional no-reply decision internal', async () => {
    const fake = fakeFetch(() => completion(publicDecision(null)));
    expect(await generatorWith(fake.fetch).generate(HISTORY, new AbortController().signal)).toBeNull();
  });

  it.each([['testing-arabic', 'testing-english'], ['testing-english', 'testing-arabic']])(
    'with strict model selection, accepts only a completion from %s', async (model, otherModel) => {
      for (const returnedModel of [otherModel, undefined, model]) {
        const fetch = fakeFetch(() => Response.json({ model: returnedModel, choices: [{ message: { content: publicDecision('Okay.') } }] }));
        const generator = createLmStudioReplyGenerator({
          baseUrl: 'http://127.0.0.1:1234/v1', model, requireModelMatch: true, timeoutMs: 5_000, fetch: fetch.fetch,
        });
        const output = generator.generate(HISTORY, new AbortController().signal);
        if (returnedModel === model) expect(await output).toBe('Okay.');
        else expect(await codeOf(output)).toBe('invalid_response');
      }
    },
  );

  it.each(['[NO_REPLY] The contact asked to stop.', 'Understood. [no_reply]', ' [No Reply] ', '[NO-REPLY', 'NO_REPLY'])('does not send malformed or mixed internal control text: %s', async (draft) => {
    const fake = fakeFetch(() => completion(draft));
    expect(await codeOf(generatorWith(fake.fetch).generate(HISTORY, new AbortController().signal))).toBe('invalid_response');
  });

  it.each([
    '{"case_status":"MONITORING","external_reply":"Hi."}',
    'Hi.\n```json\n{"assessment":{}',
    'Hello. Here is the response: {"case_sta',
    '"officer_handover_report": {"included":true',
    '"case_status":"MONITORING"',
    'Hello. '.repeat(220) + '{"assessment":{}}',
    '{"reply":"Hello."}',
  ])('rejects complete, partial and embedded JSON on a free-text turn (%#)', async draft => {
    const fake = fakeFetch(() => completion(draft));
    expect(await codeOf(generatorWith(fake.fetch).generate(HISTORY, new AbortController().signal))).toBe('invalid_response');
  });

  it('preserves ordinary quoted speech and ignores structured text in private reasoning', async () => {
    const fake = fakeFetch(() => completion('<think>{"example":true}</think>What does “pickup only” mean?'));
    const plain = createLmStudioReplyGenerator({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'test', systemPrompt: 'Private evaluation fixture.', timeoutMs: 5000, fetch: fake.fetch });
    expect(await plain.generate(HISTORY, new AbortController().signal)).toBe('What does “pickup only” mean?');
  });

  it('posts one chat completion to the loopback URL and returns the cleaned text', async () => {
    const fake = fakeFetch(() => completion(publicDecision('Hi! The owner will confirm Friday.')));
    const reply = await generatorWith(fake.fetch).generate(HISTORY, new AbortController().signal);
    expect(reply).toBe('Hi! The owner will confirm Friday.');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    const body = JSON.parse(String(fake.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'qwen3.5-9b', temperature: 0.4, max_tokens: 300, reasoning_effort: 'none' });
    expect(fake.calls[0]?.init.redirect).toBe('error');
  });

  it('turns every failure into its own code', async () => {
    const signal = new AbortController().signal;
    expect(await codeOf(generatorWith(fakeFetch(() => new Response('busy', { status: 503 })).fetch).generate(HISTORY, signal))).toBe('lmstudio_http_error');
    expect(await codeOf(generatorWith(fakeFetch(() => new Response('not json', { status: 200 })).fetch).generate(HISTORY, signal))).toBe('invalid_response');
    expect(await codeOf(generatorWith(fakeFetch(() => completion('<think>only thinking</think>')).fetch).generate(HISTORY, signal))).toBe('invalid_response');
    expect(await codeOf(generatorWith(fakeFetch(() => completion(null)).fetch).generate(HISTORY, signal))).toBe('invalid_response');
    const refused = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await codeOf(generatorWith(refused.fetch).generate(HISTORY, signal))).toBe('lmstudio_unreachable');
  });

  it('reports a timeout and a caller abort apart', async () => {
    const hang = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect(await codeOf(generatorWith(hang.fetch, 20).generate(HISTORY, new AbortController().signal))).toBe('lmstudio_timeout');
    const caller = new AbortController();
    const pending = generatorWith(hang.fetch, 60_000).generate(HISTORY, caller.signal);
    caller.abort();
    expect(await codeOf(pending)).toBe('reply_aborted');
  });

  it('refuses a base URL that is not on a loopback host', () => {
    expect(() => createLmStudioReplyGenerator({ baseUrl: 'http://example.test/v1', model: 'm', timeoutMs: 1_000 })).toThrow('loopback');
  });
});

describe('reply guard', () => {
  it('allows ordinary replies and honest explanations of who is replying', () => {
    const replies = [
      'Hello!',
      'No thanks.',
      "I'm an automated assistant. I can't call anyone.",
      'I am a language model.',
      "I'm not a human.",
      'أنا مساعد آلي.',
      'أنا روبوت، ولست إنساناً.',
      'An officer can review the evidence.',
      'لا أستطيع فتح الرابط أو التحقق من المستند.',
      'Is it 4,500 AED a month, or 54,000 a year?',
      'So the villa is 4500000 AED, or 1 500 000 for the flat?',
      'Can I see it on 12.05.2026 or 12/05/2026?',
      'Was the fee due on 12 June?',
      'ok.me later then',
      'yes.Co-worker of yours?',
      'مرحبًا، شكرًا للتوضيح.',
      'ما هو منصب الشخص المسؤول عن الشقة؟',
      'Hola, gracias.',
    ];
    for (const reply of replies) expect(blockedRule(reply), reply).toBeNull();
  });

  it('blocks links, long numbers, false identity, invented actions and requests for secrets', () => {
    const cases: [string, ReplyGuardRule][] = [
      ['Sure, pay here: https://example.test/pay', 'link'],
      ['Look at www.example.test', 'link'],
      ['Pay at example.com, then tell me', 'link'],
      ['Write to t.me/someone', 'link'],
      ['Message me on wa.me/971500000000', 'link'],
      ['See bit.ly/abc123', 'link'],
      ['My number is 050 123 4567', 'long_number'],
      ['Call 050–123–4567', 'long_number'],
      ['Landline 04 123 4567', 'long_number'],
      ['Card 4111-1111-1111-1111', 'long_number'],
      ['رقمي ٠٥٠١٢٣٤٥٦٧', 'long_number'],
      ["I'm just an ordinary person chatting here.", 'human_claim'],
      ['I’m not a bot, promise.', 'human_claim'],
      ['I am a real human', 'human_claim'],
      ['انا انسان مثلك', 'human_claim'],
      ['أنا شخص حقيقي، لا تقلق', 'human_claim'],
      ['لست روبوت', 'human_claim'],
      ['I already verified the document.', 'external_action'],
      ["I've opened the link.", 'external_action'],
      ['لقد فتحت الملف.', 'external_action'],
      ['Please send me your verification code.', 'secret_request'],
      ["What's your password?", 'secret_request'],
      ['أرسل لي رمز التحقق.', 'secret_request'],
    ];
    for (const [reply, rule] of cases) expect(blockedRule(reply), reply).toBe(rule);
  });

  it('has an actionable rewrite instruction for every active rule and catches repeated identity replies', () => {
    for (const rule of REPLY_GUARD_RULES) {
      expect(correctionFor(rule)).toBe(rule);
      expect(correctionFor(rule)).not.toMatch(/mirsad|misrad|مرصاد|ميرساد/iu);
    }
    const identity = 'I’m an automated assistant.';
    expect(blockedRule(identity, [identity])).toBe('repeat');
    expect(blockedRule('It’s automated.', ['It’s automated.'])).toBe('repeat');
    expect(blockedRule('Yep!', ['Yep.'], 'Are you AI?')).toBe('repeat');
    expect(blockedRule('Yep!', ['Yep.'], 'Is the form ready?')).toBeNull();
    expect(blockedRule('الرد آلي.', ['الرد آلي!'], 'هل أنت روبوت؟')).toBe('repeat');
    expect(blockedRule('What do you mean?', [], 'AI?')).toBeNull();
    const arabicIdentity = 'أنا مساعد آلي.';
    expect(blockedRule(arabicIdentity, [arabicIdentity])).toBe('repeat');
    expect(blockedRule('Please do not send me your password.', [])).toBeNull();
    expect(blockedRule("Don't share your verification code here.", [])).toBeNull();
    expect(blockedRule('لا ترسل لي رمز التحقق.', [])).toBeNull();
  });

  it('retries a draft containing a fenced code answer even when it starts with a refusal', () => {
    const draft = ["I can't debug that here. For example:", '```js', 'console.log(2 + 2);', '```'].join('\n');
    expect(blockedRule(draft)).toBe('code_block');
    expect(blockedRule('~~~js\nlet n = 1;\n~~~')).toBe('code_block');
    expect(blockedRule('I can’t debug code here.')).toBeNull();
  });

  it('rejects an invented promise to message someone in another chat', () => {
    for (const text of ["Got it—I’ll let them know you’re running late.", "I'll pass your message along.", 'سأوصل رسالتك.', 'راح أبلغهم.']) {
      expect.soft(blockedRule(text), text).toBe('external_action');
    }
    expect(blockedRule("I can't pass your message along.")).toBeNull();
    expect(blockedRule('ما أقدر أوصل رسالتك.')).toBeNull();
  });

  it('blocks invented shopping history in short English and Arabic sales declines', () => {
    expect(blockedRule('No thanks. I’m no longer looking for a chair.')).toBe('shopping_claim');
    expect(blockedRule("I'm not looking for extra jobs right now.")).toBe('shopping_claim');
    expect(blockedRule("I'm not looking to buy anything right now.")).toBe('shopping_claim');
    expect(blockedRule('لا شكراً، لم أعد أبحث عن كرسي.')).toBe('shopping_claim');
    expect(blockedRule('No thanks.')).toBeNull();
    expect(blockedRule('لا، شكراً.')).toBeNull();
  });

  it('retries a long response instead of sending a lecture to a contact', () => {
    expect(blockedRule(Array(65).fill('ordinary').join(' '))).toBe('too_verbose');
    expect(blockedRule('Check with the courier through a channel you already use.')).toBeNull();
  });

  it('rejects invented referrals and assurances about officer review', () => {
    for (const draft of [
      'An officer will review the document.', 'An officer would need to review those records.',
      'Please contact our support team via the official website.', 'تواصل مع فريق الدعم لدينا.', 'سيراجع الضابط المستند.',
    ]) expect.soft(blockedRule(draft), draft).toBe('external_action');
    expect(blockedRule('Check with the seller using contact details you already have.')).toBeNull();
    expect(blockedRule('I can’t tell whether an officer has seen it.')).toBeNull();
  });

  it('catches unsolicited project names before sending a draft', () => {
    for (const draft of ['Hi! I’m Mirsad’s automated assistant.', 'Welcome to Misrad.', 'أنا مساعد مرصاد الآلي.']) {
      expect(blockedRule(draft, [], 'Hello')).toBe('unsolicited_brand');
    }
    expect(blockedRule('I’m from Mirsad.', [], 'Have you heard of Mirsad?')).toBe('unsolicited_brand');
    expect(blockedRule('The replies on this account are automated.', [], 'Have you heard of Mirsad?')).toBeNull();
  });

  it('retries an identity answer written entirely in a different script from the question', () => {
    expect(blockedRule('نعم، أنا ذكاء اصطناعي.', [], 'Are you AI?')).toBe('identity_language');
    expect(blockedRule('What do you mean?', [], 'بوت؟')).toBe('identity_language');
    expect(blockedRule('Yes.', [], 'Are you AI?')).toBeNull();
    expect(blockedRule('شو تقصد؟', [], 'بوت؟')).toBeNull();
    expect(blockedRule('مرحبا', [], 'What Arabic word did I write?')).toBeNull();
  });

  it('blocks a direct Arabic claim to be a person and permits a truthful denial', () => {
    expect(blockedRule('أنا شخص، بس أحيانًا أكتب بسرعة.')).toBe('human_claim');
    for (const reply of ['أنا مب شخص، أنا مساعد آلي.', 'أنا مو شخص.', 'أنا شخصيًا ما أقدر أفتح الملف.']) {
      expect(blockedRule(reply)).toBeNull();
    }
  });

  it('checks identity replies against the explicitly requested language of the burst', () => {
    for (const [request, question, allowed, rejected] of [
      ['Please reply in Arabic.', 'Are you a bot?', 'هيه، أنا مساعد آلي.', 'Yes, I am automated.'],
      ['رد بالإنجليزي.', 'هل أنت روبوت؟', 'Yes, I am automated.', 'هيه، أنا مساعد آلي.'],
    ] as const) {
      const active = [request, question];
      const history = active.map(text => ({ from: 'contact' as const, text }));
      expect(blockedRuleForTurn(allowed, history, active)).toBeNull();
      expect(blockedRuleForTurn(rejected, history, active)).toBe('identity_language');
    }
  });

  it('keeps follow-up questions about the charge itself and blocks requests for payment instructions', () => {
    for (const message of [
      'Is that fee paid online or over the phone?', 'How do I pay the deposit?',
      'Could you send me the payment link?', 'Which account should I transfer it to?',
      'هل الدفع يكون عبر تحويل بنكي أم بوابات دفع إلكترونية؟', 'كيف أحوّل لك المبلغ؟', 'ارسل لي رابط الدفع.',
      'شكراً، هل الدفع نقداً أم عبر تحويل؟', 'Is it cash or bank transfer?',
      'I can do bank transfers.', 'Send me your bank details instead.', "What's your IBAN?",
      'أقدر أحول لك المبلغ.', 'ممكن ترسل لي الآيبان؟',
    ]) expect.soft(blockedRule(message), message).toBe('payment_instructions');
    for (const message of [
      'Is the fee included in the original quote?', 'What is the extra fee for?',
      'Please do not send me a payment link.', 'هل الرسوم ضمن السعر؟', 'لا ترسل لي رابط الدفع.',
    ]) expect.soft(blockedRule(message), message).toBeNull();
  });

  it('keeps shared links and documents voluntary', () => {
    for (const draft of [
      'That sounds interesting. Do you have a website or brochure with more details?',
      'Can you send me a link?', 'Please share your brochure.', 'ممكن ترسل لي الرابط؟',
      'هل تودون أن ترسلوا لي رابط التسجيل؟', 'Could you send me the registration link?',
    ]) expect.soft(blockedRule(draft), draft).toBe('request_material');
    for (const draft of ['Please do not send me a link.', 'I can’t view the file.', 'لا ترسل الرابط.']) {
      expect.soft(blockedRule(draft), draft).toBeNull();
    }
  });

  it('keeps an ordinary offer from turning into a booking or a request for a precise location', () => {
    expect(blockedRule('Can I book it now?')).toBe('external_action');
    expect(blockedRule('شكراً، هل يمكنني الحجز الآن؟')).toBe('external_action');
    for (const draft of [
      'هل يمكنني حجز مكان لي؟', 'أقدر أحجز مقعد؟', 'ممكن تحجز لي مكان؟',
      'Could I reserve a spot for myself?', 'Can I sign up for Friday?', 'Please book me in.',
      "I'll just sign up for the email version then.", "I'll book the class.", 'راح أحجز مقعد.',
    ]) expect.soft(blockedRule(draft), draft).toBe('external_action');
    for (const draft of [
      'Is booking required?', 'Can I ask about the booking fee?', 'Can I cancel a booking?',
      'هل الحجز مطلوب؟', 'هل يمكنني معرفة مدة الورشة؟',
      "I won't sign up.", 'I can ask about the fee.', 'ما راح أحجز مقعد.',
    ]) expect.soft(blockedRule(draft), draft).toBeNull();
    expect(blockedRule('What is your exact address?')).toBe('location_request');
    expect(blockedRule('Understood. Do you have a specific location or address where this work takes place?')).toBe('location_request');
    expect(blockedRule('أحسنت، ومكان السجادة إيه بالضبط؟')).toBe('location_request');
    expect(blockedRule('Where on the receipt does the fee appear?')).toBeNull();
    expect(blockedRule('I can’t verify that address.')).toBeNull();
  });

  it('keeps the currency of a stated fee grounded in what the sender actually provided', () => {
    const statement = 'The sample is free, but delivery costs 8.';
    const history = [{ from: 'contact' as const, text: statement }];
    expect(blockedRuleForTurn('Got it, $8 for delivery.', history, [statement])).toBe('unstated_currency');
    expect(blockedRuleForTurn('Okay, delivery is extra.', history, [statement])).toBeNull();
    expect(blockedRuleForTurn('I agree to that.', history, [statement])).toBe('external_action');
    expect(blockedRuleForTurn('حسناً، موافق.', history, [statement])).toBe('external_action');
    expect(blockedRuleForTurn('Okay, understood.', history, [statement])).toBeNull();
    const originallyQuoted = [{ from: 'contact' as const, text: 'All the prices are in dollars.' }, ...history];
    expect(blockedRuleForTurn('Got it, $8 for delivery.', originallyQuoted, [statement])).toBeNull();
    expect(blockedRuleForTurn('Got it, €8 for delivery.', originallyQuoted, [statement])).toBe('unstated_currency');
    const ownerGuess = [{ from: 'owner' as const, text: 'Was it $8?' }, ...history];
    expect(blockedRuleForTurn('Got it, $8 for delivery.', ownerGuess, [statement])).toBe('unstated_currency');
  });

  it('accepts a brief dialect question about why a new job fee is required', () => {
    const latest = 'قبل ما تبدأ لازم تدفع رسوم تسجيل.';
    const history: ReplyTurn[] = [
      { from: 'contact', text: 'عندنا فرصة عمل.' },
      { from: 'owner', text: 'وش المطلوب؟' },
      { from: 'contact', text: latest },
    ];
    expect(blockedRuleForTurn('ما أقدر أدفع.', history, [latest])).toBe('fee_purpose_question');
    expect(blockedRuleForTurn('شنو نوع الرسوم بالضبط؟', history, [latest])).toBeNull();
    expect(blockedRuleForTurn('ليش لازم تدفع هالرسوم؟', history, [latest])).toBe('fee_purpose_question');
  });

  it('rejects offering to collect credentials and permits telling the sender to keep them private', () => {
    expect(blockedRule('I ask for passwords to verify accounts.')).toBe('secret_request');
    expect(blockedRule('لا، أنا روبوت آلي وأطلب كلمات المرور أو الأكواد.')).toBe('secret_request');
    expect(blockedRule('I never ask for passwords.')).toBeNull();
    expect(blockedRule('أنا لا أطلب كلمات المرور.')).toBeNull();
  });

  it('rejects a claim that the automated assistant owns the account, while allowing an honest explanation', () => {
    for (const claim of [
      'I am the account holder.', 'I’m the owner of this account.', 'I own this account.',
      'أنا صاحب الحساب.', 'أنا مالكة هذا الحساب.', 'هذا حسابي.',
    ]) expect.soft(blockedRule(claim, []), claim).toBe('human_claim');
    for (const disclosure of [
      "I'm an automated assistant, not the account holder.", 'I am the account holder’s automated assistant.',
      'I do not own this account.', 'I am not the owner of this account.',
      'أنا مساعد آلي ولست صاحب الحساب.', 'أنا مساعد صاحبة هذا الحساب.',
    ]) expect.soft(blockedRule(disclosure, []), disclosure).toBeNull();
  });

  it('blocks a reply of three words or more with the same words as one already sent, whatever the case and punctuation', () => {
    expect(blockedRule('Not yet, I want to know more first.', ['not yet... i want to know more first'])).toBe('repeat');
    expect(blockedRule('Not yet. Who is the landlord?', ['Not yet, I want to know more first.'])).toBeNull();
    expect(blockedRule('ok', ['Ok!'])).toBeNull();
    expect(blockedRule('👍', ['🙂'])).toBeNull();
  });

  it('blocks unverified answers to English or Arabic place verification questions', () => {
    const english = 'Do you know whether the pickup was at 24 Sample Road?';
    const arabic = 'هل كان اللقاء عند بوابة المركز؟';
    for (const [draft, question] of [
      ['Yes, the pickup was confirmed for 24 Sample Road.', english], ["That's correct.", english],
      ['The pickup was at the east entrance.', english], ['It was at the station.', 'Was the meeting at the station?'],
      ['No, it was at the west gate.', english],
      ['نعم، كان اللقاء عند البوابة.', arabic], ['صحيح.', arabic],
      ['كان الاستلام في المحطة.', 'تقدر تأكد إذا الاستلام كان في المحطة؟'],
    ]) expect.soft(blockedRule(draft!, [], question!), draft).toBe('unverified_location');
    for (const [draft, question] of [
      ["I don't know whether the pickup was there.", english], ["I can't verify that address.", english],
      ['You mentioned the east entrance.', english], ['No, I do not know.', english],
      ['You said the pickup was at the east entrance.', 'What did I say about the pickup?'],
      ['Yes.', 'The pickup was at 24 Sample Road. Can you answer in English?'],
      ['لا أستطيع تأكيد مكان اللقاء.', arabic], ['ذكرت أنك ستلتقي عند البوابة.', arabic],
      ['صحيح.', 'هل أنت مساعد آلي؟'],
    ]) expect.soft(blockedRule(draft!, [], question!), draft).toBeNull();
  });

  it('blocks instructions to visit the supplied link and permits warnings and independently known official channels', () => {
    for (const reply of [
      "I can't open links. Please check that link directly in your browser or app.",
      'You can click the link they sent you.', 'Try opening that link in a separate tab.',
      'Open that link with your bank app.',
      'افتح الرابط الذي وصلك من المتصفح.', 'يمكنك الضغط على هذا الرابط.', 'جرّب تفتح اللينك المرسل.',
      'تحقق من هذا الرابط في متصفحك.',
    ]) expect.soft(blockedRule(reply), reply).toBe('unsafe_link_advice');
    for (const reply of [
      "Don't open that link.", 'Never click the link they sent you.', 'You can check with your bank using the official app.',
      'Open the official app you normally use.', 'Verify the link with the company through a number you already know.',
      'Check that link with your bank.',
      'لا تفتح هذا الرابط.', 'يمكنك التحقق من الشركة عبر تطبيقها الرسمي.', 'افتح التطبيق الرسمي الذي تستخدمه عادة.',
    ]) expect.soft(blockedRule(reply), reply).toBeNull();
  });

  it('blocks asking for lookup identifiers in either language and permits neutral guidance', () => {
    for (const draft of [
      'Could you share your order number so I can check?', 'What is your tracking ID?',
      'I would need the order reference to look that up.', 'Do you have a tracking number?', 'Can you provide me with your order ID?',
      'أرسل لي رقم الطلب لأتحقق منه.', 'ما هو رقم التتبع؟', 'ممكن تعطيني رقم الشحنة؟',
    ]) expect.soft(blockedRule(draft, []), draft).toBe('lookup_request');
    for (const draft of [
      "I can't look up orders.", "Please don't send your order number.", 'You can check the tracking number with the carrier.',
      'لا ترسل رقم الطلب هنا.', 'يمكنك التحقق من رقم التتبع لدى شركة الشحن.',
    ]) expect.soft(blockedRule(draft, []), draft).toBeNull();
  });

  it('recognizes an exact repeated substantive reply when the earlier message included the first-turn disclosure', () => {
    expect(blockedRule('Thanks for explaining that.', ['I’m Mirsad’s automated assistant. Thanks for explaining that.'])).toBe('repeat');
    expect(blockedRule('شكرًا لك على التوضيح.', ['أنا مساعد مرصاد الآلي. شكرًا لك على التوضيح.'])).toBe('repeat');
    expect(blockedRule('Hello.', ['I’m Mirsad’s automated assistant. Hello.'])).toBeNull();
  });
});

describe('which message the reply worker answers', () => {
  const NOW = Date.parse('2026-11-21T08:00:00.000Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();
  const chat = { external_chat_id: '6000000101' };
  const message = (overrides: Partial<MessageRow> = {}): MessageRow => ({
    id: 'msg_test_1',
    chat_id: 'chat_test_1',
    workspace_id: 'ws_test_1',
    direction: 'incoming',
    origin: 'source',
    source_message_id: 'tg:101',
    original_captured: 1,
    text: 'Is the flat still free?',
    text_sha256: null,
    unsupported_content: '[]',
    sent_at: ago(60_000),
    received_at: ago(30_000),
    capture_method: 'telegram_business_live',
    sender_external_id: '6000000101',
    sender_display_name: null,
    sender_phone_raw: null,
    author_officer_id: null,
    send_status: null,
    edited_at_source: 0,
    telegram_edit_is_direct: null,
    deleted_at_source: 0,
    position: 1,
    ...overrides,
  });

  it('answers a fresh text the contact sent in a live chat', () => {
    expect(isAnswerable(chat, message(), NOW)).toBe(true);
  });

  it('skips every other message', () => {
    const skipped: [string, Partial<MessageRow>][] = [
      ['an outgoing message', { direction: 'outgoing' }],
      ['an officer draft', { origin: 'officer_composer' }],
      ['an imported message', { capture_method: 'whatsapp_export' }],
      ['a placeholder for a message never seen', { original_captured: 0 }],
      ['a message deleted at the source', { deleted_at_source: 1 }],
      ['a message from someone else', { sender_external_id: '6000000999' }],
      ['a message without text', { text: '   ' }],
      ['a backlog: sent long ago, received just now', { sent_at: ago(REPLY_FRESHNESS_MS + 1), received_at: ago(1_000) }],
      ['a message received long ago', { sent_at: null, received_at: ago(REPLY_FRESHNESS_MS + 1) }],
      ['dates that do not parse', { sent_at: 'not a date', received_at: 'not a date' }],
    ];
    for (const [why, overrides] of skipped) expect(isAnswerable(chat, message(overrides), NOW), why).toBe(false);
    expect(isAnswerable(chat, undefined, NOW)).toBe(false);
  });

  it('counts the window from the earlier of sent and received, its last millisecond included', () => {
    expect(isAnswerable(chat, message({ sent_at: ago(REPLY_FRESHNESS_MS), received_at: ago(0) }), NOW)).toBe(true);
    expect(isAnswerable(chat, message({ sent_at: null, received_at: ago(REPLY_FRESHNESS_MS) }), NOW)).toBe(true);
  });
});

describe('Bot API sender', () => {
  it('has exactly one method, which posts sendMessage on the business connection', async () => {
    const fake = fakeFetch(() =>
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 77, date: 1790000200, chat: { id: 6000000101 }, from: { id: OWNER_ID, first_name: 'Test' }, text: 'Hi!' } }),
        { status: 200 },
      ),
    );
    const sender = createBotSender({ token: BOT_TOKEN, baseUrl: 'http://127.0.0.1:9', fetch: fake.fetch });
    expect(Object.keys(sender)).toEqual(['sendBusinessMessage']);
    const sent = await sender.sendBusinessMessage({ businessConnectionId: CONNECTION_ID, chatId: 6000000101, text: 'Hi!' });
    expect(sent).toMatchObject({ message_id: 77, chat: { id: 6000000101 }, text: 'Hi!' });
    expect(fake.calls[0]?.url).toBe(`http://127.0.0.1:9/bot${BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(String(fake.calls[0]?.init.body))).toEqual({ business_connection_id: CONNECTION_ID, chat_id: 6000000101, text: 'Hi!' });
  });

  it('reports a refusal by code and status, with the token redacted from the description', async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ ok: false, error_code: 403, description: `Forbidden for ${BOT_TOKEN}` }), { status: 403 }));
    const sender = createBotSender({ token: BOT_TOKEN, baseUrl: 'http://127.0.0.1:9', fetch: fake.fetch });
    const failure = await sender.sendBusinessMessage({ businessConnectionId: CONNECTION_ID, chatId: 1, text: 'x' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BotApiError);
    expect(failure).toMatchObject({ method: 'sendMessage', code: 'api_error', status: 403 });
    expect((failure as BotApiError).description).not.toContain(BOT_TOKEN);
    expect(() => createBotSender({ token: 'not-a-token' })).toThrow('bot_token_malformed');
  });
});

describe('setup checks with local-model replies on', () => {
  const connection = (rights: Record<string, boolean> | undefined): BusinessConnection => ({
    id: CONNECTION_ID,
    user: { id: OWNER_ID, is_bot: false, first_name: 'Test' },
    user_chat_id: OWNER_ID,
    date: 1790000000,
    is_enabled: true,
    ...(rights ? { rights } : {}),
  });
  const api = (rights: Record<string, boolean> | undefined): BotApi => ({
    getMe: async () => ({ id: 5000000999, is_bot: true, first_name: 'Test Bot', username: 'mirsad_test_bot', can_connect_to_business: true }),
    getWebhookInfo: async () => ({ url: '', pending_update_count: 0 }),
    getBusinessConnection: async () => connection(rights),
    getUpdates: async () => [],
  });
  const env = (overrides: Record<string, string> = {}) =>
    loadConfig({
      TELEGRAM_LIVE_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_APPROVED_CONNECTION_ID: CONNECTION_ID,
      TELEGRAM_APPROVED_CHAT_IDS: '6000000101',
      TELEGRAM_APPROVAL_REFERENCE: 'TEST-APPROVAL-0001',
      TELEGRAM_AI_REPLIES_ENABLED: 'true',
      TELEGRAM_AI_REPLY_CONSENT_REFERENCE: 'TEST-CONSENT-0001',
      ...overrides,
    });
  const byId = (checks: { id: string; passed: boolean; detail: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

  it('passes with only the reply right granted and a consent reference set', async () => {
    const report = await verifyConnection(api({ can_reply: true, can_read_messages: false }), env(), { provisionedOwnerUserId: String(OWNER_ID) });
    const checks = byId(report.checks);
    expect(report.ready).toBe(true);
    expect(checks.connection_rights_none?.detail).toBe('allowed rights granted: can_reply');
    expect(checks.ai_replies_can_reply?.passed).toBe(true);
    expect(checks.ai_reply_consent_configured?.passed).toBe(true);
  });

  it('accepts an optional read grant alongside the required reply grant and lists the actual grants', async () => {
    const report = await verifyConnection(api({ can_read_messages: true, can_reply: true }), env(), { provisionedOwnerUserId: String(OWNER_ID) });
    expect(report.ready).toBe(true);
    expect(byId(report.checks).connection_rights_none).toMatchObject({ passed: true, detail: 'allowed rights granted: can_read_messages, can_reply' });
  });

  it('accepts the optional read grant on its own only in the extra-rights check, and still requires the reply grant', async () => {
    const report = await verifyConnection(api({ can_read_messages: true }), env(), { provisionedOwnerUserId: String(OWNER_ID) });
    const checks = byId(report.checks);
    expect(report.ready).toBe(false);
    expect(checks.connection_rights_none).toMatchObject({ passed: true, detail: 'allowed rights granted: can_read_messages' });
    expect(checks.ai_replies_can_reply?.passed).toBe(false);
  });

  it('fails without the reply right, with a disallowed right, or without a consent reference', async () => {
    const noReply = byId((await verifyConnection(api(undefined), env(), { provisionedOwnerUserId: String(OWNER_ID) })).checks);
    expect(noReply.ai_replies_can_reply?.passed).toBe(false);
    expect(noReply.connection_rights_none?.passed).toBe(true);
    const extra = byId((await verifyConnection(api({ can_reply: true, can_read_messages: true, can_delete_all_messages: true }), env(), { provisionedOwnerUserId: String(OWNER_ID) })).checks);
    expect(extra.connection_rights_none).toMatchObject({ passed: false, detail: 'rights granted: can_delete_all_messages' });
    const noConsent = await verifyConnection(api({ can_reply: true }), env({ TELEGRAM_AI_REPLY_CONSENT_REFERENCE: '' }), { provisionedOwnerUserId: String(OWNER_ID) });
    expect(noConsent.ready).toBe(false);
    expect(byId(noConsent.checks).ai_reply_consent_configured?.passed).toBe(false);
  });

  it('lists the reply-right check as not checked when the connection or the token cannot be read', async () => {
    const unreadable: BotApi = { ...api({ can_reply: true }), getBusinessConnection: async () => Promise.reject(new BotApiError('getBusinessConnection', 'network_error')) };
    const noConnection = byId((await verifyConnection(unreadable, env(), { provisionedOwnerUserId: String(OWNER_ID) })).checks);
    expect(noConnection.ai_replies_can_reply).toMatchObject({ passed: false, detail: 'not checked: the approved connection could not be read' });
    const badToken: BotApi = { ...api({ can_reply: true }), getMe: async () => Promise.reject(new BotApiError('getMe', 'api_error', 401, 'Unauthorized')) };
    const noToken = byId((await verifyConnection(badToken, env(), { provisionedOwnerUserId: String(OWNER_ID) })).checks);
    expect(noToken.ai_replies_can_reply).toMatchObject({ passed: false, detail: 'not checked: the token was not accepted' });
    expect(noToken.ai_reply_consent_configured?.passed).toBe(true);
  });

  it('rejects both read and reply grants on intake-only connections', async () => {
    const report = await verifyConnection(api({ can_reply: true, can_read_messages: true }), env({ TELEGRAM_AI_REPLIES_ENABLED: 'false' }), { provisionedOwnerUserId: String(OWNER_ID) });
    const checks = byId(report.checks);
    expect(checks.connection_rights_none).toMatchObject({ passed: false, detail: 'rights granted: can_read_messages, can_reply' });
    expect(checks.ai_replies_can_reply).toBeUndefined();
    expect(checks.ai_reply_consent_configured).toBeUndefined();
  });
});
