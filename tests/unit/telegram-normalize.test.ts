import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTelegramAdapter } from '../../src/adapters/telegram/normalize.ts';
import type { TelegramMessage, TelegramUpdate } from '../../src/adapters/telegram/types.ts';
import { validateFixture } from '../../src/adapters/replay.ts';

const OWNER = 5_000_000_001;
const CONTACT = 6_000_000_001;
const CONNECTION = 'TestBizConn-0001';
const DATE = 1_790_000_000;

const adapter = (conversationStarts?: { chatId: number; messageId: number }[]) =>
  createTelegramAdapter({
    businessUserId: OWNER,
    businessConnectionId: CONNECTION,
    externalAccountId: 'acct-1',
    ...(conversationStarts ? { conversationStarts } : {}),
  });

const message = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({
  message_id: 4101,
  date: DATE,
  chat: { id: CONTACT, type: 'private', first_name: 'Test', last_name: 'Contact 1' },
  from: { id: CONTACT, is_bot: false, first_name: 'Test', last_name: 'Contact 1' },
  business_connection_id: CONNECTION,
  text: 'Hello there',
  ...over,
});

const incoming = (updateId: number, over: Partial<TelegramMessage> = {}): TelegramUpdate => ({
  update_id: updateId,
  business_message: message(over),
});

