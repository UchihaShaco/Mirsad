import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLiveBindings } from '../../src/adapters/telegram/live-connector.ts';
import { ingest } from '../../src/services/intake.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { deletion, Harness, incoming, type Json, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const first = 99101001;
const second = 99101002;
const phone = '+44 7700 900123';
const other = '+44 7700 900124';
const endpoint = '/v1/dispatches/by-phone';

describe('dispatch by a Telegram self-shared phone number', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: `${first},${second}`, TELEGRAM_AI_REPLIES_ENABLED: 'false' }, standIns());
  });
  afterEach(async () => { await h.stop(); });

  function card(chat: number, number: string, contactUser = chat) {
    const update = incoming(chat, '', h.stand.clock.now().getTime());
    const message = update.business_message as Json;
    delete message.text;
    message.contact = { first_name: 'Test', phone_number: number, user_id: contactUser };
    return update;
  }
  const submit = (number: string, key: string, officerContext?: string) => h.call('POST', endpoint,
    { phoneNumber: number, officerContext }, { 'Idempotency-Key': key });

  it('matches Arabic-formatted input to a verified card and replays the single dispatch', async () => {
    await h.deliver(card(first, '447700900123'));
    const result = await submit('٠٠٤٤ ٧٧٠٠ ٩٠٠١٢٣', 'one', 'Review the offer');
    const chat = await h.chatFor(first);
    expect(result.data).toMatchObject({ outcome: 'dispatched', chatId: chat?.id, dispatch: { results: [{ chatId: chat?.id }] } });
    expect((await submit(phone, 'one', 'Review the offer')).data).toEqual(result.data);
    expect((await submit(other, 'one', 'Review the offer')).error?.code).toBe('idempotency_key_reused');
    expect(JSON.stringify(result)).not.toContain('7700');
    expect(h.logs.join('')).not.toContain('7700');
  });

  it('ignores text and third-party or forwarded cards, and leaves an unknown number for the officer', async () => {
    const forwarded = card(second, phone);
    (forwarded.business_message as Json).forward_origin = { type: 'hidden_user', sender_user_name: 'Test', date: 1 };
    await h.deliver(incoming(first, phone, h.stand.clock.now().getTime()), card(first, phone, second), forwarded);
    expect((await submit(phone, 'unknown')).data).toEqual({ outcome: 'no_verified_chat' });
    expect(h.stand.sender.sent).toHaveLength(0);
    expect((await submit('07700 900123', 'local')).error?.code).toBe('validation_failed');
    expect((await submit('+44 (0)7700 900123', 'trunk')).error?.code).toBe('validation_failed');
    expect((await submit('call ' + phone, 'text')).error?.code).toBe('validation_failed');
    expect((await h.call('POST', endpoint, { phoneNumber: phone })).error?.code).toBe('idempotency_key_required');
  });

  it('declines ambiguous matches and never reactivates superseded or deleted numbers', async () => {
    const older = card(first, phone);
    await h.deliver(older, card(second, phone));
    expect((await submit(phone, 'duplicate')).data).toEqual({ outcome: 'ambiguous' });
    const newer = card(first, other);
    await h.deliver(newer);
    expect((await submit(phone, 'other-chat')).data.chatId).toBe((await h.chatFor(second))?.id);
    await h.deliver(deletion(first, [(newer.business_message as Json).message_id]));
    expect((await submit(other, 'deleted')).data).toEqual({ outcome: 'no_verified_chat' });
    expect((await submit(phone, 'obsolete')).data.chatId).toBe((await h.chatFor(second))?.id);
  });

  it('does not accept a normalized contact submission as a Telegram-authenticated card', async () => {
    const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE));
    try {
      db.transaction(tx => {
        const binding = findLiveBindings(tx)[0]!;
        ingest(tx, binding.principal, { source: 'telegram', externalAccountId: binding.account.external_account_id, externalChatId: String(first) }, {
          type: 'message.recorded', sourceMessageId: 'tg:111', sourceEventId: 'tg:u8:m111', sentAt: tx.now(), direction: 'incoming',
          text: '', unsupportedContent: ['contact'], sender: { externalId: String(first), phone: { raw: phone, internationalFormat: true } },
        }, h.app.config);
      });
      expect((await submit(phone, 'unattested')).data).toEqual({ outcome: 'no_verified_chat' });
    } finally { db.close(); }
  });

  it('revoking a grant hides both current matches and cached dispatch details', async () => {
    await h.deliver(card(first, phone));
    expect((await submit(phone, 'scoped')).data.outcome).toBe('dispatched');
    const officer = (await h.call('GET', '/v1/me')).data.principal;
    const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE));
    try {
      db.transaction(tx => tx.run('DELETE FROM account_grants WHERE principal_id = ?', [officer.id]));
      expect((await submit(phone, 'new')).data).toEqual({ outcome: 'no_verified_chat' });
      expect((await submit(phone, 'scoped')).error?.code).toBe('chat_not_found');
    } finally { db.close(); }
  });

  it('returns the spent receipt when a phone dispatch is retried after erasing its verified chat', async () => {
    await h.deliver(card(first, phone));
    const { chatId } = (await submit(phone, 'before-erase')).data;
    const base = `/v1/chats/${chatId}/erase`;
    const { snapshot } = (await h.call('GET', base + '-preview')).data;
    expect((await h.call('POST', base, { expectedSnapshot: snapshot, confirm: true },
      { 'Idempotency-Key': 'forget-phone-dispatch' })).data.chatCount).toBe(1);
    expect((await submit(phone, 'before-erase')).error?.code).toBe('history_erased');
    expect((await submit(phone, 'after-erase')).data).toEqual({ outcome: 'no_verified_chat' });
  });
});
