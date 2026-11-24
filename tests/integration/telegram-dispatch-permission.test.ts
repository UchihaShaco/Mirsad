import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns } from '../helpers/telegram-live-harness.ts';

const env = { ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-SCOPE',
  TELEGRAM_APPROVED_CHAT_IDS: '6000000981', TELEGRAM_AI_AUTO_START: 'false' };
const first = 6000000982, other = 6000000983;
const invites = '/v1/telegram/consent-prompt', replies = '/v1/telegram/dm-replies';

function dispatch(h: Harness, chatIds: string[], extra: Record<string, unknown> = { participantPermissionRecorded: true }) {
  return h.call('POST', '/v1/dispatches', { chatIds, ...extra }, { 'Idempotency-Key': randomUUID() });
}

async function register(h: Harness, contact: number): Promise<string> {
  const result = await h.call('POST', '/v1/chats', { source: 'telegram', externalAccountId: String(OWNER_ID),
    externalChatId: String(contact), displayLabel: 'Synthetic contact' });
  return result.data.chat.id as string;
}

it.each(['manual', 'test'] as const)('answers the selected unanswered DM immediately on confirmed Dispatch in %s mode', async mode => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    await h.call('POST', replies, { enabled: true });
    const testMode = mode === 'test';
    await h.call('POST', invites, testMode ? { enabled: false } : { enabled: true, manualDispatchOnly: true });
    const at = stand.clock.now().getTime();
    const latest = 'I have a pine table for sale.';
    await h.deliver(incoming(first, 'I had an older listing.', at), incoming(first, latest, at));
    const chat = (await h.chatFor(first))!;
    const body = { chatIds: [chat.id], participantPermissionRecorded: true, ...(testMode && { expectedTestMode: true }) };
    const key = { 'Idempotency-Key': randomUUID() };
    stand.generator.replyNext('How wide is the table?');
    expect((await h.call('POST', '/v1/dispatches', body, key)).success).toBe(true);
    await h.app.drain();
    expect(stand.sender.to(first).map(sent => sent.reply.text)).toEqual(['How wide is the table?']);
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: latest }]]);

    expect((await h.call('POST', '/v1/dispatches', body, key)).success).toBe(true);
    await h.deliver(incoming(first, 'It is eighty centimetres wide.', at));
    await h.app.drain();
    expect(stand.sender.to(first)).toHaveLength(1);
    stand.clock.advance(3_000);
    await h.app.drain();
    expect(stand.sender.to(first)).toHaveLength(2);
  } finally { await h.stop(); }
});

it.each(['existing chat grant', 'account activation'] as const)(
  'answers the selected message across an earlier %s cutoff and continues on the next DM', async cutoff => {
    const stand = standIns();
    const h = await Harness.start(env, stand);
    try {
      const selected = await register(h, first);
      if (cutoff === 'existing chat grant') {
        const empty = await dispatch(h, [selected]);
        expect(empty.data.results[0].telegram.reason).toBe('no_message');
      } else {
        await h.call('POST', replies, { enabled: false });
      }
      const earlier = 'I also listed a desk last week.';
      const question = 'Are you interested in the oak table?';
      const at = stand.clock.now().getTime() - 60_000;
      await h.deliver(incoming(first, earlier, at), incoming(first, question, at + 1_000));
      if (cutoff === 'account activation') await h.call('POST', replies, { enabled: true });
      await h.app.drain();
      expect(stand.generator.histories).toHaveLength(0);

      const timeline = await h.timelineOf(first);
      const target = timeline.telegramReplies.target;
      expect(target).toBeTruthy();
      expect(target.messageId).toBe(timeline.messages.find((m: { text: string }) => m.text === question)?.id);
      const key = { 'Idempotency-Key': randomUUID() };
      const body = { chatIds: [selected], participantPermissionRecorded: true, replyAgain: true,
        replyToMessageId: target.messageId, replyToHeadPosition: target.headPosition };
      stand.generator.replyNext('How wide is the table?');
      const sent = await h.call('POST', '/v1/dispatches', body, key);
      expect(sent.data.results[0].telegram).toMatchObject({ reply: 'queued', messageId: target.messageId });
      await h.app.drain();
      expect(stand.generator.histories).toEqual([[{ from: 'contact', text: question }]]);
      expect(stand.sender.to(first).map(item => item.reply.text)).toEqual(['How wide is the table?']);
      expect((await h.call('POST', '/v1/dispatches', body, key)).data.dispatchId).toBe(sent.data.dispatchId);

      stand.clock.advance(3_000);
      await h.receive(first, 'It is eighty centimetres wide.');
      await h.app.drain();
      expect(stand.sender.to(first)).toHaveLength(2);
      expect(stand.generator.histories.at(-1)?.some(turn => turn.text === earlier)).toBe(false);
    } finally { await h.stop(); }
  },
);

