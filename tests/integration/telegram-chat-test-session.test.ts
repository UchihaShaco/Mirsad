import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import type { ReplyGenerator } from '../../src/replies/reply-generator.ts';
import { currentTestMessageIds, readChatTestBoundary, readChatTestWindow, startFreshChatTest } from '../../src/services/chat-test-session.ts';
import { eraseChatHistory } from '../../src/services/chat-erasure.ts';
import { findPrincipalById, toPrincipal } from '../../src/storage/repos/principals.ts';
import { readDispatchBrief } from '../../src/services/dispatch.ts';
import { Harness, incoming, LIVE_BASE_ENV, standIns, WAIT } from '../helpers/telegram-live-harness.ts';

it('discards a held model draft after a permanent erase and gives the next draft only new messages', async () => {
  const contact = 6000000874;
  const stand = standIns();
  const spy = vi.spyOn(stand.generator as ReplyGenerator, 'generate');
  const h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' }, stand);
  const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE), { clock: stand.clock });
  try {
    stand.generator.holdNext();
    await h.receive(contact, 'I am selling a synthetic garden chair.');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), WAIT);
    const chat = (await h.chatFor(contact))!;
    const id = (await h.call('GET', '/v1/me')).data.principal.id;
    db.transaction(tx => eraseChatHistory(tx, toPrincipal(findPrincipalById(tx, id)!), chat.id, chat.revision));
    stand.generator.releaseHeld();
    await h.app.drain();
    expect(stand.sender.sent).toHaveLength(0);
    expect(await h.chatFor(contact)).toBeUndefined();
    stand.clock.advance(2_000);
    await h.receive(contact, 'Can you tell me more?');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(spy.mock.calls[1]![0]).toEqual([{ from: 'contact', text: 'Can you tell me more?' }]);
    expect(spy.mock.calls[1]![4]).toBeUndefined();
  } finally {
    stand.generator.releaseHeld();
    db.close();
    await h.stop();
  }
});

it('archives a pending draft and excludes old offers and delayed older updates from the next test', async () => {
  const contact = 6000000871;
  const stand = standIns();
  const spy = vi.spyOn(stand.generator as ReplyGenerator, 'generate');
  const h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: String(contact), TELEGRAM_AI_AUTO_START: 'true' }, stand);
  const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE), { clock: stand.clock });
  try {
    const before = stand.clock.now().getTime();
    const delayed = incoming(contact, 'I also sell discarded sample desks.', before);
    stand.generator.holdNext();
    await h.receive(contact, 'I am selling a synthetic desk lamp.');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), WAIT);
    const chat = (await h.chatFor(contact))!;
    const officerId = (await h.call('GET', '/v1/me')).data.principal.id;
    db.transaction(tx => {
      expect(readChatTestBoundary(tx, chat.id)).toBe(0);
      tx.run('INSERT INTO dispatch_briefs(chat_id,context,recorded_by,updated_at) VALUES (?,?,?,?)',
        [chat.id, 'Synthetic earlier offer', officerId, tx.now()]);
      const cutoff = startFreshChatTest(tx, chat.id, officerId);
      expect(readChatTestBoundary(tx, chat.id)).toBe(cutoff);
      expect(currentTestMessageIds(tx, chat.id, readChatTestWindow(tx, chat.id)).size).toBe(0);
      expect(readDispatchBrief(tx, chat.id)).toBeNull();
    });
    stand.generator.releaseHeld();
    await h.app.drain();
    expect(stand.sender.sent).toHaveLength(0);
    await h.deliver({ ...delayed, update_id: incoming(contact, '', before).update_id });
    stand.clock.advance(3_000);
    await h.app.drain();
    expect(spy).toHaveBeenCalledTimes(1);
    await h.receive(contact, 'Could you tell me more?');
    await vi.waitFor(() => expect(stand.sender.sent).toHaveLength(1), WAIT);
    expect(spy.mock.calls[1]![0]).toEqual([{ from: 'contact', text: 'Could you tell me more?' }]);
    expect(spy.mock.calls[1]![4]).toBeUndefined();
    expect(spy.mock.calls[1]![5]?.dispatchBrief).toBeUndefined();
    expect(db.transaction(tx => tx.get<{ n: number }>('SELECT count(*) AS n FROM messages WHERE chat_id=?', [chat.id])?.n)).toBe(4);
  } finally {
    stand.generator.releaseHeld();
    db.close();
    await h.stop();
  }
});

it('keeps the review hold, contact opt-out, and another conversation intact across a reset', async () => {
  const contact = 6000000872;
  const other = 6000000873;
  const stand = standIns();
  const h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: [contact, other].join(','), TELEGRAM_AI_AUTO_START: 'true' }, stand);
  const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE), { clock: stand.clock });
  try {
    await h.receive(other, 'Can you tell me more about the parcel?');
    await h.receive(contact, 'Pay by bank transfer to account number 000000123456.');
    await h.receive(contact, 'Never contact me again.');
    const chat = (await h.chatFor(contact))!;
    const otherChat = (await h.chatFor(other))!;
    expect(chat.telegramReplyHold.contactOptedOut).toBe(true);
    expect(chat.telegramReplyHold.officerReview).not.toBeNull();
    const officer = (await h.call('GET', '/v1/me')).data.principal.id;
    db.transaction(tx => {
      startFreshChatTest(tx, chat.id, officer);
      expect(readChatTestBoundary(tx, otherChat.id)).toBe(0);
    });
    const next = (await h.chatFor(contact))!;
    expect(next.telegramReplyHold).toEqual(chat.telegramReplyHold);
    expect(next.aiMode).toBe(chat.aiMode);
    expect(stand.sender.to(contact)).toHaveLength(0);
    expect(stand.sender.to(other)).toHaveLength(1);
  } finally {
    db.close();
    await h.stop();
  }
});
