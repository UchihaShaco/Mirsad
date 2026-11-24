import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { findLiveBindings } from '../../src/adapters/telegram/live-connector.ts';
import { startFreshChatTest } from '../../src/services/chat-test-session.ts';
import { ingest } from '../../src/services/intake.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { Harness, incoming, LIVE_BASE_ENV, OWNER_ID, standIns } from '../helpers/telegram-live-harness.ts';

const listed = 6000001401;
const contact = 6000001402;
let h: Harness;
const now = () => h.stand.clock.now().getTime();

async function invitations(enabled: boolean) {
  expect((await h.call('POST', '/v1/telegram/consent-prompt', { enabled })).success).toBe(true);
}

beforeEach(async () => {
  h = await Harness.start({
    ...LIVE_BASE_ENV, TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-ACTIVATION',
    TELEGRAM_APPROVED_CHAT_IDS: String(listed), TELEGRAM_AI_AUTO_START: 'false',
  }, standIns());
  expect((await h.call('POST', '/v1/telegram/dm-replies', { enabled: true })).success).toBe(true);
  await invitations(false);
});
afterEach(async () => { await h.stop(); });

it('starts a private chat on the first original photo, once, without granting permission or sending a message', async () => {
  const photo = incoming(contact, '', now());
  Object.assign(photo.business_message as object, { photo: [{ file_id: 'synthetic-photo' }] });
  await h.deliver(photo, photo);
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'ai_active' });
  expect(await h.caseActionsOf(contact, 'ai_auto_started')).toHaveLength(1);
  await h.receive(contact, 'I have another photo.');
  await h.app.drain();
  expect(await h.caseActionsOf(contact, 'ai_auto_started')).toHaveLength(1);
  expect(await h.caseActionsOf(contact, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
  expect(h.stand.generator.histories).toHaveLength(0);
  expect(h.stand.sender.to(contact)).toHaveLength(0);
});

it.each([
  { chatId: contact, permission: 'unrecorded', expectedReplies: 0 },
  { chatId: listed, permission: 'pre-approved', expectedReplies: 1 },
])('activates an owner-first chat with $permission permission and waits for the contact', async ({ chatId, expectedReplies }) => {
  const opener = incoming(chatId, 'Is the desk still available?', now(), { fromId: OWNER_ID });
  await h.deliver(opener, opener);
  h.stand.clock.advance(3_000);
  await h.app.drain();
  expect(await h.chatFor(chatId)).toMatchObject({ aiMode: 'ai_active', firstObservedDirection: 'outgoing' });
  expect(await h.caseActionsOf(chatId, 'ai_auto_started')).toHaveLength(1);
  expect(await h.caseActionsOf(chatId, 'telegram_dispatch_permission_recorded')).toHaveLength(0);
  expect(h.stand.generator.histories).toHaveLength(0);
  expect(h.stand.sender.to(chatId)).toHaveLength(0);

  // Contact commands apply only to the person on the other side of the chat.
  await h.deliver(incoming(chatId, 'STOP', now(), { fromId: OWNER_ID }));
  expect((await h.chatFor(chatId))?.telegramReplyHold.contactOptedOut).toBe(false);
  h.stand.generator.replyNext('How tall is the desk?');
  await h.receive(chatId, 'Yes, I still have the desk.');
  await h.app.drain();
  expect(h.stand.generator.histories).toHaveLength(expectedReplies);
  expect(h.stand.sender.to(chatId)).toHaveLength(expectedReplies);
  expect(await h.caseActionsOf(chatId, 'ai_auto_started')).toHaveLength(1);
});

it.each([
  { setting: 'Test mode', route: '/v1/telegram/consent-prompt', enabled: true },
  { setting: 'all-DM replies', route: '/v1/telegram/dm-replies', enabled: false },
])('leaves an owner-first chat unstarted when $setting is off', async ({ route, enabled }) => {
  expect((await h.call('POST', route, { enabled })).success).toBe(true);
  await h.deliver(incoming(listed, 'Is this chair still available?', now(), { fromId: OWNER_ID }));
  h.stand.clock.advance(3_000);
  await h.app.drain();
  expect(await h.chatFor(listed)).toMatchObject({ aiMode: 'not_started' });
  expect(await h.caseActionsOf(listed, 'ai_auto_started')).toHaveLength(0);
  expect(h.stand.generator.histories).toHaveLength(0);
  expect(h.stand.sender.to(listed)).toHaveLength(0);
});