it('replies immediately to an older eligible DM when Dispatch confirms a verified phone match', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    await h.call('POST', replies, { enabled: true });
    await h.call('POST', invites, { enabled: true, manualDispatchOnly: true });
    const at = stand.clock.now().getTime();
    const card = incoming(first, '', at);
    const message = card.business_message as Record<string, unknown>;
    delete message.text;
    const phone = '+447700900010';
    message.contact = { first_name: 'Test', phone_number: phone, user_id: first };
    await h.deliver(card);
    stand.clock.advance(20 * 60_000);
    const offer = 'I have a small shelf for sale.';
    await h.deliver(incoming(first, offer, at + 60_000));
    stand.generator.replyNext('How wide is the shelf?');
    const result = await h.call('POST', '/v1/dispatches/by-phone', { phoneNumber: phone, participantPermissionRecorded: true },
      { 'Idempotency-Key': randomUUID() });
    expect(result.data.outcome).toBe('dispatched');
    await h.app.drain();
    expect(stand.sender.to(first).map(sent => sent.reply.text)).toEqual(['How wide is the shelf?']);
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: offer }]]);
  } finally { await h.stop(); }
});

it('lets the model ask for a description of an approved captionless photo using only its type', async () => {
  const stand = standIns();
  const clarification = 'Could you describe the item in the photo?';
  const composePublicReply = vi.fn<ReplyGenerator['generate']>().mockResolvedValue(clarification);
  Object.assign(stand.generator, { composePublicReply });
  const h = await Harness.start(env, stand);
  try {
    await h.call('POST', replies, { enabled: true });
    await h.call('POST', invites, { enabled: true, manualDispatchOnly: true });
    const photo = incoming(first, '', stand.clock.now().getTime());
    const message = photo.business_message as Record<string, unknown>;
    delete message.text;
    message.photo = [{ file_id: 'synthetic-private-media-id', file_unique_id: 'synthetic-private-media-key', width: 10, height: 10 }];
    await h.deliver(photo);
    const chat = (await h.chatFor(first))!;
    const requested = await dispatch(h, [chat.id], { participantPermissionRecorded: true, replyAgain: true });
    expect(requested.data.results[0].telegram).toMatchObject({ kind: 'ask_for_text', reply: 'queued' });
    await h.app.drain();
    expect(composePublicReply).toHaveBeenCalledOnce();
    const [history, , , turn, , context] = composePublicReply.mock.calls[0]!;
    expect(history).toEqual([]);
    expect(turn).toEqual([]);
    expect(context).toMatchObject({ attachmentKinds: ['photo'] });
    expect(JSON.stringify(context)).not.toContain('synthetic-private-media');
    expect(stand.sender.to(first).map(item => item.reply.text)).toEqual([clarification]);
    expect(await h.caseActionsOf(first, 'ai_reply_sent')).toMatchObject([{ detail: { source: 'model', model: 'test-model' } }]);
  } finally { await h.stop(); }
});

it('records existing permission only for selected chats and audits each attested Dispatch', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    const selected = await register(h, first), untouched = await register(h, other);
    expect((await dispatch(h, [selected, untouched], { participantPermissionRecorded: true, replyAgain: true,
      replyToMessageId: 'msg_00000000000000000000000000000001' })).error.code).toBe('validation_failed');
    expect((await dispatch(h, [selected], { participantPermissionRecorded: false })).error.code).toBe('validation_failed');
    expect((await dispatch(h, [selected], { expectedTestMode: true })).error.code).toBe('validation_failed');
    expect((await h.call('POST', '/v1/dispatches/by-phone', { phoneNumber: '+447700900010',
      participantPermissionRecorded: true }, { 'Idempotency-Key': randomUUID() })).data).toEqual({ outcome: 'no_verified_chat' });
    expect(await h.caseActionsOf(first, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
    expect(await h.caseActionsOf(other, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
    expect((await dispatch(h, [selected], { participantPermissionRecorded: true, expectedTestMode: true })).error.code).toBe('revision_conflict');
    expect((await dispatch(h, [selected, untouched], {})).success).toBe(true);
    await h.call('POST', invites, { enabled: false });
    const result = await dispatch(h, [selected], { participantPermissionRecorded: true, expectedTestMode: true });
    expect(result.data.results[0].status).toBe('already_active');
    await h.receive(other, 'Other participant');
    await h.receive(first, 'First question from the selected participant');
    await h.app.drain();
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: 'First question from the selected participant' }]]);
    expect(stand.sender.to(other)).toHaveLength(0);
    expect((await h.timelineOf(first)).telegramAiPermission).toBe('approved');
    expect((await h.timelineOf(other)).telegramAiPermission).toBe('needed');
    expect((await h.caseActionsOf(first, 'telegram_dispatch_permission_recorded'))[0]?.actor.displayName).toBe('Officer A');

    const approval = { chatIds: [selected, untouched], participantPermissionRecorded: true, replyAgain: true };
    const key = { 'Idempotency-Key': randomUUID() };
    const batch = await h.call('POST', '/v1/dispatches', approval, key);
    expect(batch.data.results).toMatchObject([
      { chatId: selected, telegram: { reply: 'queued', kind: 'follow_up' } },
      { chatId: untouched, telegram: { reply: 'queued', kind: 'reply' } },
    ]);
    await h.app.drain();
    expect(stand.sender.to(first)).toHaveLength(2);
    expect(stand.sender.to(other)).toHaveLength(1);
    expect((await h.timelineOf(other)).telegramAiPermission).toBe('approved');
    expect((await h.call('POST', '/v1/dispatches', approval, key)).data.dispatchId).toBe(batch.data.dispatchId);
    for (const contact of [first, other]) {
      const confirmations = await h.caseActionsOf(contact, 'telegram_dispatch_approved');
      expect(confirmations.filter(action => action.detail.dispatchId === batch.data.dispatchId)).toHaveLength(1);
      expect(await h.caseActionsOf(contact, 'telegram_dispatch_permission_recorded')).toHaveLength(1);
    }
  } finally { await h.stop(); }
});

