import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
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

it('requires an explicit single-chat action and the confirmed test setting, including on an already-active chat', async () => {
  const stand = standIns();
  const h = await Harness.start(env, stand);
  try {
    const selected = await register(h, first), untouched = await register(h, other);
    expect((await dispatch(h, [selected, untouched])).error.code).toBe('validation_failed');
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