it('starts from the next genuine original, ignoring edits, bot echoes, forwarded, and wrong-sender messages', async () => {
  const edited = incoming(contact, 'Corrected text', now());
  const forwarded = incoming(contact, 'Forwarded text', now());
  Object.assign(forwarded.business_message as object, { forward_origin: { type: 'hidden_user' } });
  const echo = incoming(contact, 'Automated outgoing copy', now(), { fromId: OWNER_ID });
  Object.assign(echo.business_message as object, { sender_business_bot: { id: 6000001450, is_bot: true } });
  await h.deliver({ update_id: edited.update_id, edited_business_message: edited.business_message },
    forwarded, echo,
    incoming(contact, 'Not the contact', now(), { fromId: contact + 1 }));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'not_started' });
  await h.deliver(incoming(contact, 'A fresh message', now()));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'ai_active' });
});

it('leaves normalized intake and delayed messages from before a fresh chat test undispatched', async () => {
  const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE), { clock: h.stand.clock });
  try {
    const delayed = incoming(contact, 'Earlier message', now());
    const later = incoming(contact, 'Stored without a native Telegram update', now());
    const number = (later.business_message as { message_id: number }).message_id;
    const officerId = (await h.call('GET', '/v1/me')).data.principal.id;
    const chatId = db.transaction(tx => {
      const [binding] = findLiveBindings(tx);
      const { chatId } = ingest(tx, binding!.principal, {
        source: 'telegram', externalAccountId: String(OWNER_ID), externalChatId: String(contact),
      }, {
        type: 'message.recorded', direction: 'incoming', sourceMessageId: `tg:${number}`, sourceEventId: 'normalized-original',
        text: 'Stored without a native Telegram update', sentAt: h.stand.clock.now().toISOString(),
        sender: { externalId: String(contact) },
      }, h.app.config);
      startFreshChatTest(tx, chatId, officerId);
      return chatId;
    });
    expect(await h.chatFor(contact)).toMatchObject({ id: chatId, aiMode: 'not_started' });
    await h.deliver({ ...delayed, update_id: incoming(contact, '', now()).update_id });
    expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'not_started' });
    await h.deliver(incoming(contact, 'First message in this test', now()));
    expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'ai_active' });
  } finally {
    db.close();
  }
});

it('records a material review hold from a permitted first DM before deciding whether to activate its chat', async () => {
  await h.deliver(incoming(listed, 'For the payment, my IBAN is GB00 FAKE 0000 0000 0000 00.', now()));
  expect(await h.chatFor(listed)).toMatchObject({
    aiMode: 'not_started', telegramReplyHold: { officerReview: { reason: 'bank_details' } },
  });
  await h.deliver(incoming(listed, 'I have a question.', now()));
  expect(await h.caseActionsOf(listed, 'ai_auto_started')).toHaveLength(0);
});

it('requires a new message after enabling test mode and the master switch, and excludes stale backlog', async () => {
  await invitations(true);
  const inNormalMode = now();
  await h.deliver(incoming(contact, 'First', inNormalMode));
  h.stand.clock.advance(1_000);
  await invitations(false);
  await h.deliver(incoming(contact, 'Delayed before test mode', inNormalMode));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'not_started' });
  h.stand.clock.advance(16 * 60_000);
  await h.deliver(incoming(contact, 'Delayed during test mode', inNormalMode + 1_000));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'not_started' });
  expect((await h.call('POST', '/v1/telegram/dm-replies', { enabled: false })).success).toBe(true);
  await h.deliver(incoming(contact, 'Master switch off', now()));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'not_started' });
  h.stand.clock.advance(1_000);
  expect((await h.call('POST', '/v1/telegram/dm-replies', { enabled: true })).success).toBe(true);
  await h.deliver(incoming(contact, 'Fresh since re-enable', now()));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'ai_active' });
});

it('preserves an opt-out on the first DM and officer control on later DMs', async () => {
  await h.deliver(incoming(contact, 'STOP', now()), incoming(contact, 'More information.', now()));
  await h.deliver(incoming(contact, 'Owner response', now(), { fromId: OWNER_ID }));
  expect(await h.chatFor(contact)).toMatchObject({ aiMode: 'not_started', telegramReplyHold: { contactOptedOut: true } });
  await h.deliver(incoming(listed, 'Hello', now()));
  expect(await h.chatFor(listed)).toMatchObject({ aiMode: 'ai_active' });
  await h.control(listed, 'pause');
  await h.deliver(incoming(listed, 'Another message', now()));
  expect(await h.chatFor(listed)).toMatchObject({ aiMode: 'paused' });
  await h.control(listed, 'take_over');
  await h.deliver(incoming(listed, 'Any update?', now()));
  expect(await h.chatFor(listed)).toMatchObject({ aiMode: 'officer_control' });
  expect(await h.caseActionsOf(listed, 'ai_auto_started')).toHaveLength(1);
});
