import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionLiveConnector } from '../../scripts/telegram-provision.ts';
import { findLiveBindings, type LiveBinding } from '../../src/adapters/telegram/live-connector.ts';
import { loadConfig } from '../../src/config.ts';
import { IngestRequest } from '../../src/contract/schemas.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { startFreshChatTest } from '../../src/services/chat-test-session.ts';
import { ingest } from '../../src/services/intake.ts';
import { assessMeeting, recordLowerConcern, readLowerConcern, readPreviousLowerConcern } from '../../src/services/lower-concern.ts';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { edited, envelope, recorded } from '../helpers/events.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

const owner = '6000000441', contact = '6000000442';
const config = loadConfig({ TELEGRAM_APPROVED_CHAT_IDS: contact, TELEGRAM_AI_REPLY_CONSENT_REFERENCE: 'SYNTHETIC' });
const scope = (chatId: string) => ({ chatId, firstPosition: 1, enrolledSecond: 0, afterTelegramId: null });

describe('lower-concern case history', () => {
  let db: Db, clock: FakeClock, binding: LiveBinding, officerId: string;
  beforeEach(() => {
    clock = new FakeClock();
    db = openDatabase(':memory:', { clock });
    db.transaction(tx => {
      const workspace = provisionWorkspace(tx, { name: 'Test Workspace' });
      officerId = provisionPrincipal(tx, { workspaceId: workspace.id, kind: 'officer', displayName: 'Officer A' }).principal.id;
    });
    provisionLiveConnector(db, { ownerUserId: owner, officers: ['Officer A'] });
    binding = db.transaction(tx => findLiveBindings(tx))[0]!;
  });
  afterEach(() => db.close());

  function submit(event: Record<string, unknown>) {
    const normalized = IngestRequest.parse(envelope({ source: 'telegram', externalAccountId: owner }, contact, event));
    clock.advance(1000);
    return db.transaction(tx => ingest(tx, binding.principal, normalized, normalized.event, config));
  }
  function message(id: number, direction: 'incoming' | 'outgoing', text: string) {
    return submit(recorded({ direction, text, messageId: id, sentAt: clock.now().toISOString(),
      sender: { externalId: direction === 'incoming' ? contact : owner } }));
  }
  function arrange() {
    message(1, 'outgoing', 'Can we meet at the test station on Saturday at 5pm?');
    return message(2, 'incoming', 'Yes, that works.');
  }
  it('records verifiable sources once, preserves an assessment at reset, and keeps new tests separate', () => {
    const { chatId, messageId } = arrange();
    db.transaction(tx => {
      const found = assessMeeting(tx, scope(chatId));
      expect(found?.sources.agreement.messageId).toBe(messageId);
      expect(assessMeeting(tx, { ...scope(chatId), afterTelegramId: 1 })).toBeNull();
      recordLowerConcern(tx, chatId, found!);
      recordLowerConcern(tx, chatId, found!);
      expect(tx.get<{ n: number }>("SELECT count(*) n FROM case_actions WHERE type='lower_concern_assessed'")?.n).toBe(1);
      expect(readLowerConcern(tx, chatId)?.sources.date?.messageId).toBe(found!.sources.place.messageId);
      startFreshChatTest(tx, chatId, officerId);
      expect(readLowerConcern(tx, chatId)).toBeNull();
      expect(assessMeeting(tx, scope(chatId))).toBeNull();
      expect(readPreviousLowerConcern(tx, chatId)?.sources.agreement.messageId).toBe(messageId);
    });
    message(3, 'incoming', 'Hello again');
    expect(db.transaction(tx => assessMeeting(tx, scope(chatId)))).toBeNull();
  });
  it('retires a classification immediately if the evidence is edited or the seller adds a condition', () => {
    const { chatId } = arrange();
    db.transaction(tx => recordLowerConcern(tx, chatId, assessMeeting(tx, scope(chatId))!));
    submit(edited({ messageId: 2, updateId: 8021, text: 'Actually, I cannot meet.' }));
    expect(db.transaction(tx => readLowerConcern(tx, chatId))).toBeNull();
    expect(db.transaction(tx => assessMeeting(tx, scope(chatId)))).toBeNull();
    message(3, 'incoming', 'Pay a deposit first.');
    db.transaction(tx => {
      startFreshChatTest(tx, chatId, officerId);
      expect(readPreviousLowerConcern(tx, chatId)).toBeNull();
    });
  });
  it('holds back an active assessment for an approved watchlist match on this chat', () => {
    const { chatId } = arrange();
    db.transaction(tx => {
      recordLowerConcern(tx, chatId, assessMeeting(tx, scope(chatId))!);
      tx.run("INSERT INTO watchlist_entries(id,workspace_id,match_key,display,status,first_seen_at,last_seen_at,created_at,updated_at) VALUES ('test-entry',?,'test-key','Synthetic','approved',?,?,?,?)",
        [binding.account.workspace_id, tx.now(), tx.now(), tx.now(), tx.now()]);
      expect(readLowerConcern(tx, chatId)).not.toBeNull();
      tx.run("INSERT INTO watchlist_matches(id,workspace_id,entry_id,chat_id,matched_e164,source_representation,matched_at) VALUES ('test-match',?,'test-entry',?,'+447700900123','Synthetic',?)",
        [binding.account.workspace_id, chatId, tx.now()]);
      expect(readLowerConcern(tx, chatId)).toBeNull();
      expect(assessMeeting(tx, scope(chatId))).toBeNull();
      tx.run("UPDATE watchlist_entries SET status='cleared' WHERE id='test-entry'");
      expect(assessMeeting(tx, scope(chatId))).not.toBeNull();
      tx.run("UPDATE watchlist_entries SET status='approved' WHERE id='test-entry'");
      startFreshChatTest(tx, chatId, officerId);
      tx.run("UPDATE watchlist_entries SET status='cleared' WHERE id='test-entry'");
      expect(readPreviousLowerConcern(tx, chatId)).toBeNull();
    });
  });
});
