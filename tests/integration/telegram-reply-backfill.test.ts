import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLiveBindings, type LiveBinding } from '../../src/adapters/telegram/live-connector.ts';
import { loadConfig } from '../../src/config.ts';
import { IngestRequest } from '../../src/contract/schemas.ts';
import { ingest } from '../../src/services/intake.ts';
import { backfillTelegramReplyHolds, getTelegramReplyHold, isTelegramReplyHeld } from '../../src/services/telegram-reply-holds.ts';
import { DATABASE_FILE, openDatabase, type Db } from '../../src/storage/db.ts';
import { record } from '../../src/storage/repos/case-actions.ts';
import { envelope, recorded } from '../helpers/events.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { OWNER_ID, provisionDataDir } from '../helpers/telegram-live-harness.ts';

const contact = '6000000803';
const freshMs = 15 * 60_000;
const account = { source: 'telegram' as const, externalAccountId: String(OWNER_ID) };

describe('legacy Telegram reply consent and targeted review resolution', () => {
  let dir: string;
  let db: Db;
  let clock: FakeClock;
  let binding: LiveBinding;
  let nextId = 100;
  beforeEach(() => {
    dir = provisionDataDir().dataDir;
    clock = new FakeClock();
    db = openDatabase(path.join(dir, DATABASE_FILE), { clock });
    binding = db.transaction(tx => findLiveBindings(tx))[0]!;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function submit(text: string, media?: string[], direction: 'incoming' | 'outgoing' = 'incoming', enrolled = false) {
    const event = recorded({ messageId: nextId++, text, unsupportedContent: media, direction,
      sender: { externalId: direction === 'incoming' ? contact : String(OWNER_ID) } });
    const { event: parsed, ...target } = IngestRequest.parse(envelope(account, contact, event));
    const settings = { TELEGRAM_CHAT_SCOPE: 'all_private', TELEGRAM_ALL_CHATS_REFERENCE: 'TEST-INTAKE',
      TELEGRAM_APPROVED_CHAT_IDS: enrolled ? contact : '', TELEGRAM_AI_REPLY_CONSENT_REFERENCE: enrolled ? 'TEST-CONSENT' : '' };
    return db.transaction(tx => ingest(tx, binding.principal, target, parsed, loadConfig(settings)));
  }
  function backfill(ids: string[] = [contact]) {
    db.transaction(tx => backfillTelegramReplyHolds(tx, binding.account.id, ids, freshMs, binding.principal.id));
  }

  it('honors opt-out received while temporarily unenrolled without flagging evidence from that period', () => {
    const { chatId } = submit('A first message.', [], 'incoming', true);
    backfill();
    submit('Stop messaging me');
    submit('The pickup is at 12 Example Road.', ['document']);
    submit('Hello again', [], 'incoming', true);
    backfill();
    expect(db.transaction(tx => getTelegramReplyHold(tx, chatId))).toEqual({ contactOptedOut: true, officerReview: null, evidenceItems: [] });
  });

  it('does not retrospectively flag a fresh document received before a chat’s first enrollment', () => {
    const { chatId } = submit('Private document', ['document']);
    backfill();
    expect(db.transaction(tx => getTelegramReplyHold(tx, chatId))).toEqual({ contactOptedOut: false, officerReview: null, evidenceItems: [] });
  });

  it('leaves evidence from an already answered exchange in the existing case record', () => {
    const { chatId } = submit('', ['document']);
    submit('Received', [], 'outgoing');
    backfill();
    expect(db.transaction(tx => getTelegramReplyHold(tx, chatId))).toEqual({ contactOptedOut: false, officerReview: null, evidenceItems: [] });
  });

  it('reopens an old-version saved Stop only on a new original invitation, without making older messages eligible', () => {
    const stop = submit('Stop');
    db.transaction(tx => tx.run(`UPDATE case_actions SET detail=json_remove(detail,'$.emphatic') WHERE chat_id=:chatId
      AND type='telegram_contact_opted_out'`, {chatId: stop.chatId}));
    const earlier = submit('Hi');
    clock.advance(60_000);
    backfill();
    expect(db.transaction(tx => getTelegramReplyHold(tx, stop.chatId)).contactOptedOut).toBe(true);
    const original = recorded({messageId: nextId++, text: 'Hi again', sentAt: clock.now().toISOString(), sender:{externalId:contact}});
    const {event, ...target} = IngestRequest.parse(envelope(account, contact, original));
    const settings = loadConfig({TELEGRAM_APPROVED_CHAT_IDS:contact, TELEGRAM_AI_REPLY_CONSENT_REFERENCE:'TEST-CONSENT'});
    const invitation = db.transaction(tx => ingest(tx, binding.principal, target, event, settings));
    const held = (id: string | null) => db.transaction(tx => {
      const message = tx.get<{position:number}>('SELECT position FROM messages WHERE id=:id', {id});
      return isTelegramReplyHeld(tx, stop.chatId, message!.position);
    });
    expect(held(earlier.messageId)).toBe(true);
    expect(held(invitation.messageId)).toBe(false);
  });

  it('honors old opt-outs on first enrollment, skips stale evidence, and never resurrects resolved items on restart', () => {
    const { chatId } = submit('STOP');
    submit('Old handover', ['document']);
    clock.advance(freshMs + 1000);
    const doc = submit('', ['document']);
    const pin = submit('', ['venue']);
    submit('Hello again');
    // These rows predate the feature. Keep the original events and remove current-version hold materialization.
    db.transaction(tx => {
      tx.run("DELETE FROM case_actions WHERE chat_id = :chatId AND type = 'telegram_contact_opted_out'", { chatId });
      tx.run("DELETE FROM connector_state WHERE connector_id = :connectorId AND key = 'telegram_reply_hold_intake_start'", { connectorId: binding.principal.id });
    });
    expect(db.transaction(tx => isTelegramReplyHeld(tx, chatId))).toBe(false);
    backfill(['6000000999']);
    expect(db.transaction(tx => isTelegramReplyHeld(tx, chatId))).toBe(false);
    backfill();
    const first = db.transaction(tx => getTelegramReplyHold(tx, chatId));
    expect(first).toMatchObject({ contactOptedOut: true, officerReview: null,
      evidenceItems: [{ messageId: doc.messageId, reason: 'document' }, { messageId: pin.messageId, reason: 'location' }] });
    const resolve = (id: string) => db.transaction(tx => record(tx, { chatId, workspaceId: binding.account.workspace_id,
      type: 'telegram_officer_review_resolved', actorId: null, detail: { reviewActionId: id } }));
    resolve(first.evidenceItems[0]!.actionId);
    const second = db.transaction(tx => getTelegramReplyHold(tx, chatId));
    expect(second).toMatchObject({ contactOptedOut: true, officerReview: null, evidenceItems: [{ messageId: pin.messageId, reason: 'location' }] });
    resolve(second.evidenceItems[0]!.actionId);
    db.close();
    db = openDatabase(path.join(dir, DATABASE_FILE), { clock });
    backfill();
    expect(db.transaction(tx => getTelegramReplyHold(tx, chatId))).toEqual({ contactOptedOut: true, officerReview: null, evidenceItems: [] });
    const counts = db.transaction(tx => tx.all<{ type: string; n: number }>(
      "SELECT type, COUNT(*) AS n FROM case_actions WHERE chat_id = :chatId GROUP BY type ORDER BY type", { chatId }));
    expect(counts).toEqual([
      { type: 'telegram_contact_opted_out', n: 1 },
      { type: 'telegram_officer_review_requested', n: 2 },
      { type: 'telegram_officer_review_resolved', n: 2 },
    ]);
  });

  it('shows a legacy document flag as evidence while allowing replies', () => {
    const old = submit('Existing source evidence');
    db.transaction(tx => record(tx, { chatId: old.chatId, workspaceId: binding.account.workspace_id,
      type: 'telegram_officer_review_requested', actorId: null, messageId: old.messageId,
      detail: { messageEventId: old.messageEventId, reason: 'document' } }));
    db.close();
    db = openDatabase(path.join(dir, DATABASE_FILE), { clock });
    const hold = db.transaction(tx => getTelegramReplyHold(tx, old.chatId));
    expect(hold.officerReview).toBeNull();
    expect(hold.evidenceItems).toMatchObject([{ reason: 'document', messageId: old.messageId }]);
    expect(db.transaction(tx => isTelegramReplyHeld(tx, old.chatId))).toBe(false);
  });
});
