import { expect, it, onTestFinished, vi } from 'vitest';
import { Harness, incoming, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';
import { aliReplyContent } from '../helpers/ali-reply-content.ts';

it.each([
  { model: 'google/gemini-3.8-flash', useDefault: true },
  { model: 'thedrummer/cydonia-24b-v4.1', useDefault: false },
])('uses $model in both languages even with a local Arabic model configured', async ({ model, useDefault }) => {
  const chatId = 6000000041;
  const stand = standIns();
  const network = globalThis.fetch;
  const requests: { url: string; model: string; authorization: string | null }[] = [];
  const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/v1/chats')) return network(input, init);
    const request = JSON.parse(String(init?.body));
    requests.push({ url: url.href, model: request.model, authorization: new Headers(init?.headers).get('authorization') });
    if (url.href !== 'https://openrouter.ai/api/v1/chat/completions') return new Response(null, { status: 404 });
    const content = requests.length === 3 ? JSON.stringify({
      case_status: 'READY_FOR_OFFICER_REVIEW', should_reply: false, external_reply: null,
      review_reasons: ['upfront_fee', 'payment_pressure', 'contradictory_terms', 'unverified_payment_request'], silence_reason: null,
    }) : aliReplyContent(requests.length === 1 ? 'How tall is it?' : 'اسمي علي.');
    return Response.json({ model: request.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  });
  onTestFinished(() => { api.mockRestore(); });
  const h = await Harness.start({
    ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(chatId), TELEGRAM_AI_AUTO_START: 'true',
    MIRSAD_REPLY_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'synthetic-key', MIRSAD_LMSTUDIO_ARABIC_MODEL: 'local-arabic',
    ...(!useDefault && { MIRSAD_OPENROUTER_MODEL: model }),
  }, stand, undefined, true);
  try {
    for (const [index, message] of ['I have a bookshelf for sale.', 'شو اسمك؟'].entries()) {
      await h.receive(chatId, message);
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(index), WAIT);
      expect(requests[index]).toEqual({ url: 'https://openrouter.ai/api/v1/chat/completions', model, authorization: 'Bearer synthetic-key' });
      await vi.waitFor(() => expect(stand.sender.to(chatId)).toHaveLength(index + 1), WAIT);
    }
    const triggering = await h.receive(chatId, 'Pay me an upfront fee in the next five minutes or I withdraw the offer.');
    await vi.waitFor(async () => {
      const reviews = await h.caseActionsOf(chatId, 'telegram_officer_review_requested');
      expect(reviews).toContainEqual(expect.objectContaining({
        messageId: triggering.id, detail: expect.objectContaining({
          model, holdsReplies: true, reviewStatus: 'READY_FOR_OFFICER_REVIEW', reason: 'conversation_review',
        }),
      }));
    }, WAIT);
    expect(stand.sender.to(chatId).map(({ reply }) => reply.text)).toEqual(['How tall is it?', 'اسمي علي.']);
    const actions = await h.caseActionsOf(chatId, 'ai_reply_sent');
    expect(actions.map(action => action.detail.model)).toEqual([model, model]);
    expect(h.logs.join('\n')).not.toContain('synthetic-key');
  } finally {
    await h.stop();
  }
});

it.each(['first DM after dispatch', 'unanswered DM 19 minutes before dispatch'] as const)(
  'sends only the selected test chat’s %s to Gemini', async timing => {
  const selected = 6000000071;
  const other = 6000000072;
  const model = 'google/gemini-3.8-flash';
  const earlierOffer = 'My previous listing was an amethyst cabinet.';
  const otherOffer = 'I have a vermilion bicycle for sale.';
  const freshOffer = 'عندي رف خشب للبيع، بعدك تدور عليه؟';
  const reply = 'كم عرض الرف؟';
  const requests: { model: string; fresh: boolean; older: boolean; otherChat: boolean }[] = [];
  const localFetch = globalThis.fetch;
  const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/v1/')) return localFetch(input, init);
    if (url.href !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('unexpected_test_transport');
    const body = String(init?.body);
    requests.push({ model: JSON.parse(body).model, fresh: body.includes(freshOffer),
      older: body.toLowerCase().includes('amethyst'), otherChat: body.toLowerCase().includes('vermilion') });
    return Response.json({ model, choices: [{ message: { role: 'assistant', content: aliReplyContent(reply) }, finish_reason: 'stop' }] });
  });
  onTestFinished(() => { api.mockRestore(); });
  const stand = standIns();
  const h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST',
    TELEGRAM_AI_AUTO_START: 'true', MIRSAD_REPLY_PROVIDER: 'openrouter', MIRSAD_OPENROUTER_MODEL: model,
    OPENROUTER_API_KEY: 'synthetic-test-key' }, stand, undefined, true);
  try {
    expect((await h.call('POST', '/v1/telegram/dm-replies', { enabled: true })).data.enabled).toBe(true);
    expect((await h.call('POST', '/v1/telegram/consent-prompt', { enabled: false })).data.enabled).toBe(false);
    await h.receive(selected, earlierOffer, stand.clock.now().getTime() - 25 * 3600_000);
    await h.receive(other, otherOffer);
    await h.app.drain();
    expect((await h.chatFor(other))?.aiMode).toBe('ai_active');
    expect(await h.caseActionsOf(other, 'ai_auto_started')).toHaveLength(1);
    expect(await h.caseActionsOf(other, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(stand.sender.sent).toHaveLength(0);

    const chat = (await h.chatFor(selected))!;
    const selection = { chatIds: [chat.id], participantPermissionRecorded: true, expectedTestMode: true };
    const key = { 'Idempotency-Key': 'individual-authorized-test-chat' };
    if (timing === 'unanswered DM 19 minutes before dispatch') {
      await h.receive(selected, 'The amethyst cabinet also has two doors.', stand.clock.now().getTime() - 60_000);
    }
    await h.receive(other, 'The vermilion bicycle is still here.');
    const firstEligible = incoming(selected, freshOffer, stand.clock.now().getTime());
    if (timing === 'unanswered DM 19 minutes before dispatch') {
      await h.deliver(firstEligible);
      stand.clock.advance(19 * 60_000);
      await h.app.drain();
      expect(requests).toHaveLength(0);
      expect(stand.sender.sent).toHaveLength(0);
    }
    const dispatched = await h.call('POST', '/v1/dispatches', selection, key);
    expect(dispatched.success).toBe(true);
    await h.app.drain();
    if (timing === 'first DM after dispatch') {
      expect(requests).toHaveLength(0);
      await h.deliver(firstEligible);
      stand.clock.advance(3_000);
      await h.app.drain();
    }
    expect(requests).toEqual([{ model, fresh: true, older: false, otherChat: false }]);
    expect(stand.sender.to(selected).map(sent => sent.reply.text)).toEqual([reply]);
    expect(stand.sender.to(other)).toHaveLength(0);

    const replay = await h.call('POST', '/v1/dispatches', selection, key);
    expect(replay.data).toEqual(dispatched.data);
    const redelivery = { ...firstEligible, update_id: incoming(selected, '', stand.clock.now().getTime()).update_id };
    await h.deliver(redelivery);
    stand.clock.advance(3_000);
    await h.app.drain();
    expect(requests).toHaveLength(1);
    expect(stand.sender.sent).toHaveLength(1);
  } finally { await h.stop(); }
});
