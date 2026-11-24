import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApiError } from '../../src/adapters/telegram/bot-api.ts';
import { findLiveBindings } from '../../src/adapters/telegram/live-connector.ts';
import { ingest } from '../../src/services/intake.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { CONNECTION_ID, deletion, Harness, incoming, type Json, LIVE_BASE_ENV, standIns } from '../helpers/telegram-live-harness.ts';

const a = 99101011;
const b = 99101012;
const inbox = '/v1/inbox';

describe('confirmed Telegram deletion on stand-in transports', () => {
  let h: Harness;
  let calls: number[][];
  let rights: Record<string, boolean>;
  let fail: 'timeout' | 'refused' | undefined;
  let transportGate: Promise<void> | undefined;
  beforeEach(async () => {
    const stand = standIns(); calls = []; rights = { can_delete_all_messages: true }; fail = undefined; transportGate = undefined;
    stand.eraser = {
      getBusinessConnection: async () => ({ ...await stand.api.getBusinessConnection(), rights }),
      async deleteBusinessMessages(connection, ids) {
        expect(connection).toBe(CONNECTION_ID); calls.push(ids);
        if (transportGate) await transportGate;
        if (fail === 'timeout') throw new BotApiError('deleteBusinessMessages', 'timeout');
        if (fail === 'refused') throw new BotApiError('deleteBusinessMessages', 'api_error', 403);
        return true;
      },
    };
    h = await Harness.start({ ...LIVE_BASE_ENV, TELEGRAM_APPROVED_CHAT_IDS: `${a},${b}`, TELEGRAM_AI_REPLIES_ENABLED: 'false' }, stand);
  });
  afterEach(async () => { await h.stop(); });
  const snapshot = async (scope: string) => (await h.call('GET', scope + '/erase-preview')).data.snapshot as string;
  const confirm = (scope: string, hash: string, key: string) => h.call('POST', scope + '/erase-telegram',
    { expectedSnapshot: hash, confirm: true }, { 'Idempotency-Key': key });
  const msg = (chat: number, hoursAgo = 0) => incoming(chat, 'Test message', h.stand.clock.now().getTime() - hoursAgo * 3600_000);

  it('keeps batches within one chat, excludes old messages, counts known deletions, and replays without a network action', async () => {
    const recent = msg(a), old = msg(a, 48), gone = msg(b), second = msg(b);
    await h.deliver(recent, old, gone, second);
    await h.deliver(deletion(b, [(gone.business_message as Json).message_id]));
    const s = await snapshot(inbox);
    const res = (await confirm(inbox, s, 'batch')).data;
    expect(res).toMatchObject({ status: 'completed', total: 4, removed: 3, skipped: 1, pending: 0, excluded: { expired: 1 },
      remainingChats: [{ chatId: (await h.chatFor(a))?.id, skipped: 1 }] });
    expect(calls.map(ids => ids[0]).sort()).toEqual([(recent.business_message as Json).message_id, (second.business_message as Json).message_id].sort());
    expect(calls.every(batch => batch.length === 1)).toBe(true);
    expect((await confirm(inbox, s, 'batch')).data).toEqual(res);
    expect((await confirm(inbox, s, 'new-key')).data).toEqual(res);
    expect(calls).toHaveLength(2);
    expect((await h.timelineOf(a)).messages).toHaveLength(2);
  });

  it('requires fresh confirmation, honors incoming delete rights and never repeats an uncertain action', async () => {
    await h.deliver(msg(a));
    const prefix = `/v1/chats/${(await h.chatFor(a))?.id}`;
    const stale = await snapshot(prefix);
    await h.deliver(msg(a));
    expect((await confirm(prefix, stale, 'stale')).error?.code).toBe('revision_conflict');
    const s = await snapshot(prefix);
    expect((await h.call('POST', prefix + '/erase-telegram', { expectedSnapshot: s, confirm: false }, { 'Idempotency-Key': 'none' })).error?.code).toBe('validation_failed');
    rights = { can_delete_sent_messages: true };
    expect((await confirm(prefix, s, 'rights')).data).toMatchObject({ skipped: 2, excluded: { rights: 2 } });
    expect(calls).toHaveLength(0);
    rights = { can_delete_all_messages: true }; fail = 'timeout';
    expect((await confirm(prefix, s, 'network')).data).toMatchObject({ removed: 0, uncertain: 2, failed: 0 });
    expect((await confirm(prefix, s, 'new-request')).data).toMatchObject({ uncertain: 2 });
    expect(calls).toHaveLength(1);
  });

  it('attributes a definite Telegram refusal to the affected conversation', async () => {
    await h.deliver(msg(a)); fail = 'refused';
    const s = await snapshot(inbox);
    const result = (await confirm(inbox, s, 'refusal')).data;
    expect(result).toMatchObject({ total: 1, failed: 1, removed: 0, uncertain: 0, remainingChats: [{ failed: 1 }] });
    fail = undefined;
    expect((await confirm(inbox, s, 'refusal')).data).toEqual(result);
    expect((await confirm(inbox, s, 'explicit-new-confirmation')).data).toMatchObject({ removed: 1, failed: 0 });
  });

  it('never promotes a normalized HTTP-like record to a target for deletion', async () => {
    const db = openDatabase(path.join(h.data.dataDir, DATABASE_FILE));
    try {
      db.transaction(tx => {
        const binding = findLiveBindings(tx)[0]!;
        ingest(tx, binding.principal, { source: 'telegram', externalAccountId: binding.account.external_account_id, externalChatId: String(a) },
          { type:'message.recorded', sourceMessageId:'tg:999',sourceEventId:'tg:u1200:m999',direction:'incoming', sentAt:tx.now(),text:'Test' }, h.app.config);
      });
      const res = (await confirm(inbox, await snapshot(inbox), 'unverified')).data;
      expect(res).toMatchObject({ total: 1, removed: 0, skipped: 1, excluded: { unverified: 1 } });
      expect(calls).toHaveLength(0);
    } finally { db.close(); }
  });

  it('rejects message number reuse across chats even after the other chat is erased locally', async () => {
    const first = msg(a), other = msg(b);
    (other.business_message as Json).message_id = (first.business_message as Json).message_id;
    await h.deliver(first, other);
    const prior = `/v1/chats/${(await h.chatFor(a))?.id}`;
    const local = await h.call('POST', prior+'/erase', { expectedSnapshot: await snapshot(prior), confirm: true }, { 'Idempotency-Key': 'local' });
    expect(local.success).toBe(true);
    expect((await confirm(inbox, await snapshot(inbox), 'collision')).data).toMatchObject({ total: 1, removed: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
  });

  it('reserves a remote write before transport and never dispatches it twice across concurrent requests', async () => {
    await h.deliver(msg(a));
    const s = await snapshot(inbox);
    let release!: () => void;
    transportGate = new Promise(resolve => { release = resolve; });
    const first = confirm(inbox, s, 'running');
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect((await confirm(inbox, s, 'running')).data).toMatchObject({ status: 'in_progress' });
      expect((await confirm(inbox, s, 'new')).data).toMatchObject({ status: 'completed', uncertain: 1 });
    } finally { release(); }
    expect((await first).data).toMatchObject({ status: 'completed', removed: 1 });
    expect(calls).toHaveLength(1);
  });
});