it('ignores delayed pre-permission content and retains the selected grant across restart, but STOP prevents redispatch', async () => {
  const stand = standIns();
  let h = await Harness.start(env, stand);
  try {
    const selected = await register(h, first);
    await h.receive(first, 'Private earlier offer');
    const old = incoming(first, 'Delayed private offer', stand.clock.now().getTime());
    await h.receive(first, 'Which size do you need?');
    expect((await dispatch(h, [selected])).success).toBe(true);
    await h.app.drain();
    expect(stand.generator.histories[0]).toEqual([{ from: 'contact', text: 'Which size do you need?' }]);
    await h.close();
    const again = standIns(stand.clock);
    h = await Harness.start(env, again, h.data);
    await h.deliver({ ...old, update_id: incoming(first, 'unused', again.clock.now().getTime()).update_id });
    again.clock.advance(3_000);
    await h.app.drain();
    expect(again.generator.histories).toHaveLength(0);
    again.generator.replyNext('Yes, can you tell me the size?');
    await h.receive(first, 'Can we continue?');
    await h.app.drain();
    expect(again.generator.histories).toHaveLength(1);
    expect(again.generator.histories[0]?.map(turn => turn.text)).not.toContain('Delayed private offer');
    await h.receive(first, 'Never contact me again.');
    await h.app.drain();
    expect((await h.timelineOf(first)).telegramAiPermission).toBe('withdrawn');
    expect((await dispatch(h, [selected])).error.code).toBe('invalid_transition');
    await h.receive(first, 'Hello again');
    await h.app.drain();
    expect(again.generator.histories).toHaveLength(1);
  } finally { await h.stop(); }
});

it('keeps global pause authoritative and starts with a new message after re-enable', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    const selected = await register(h, first);
    await h.call('POST', replies, { enabled: false });
    await h.receive(first, 'Before granting permission while paused');
    expect((await dispatch(h, [selected])).success).toBe(true);
    await h.receive(first, 'After granting permission while paused');
    await h.app.drain();
    expect(stand.generator.histories).toHaveLength(0);
    await h.call('POST', replies, { enabled: true });
    await h.receive(first, 'First message since enabling');
    await h.app.drain();
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: 'First message since enabling' }]]);
  } finally { await h.stop(); }
});

it('does not invite a participant with recorded permission when an older update arrives after dispatch', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    const selected = await register(h, first);
    await h.call('POST', replies, { enabled: true });
    const at = stand.clock.now().getTime();
    const older = incoming(first, 'Earlier private question', at);
    await h.deliver(incoming(first, 'Which size are you after?', at));
    expect((await dispatch(h, [selected])).success).toBe(true);
    stand.clock.advance(3_000);
    await h.app.drain();
    expect(stand.sender.to(first)).toHaveLength(1);
    await h.deliver({ ...older, update_id: incoming(first, 'unused', at).update_id });
    stand.clock.advance(3_000);
    await h.app.drain();
    expect(stand.sender.to(first)).toHaveLength(1);
    expect(stand.generator.histories).toEqual([[{ from: 'contact', text: 'Which size are you after?' }]]);
  } finally { await h.stop(); }
});

it('removes officer-recorded permission and its pending catch-up when the local history is erased', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    const selected = await register(h, first);
    await dispatch(h, [selected]);
    await h.receive(first, 'Question during the first test');
    await h.app.drain();
    expect(stand.generator.histories).toHaveLength(1);
    const base = '/v1/chats/' + selected;
    const preview = await h.call('GET', base + '/erase-preview');
    const erased = await h.call('POST', base + '/erase', { expectedSnapshot: preview.data.snapshot, confirm: true },
      { 'Idempotency-Key': randomUUID() });
    expect(erased.success).toBe(true);
    stand.clock.advance(2_000);
    await h.receive(first, 'Next test without permission');
    await h.app.drain();
    expect(stand.generator.histories).toHaveLength(1);
    expect(await h.caseActionsOf(first, 'telegram_dispatch_permission_recorded')).toEqual([]);
  } finally { await h.stop(); }
});