describe('telegram normalizer', () => {
  it('a business_message from the contact is incoming and one from the business account is outgoing', () => {
    const [inEnv] = adapter().normalize(incoming(900_000_001));
    const [outEnv] = adapter().normalize(
      incoming(900_000_002, { message_id: 4102, from: { id: OWNER, is_bot: false, first_name: 'Test', last_name: 'Owner' } }),
    );
    expect(inEnv).toMatchObject({
      source: 'telegram',
      externalAccountId: 'acct-1',
      externalChatId: String(CONTACT),
      event: {
        type: 'message.recorded',
        direction: 'incoming',
        text: 'Hello there',
        sourceMessageId: 'tg:4101',
        sentAt: new Date(DATE * 1000).toISOString(),
        sender: { externalId: String(CONTACT), displayName: 'Test Contact 1' },
      },
    });
    expect(outEnv?.event).toMatchObject({ type: 'message.recorded', direction: 'outgoing' });
    const [botEnv] = adapter().normalize(incoming(900_000_003, { sender_business_bot: { id: 77, is_bot: true, first_name: 'Bot' } }));
    expect(botEnv?.event).toMatchObject({ direction: 'outgoing' });
  });

  it('source ids are stable across redelivery', () => {
    const update = incoming(900_000_001);
    expect(adapter().normalize(update)).toEqual(adapter().normalize(structuredClone(update)));
    const [env] = adapter().normalize(update);
    expect(env?.event.sourceEventId).toBe('tg:u900000001:m4101');
  });

  it('an edited_business_message becomes message.edited with the new text and direction', () => {
    const [env] = adapter().normalize({
      update_id: 900_000_002,
      edited_business_message: message({ text: 'Changed text', edit_date: DATE + 60 }),
    });
    expect(env?.event).toEqual({
      type: 'message.edited',
      sourceEventId: `tg:u900000002:m4101:e${DATE + 60}`,
      sourceMessageId: 'tg:4101',
      text: 'Changed text',
      editedAt: new Date((DATE + 60) * 1000).toISOString(),
      direction: 'incoming',
    });
  });

  it('deleted_business_messages fans out to one deletion per message id', () => {
    const envelopes = adapter().normalize({
      update_id: 900_000_003,
      deleted_business_messages: {
        business_connection_id: CONNECTION,
        chat: { id: CONTACT, type: 'private', first_name: 'Test' },
        message_ids: [4101, 4102],
      },
    });
    expect(envelopes.map((e) => e.event)).toEqual([
      { type: 'message.deleted', sourceEventId: 'tg:u900000003:m4101:del', sourceMessageId: 'tg:4101' },
      { type: 'message.deleted', sourceEventId: 'tg:u900000003:m4102:del', sourceMessageId: 'tg:4102' },
    ]);
    expect(envelopes.every((e) => e.externalChatId === String(CONTACT))).toBe(true);
  });

  it('edits and deletions carry the chat label too, so a chat first seen through one is named after the contact', () => {
    const [edit] = adapter().normalize({
      update_id: 900_000_015,
      edited_business_message: message({ text: 'Changed text', edit_date: DATE + 60 }),
    });
    const [deletion] = adapter().normalize({
      update_id: 900_000_016,
      deleted_business_messages: {
        business_connection_id: CONNECTION,
        chat: { id: CONTACT, type: 'private', first_name: 'Test', last_name: 'Contact 1' },
        message_ids: [4101],
      },
    });
    expect(edit?.chat).toEqual({ displayLabel: 'Test Contact 1' });
    expect(deletion?.chat).toEqual({ displayLabel: 'Test Contact 1' });
  });

  it('a caption is used as text and media kinds are listed as unsupported content', () => {
    const [env] = adapter().normalize(
      incoming(900_000_004, { text: undefined, caption: 'Look at this', photo: [{ file_id: 'x' }], document: { file_id: 'y' } }),
    );
    expect(env?.event).toMatchObject({ text: 'Look at this', unsupportedContent: ['photo', 'document'] });
    const [bare] = adapter().normalize(incoming(900_000_005, { text: undefined, sticker: { file_id: 's' } }));
    expect(bare?.event).toMatchObject({ text: '', unsupportedContent: ['sticker'] });
  });

  it("a contact card for the sender's own user id supplies the sender phone and any other contact card does not", () => {
    const own = adapter().normalize(
      incoming(900_000_006, { text: undefined, contact: { phone_number: '+447700900123', first_name: 'Test', user_id: CONTACT } }),
    )[0];
    expect(own?.event).toMatchObject({
      sender: { externalId: String(CONTACT), phone: { raw: '+447700900123', internationalFormat: true } },
      unsupportedContent: ['contact'],
    });
    const other = adapter().normalize(
      incoming(900_000_007, { text: undefined, contact: { phone_number: '+447700900124', first_name: 'Other', user_id: 6_000_000_099 } }),
    )[0];
    expect(other?.event).toMatchObject({ unsupportedContent: ['contact'] });
    expect((other?.event as { sender?: { phone?: unknown } }).sender?.phone).toBeUndefined();
    const outgoingCard = adapter().normalize(
      incoming(900_000_008, {
        from: { id: OWNER, is_bot: false, first_name: 'Test' },
        text: undefined,
        contact: { phone_number: '+447700900125', first_name: 'Test', user_id: OWNER },
      }),
    )[0];
    expect((outgoingCard?.event as { sender?: { phone?: unknown } }).sender?.phone).toBeUndefined();
  });

  it('a business_connection update yields no intake event', () => {
    const update: TelegramUpdate = {
      update_id: 900_000_009,
      business_connection: {
        id: CONNECTION,
        user: { id: OWNER, is_bot: false, first_name: 'Test Owner' },
        user_chat_id: OWNER,
        date: DATE,
        is_enabled: true,
      },
    };
    expect(adapter().normalize(update)).toEqual([]);
  });

  it('updates for another business connection are ignored', () => {
    const wrong = 'TestBizConn-9999';
    expect(adapter().normalize(incoming(900_000_010, { business_connection_id: wrong }))).toEqual([]);
    expect(
      adapter().normalize({
        update_id: 900_000_011,
        deleted_business_messages: { business_connection_id: wrong, chat: { id: CONTACT, type: 'private' }, message_ids: [4101] },
      }),
    ).toEqual([]);
  });

  it('skips message id 0 and marks a configured conversation start', () => {
    expect(adapter().normalize(incoming(900_000_012, { message_id: 0 }))).toEqual([]);
    const [marked] = adapter([{ chatId: CONTACT, messageId: 4101 }]).normalize(incoming(900_000_013));
    expect(marked?.event).toMatchObject({ conversationStart: { basis: 'source_start_marker' } });
    const [unmarked] = adapter([{ chatId: CONTACT, messageId: 4999 }]).normalize(incoming(900_000_014));
    expect((unmarked?.event as { conversationStart?: unknown }).conversationStart).toBeUndefined();
  });

  it('every fixture file is marked synthetic and uses only reserved domains and fictional phone ranges', () => {
    const dir = path.resolve(import.meta.dirname, '../../fixtures/telegram');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual([
      'edit-and-delete.json',
      'inbound-first-greeting.json',
      'merchant-conflict.json',
      'officer-first.json',
      'payment-destination-change.json',
      'takeover-pair.json',
      'watchlist-sequence.json',
    ]);
    for (const file of files) {
      const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as unknown;
      expect({ file, problems: validateFixture(fixture) }).toEqual({ file, problems: [] });
    }
  });

  it('validateFixture reports unmarked files, real-looking domains and phone numbers', () => {
    const base = {
      description: 'x',
      synthetic: true,
      account: 'intake',
      businessUserId: OWNER,
      businessConnectionId: CONNECTION,
      updates: [incoming(900_000_001, { text: 'see https://pay.real-bank.com/x or +1 415 555 0223 or +44 7700 900123' })],
    };
    const problems = validateFixture(base);
    expect(problems.some((p) => p.includes('domain'))).toBe(true);
    expect(problems.some((p) => p.includes('phone'))).toBe(true);
    expect(validateFixture({ ...base, synthetic: false })).toContain('fixture is not marked synthetic: true');
  });
  it('validateFixture refuses non-reserved numbers written in Arabic-Indic digits and bare Arabic-script hosts', () => {
    const base = {
      description: 'x',
      synthetic: true,
      account: 'intake',
      businessUserId: OWNER,
      businessConnectionId: CONNECTION,
      updates: [incoming(900_000_001)],
    };
    const withText = (text: string) => ({ ...base, updates: [incoming(900_000_001, { text })] });
    expect(validateFixture(withText('اتصل بي على +٩٧١٥٠١٢٣٤٥٦٧')).some((p) => p.includes('phone'))).toBe(true);
    expect(validateFixture(withText('اتصل بي على +۹۷۱۵۰۱۲۳۴۵۶۷')).some((p) => p.includes('phone'))).toBe(true);
    expect(validateFixture(withText('زر موقع.مثال الان')).some((p) => p.includes('domain'))).toBe(true);
    expect(validateFixture(withText('اتصل بي على +٤٤ ٧٧٠٠ ٩٠٠١٢٣'))).toEqual([]);
  });

  it('validateFixture applies the held-out reserved-number check to every run of seven or more digits', () => {
    const base = {
      description: 'x',
      synthetic: true,
      account: 'intake',
      businessUserId: OWNER,
      businessConnectionId: CONNECTION,
      updates: [incoming(900_000_001)],
    };
    const phoneProblems = (text: string) =>
      validateFixture({ ...base, updates: [incoming(900_000_001, { text })] }).filter((p) => p.includes('phone'));
    // Outside the reserved ranges: a seven-digit local number, and a UK mobile split by an invisible direction mark.
    expect(phoneProblems('call 555-0277 today')).not.toEqual([]);
    expect(phoneProblems('call 07911\u200e123456 today')).not.toEqual([]);
    // Reserved numbers in layouts the held-out check accepts, including the 00 prefix.
    expect(phoneProblems('call 0044 7700 900123 or (312) 555-0188 today')).toEqual([]);
  });

  it('validateFixture reports structurally invalid fixtures instead of trusting them', () => {
    const base = {
      description: 'x',
      synthetic: true,
      account: 'intake',
      businessUserId: OWNER,
      businessConnectionId: CONNECTION,
      updates: [incoming(900_000_001)],
    };
    const { message_id: _omit, ...noId } = message();
    const { date: _omitDate, ...noDate } = message();
    expect(validateFixture({ ...base, updates: [{ update_id: 1, business_message: noId }] }).join(' | ')).toContain('message_id');
    expect(validateFixture({ ...base, updates: [{ update_id: 1, business_message: noDate }] }).join(' | ')).toContain('date');
    expect(validateFixture({ ...base, conversationStarts: 'nope' }).join(' | ')).toContain('conversationStarts');
    expect(validateFixture({ ...base, conversationStarts: [{ chatId: 1 }] }).join(' | ')).toContain('conversationStarts');
  });
});
