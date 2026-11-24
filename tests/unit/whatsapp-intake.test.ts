import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindWhatsAppDemo, ingestWhatsAppText, ingestWhatsAppWebhookText, isWhatsAppBindingActive, isWhatsAppTesterOptedOut, WhatsAppTesterOptedOutError,
} from '../../src/adapters/whatsapp/intake.ts';
import { loadConfig } from '../../src/config.ts';
import { createDemoIdentity } from '../../src/identity/demo-identity.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import { hashToken } from '../../src/identity/tokens.ts';
import { eraseChatHistory } from '../../src/services/chat-erasure.ts';
import { ingest } from '../../src/services/intake.ts';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { findPrincipalById, grantAccount, insertChannelAccount, toPrincipal } from '../../src/storage/repos/principals.ts';

const phoneNumberId = '100200300';
const peer = '12025550101';
const config = loadConfig({});
const message = { id: 'wamid.synthetic', peer, text: 'Synthetic tester message', sentAt: '2026-11-22T12:00:00.000Z', direction: 'incoming' as const };
let db: Db;
let officerId: string;
let workspaceId: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  db.transaction(tx => {
    workspaceId = provisionWorkspace(tx, { name: 'Test' }).id;
    officerId = provisionPrincipal(tx, { workspaceId, kind: 'officer', displayName: 'Test Officer' }).principal.id;
  });
});
afterEach(() => db.close());

describe('local WhatsApp demo intake', () => {
  it('preserves the officer binding across repeated setup and refuses unrelated accounts', () => {
    const binding = bindWhatsAppDemo(db, officerId, phoneNumberId);
    expect(bindWhatsAppDemo(db, officerId, phoneNumberId)).toEqual(binding);
    const other = db.transaction(tx => provisionPrincipal(tx, { workspaceId, kind: 'officer', displayName: 'Other Officer' }).principal);
    expect(() => bindWhatsAppDemo(db, other.id, phoneNumberId)).toThrow('whatsapp_binding_unavailable');
    db.transaction(tx => {
      expect(tx.get('SELECT 1 FROM account_grants WHERE principal_id=?', [other.id])).toBeUndefined();
      insertChannelAccount(tx, { workspaceId, source: 'whatsapp', externalAccountId: '321', isIntake: false, label: 'Prior import' });
    });
    expect(() => bindWhatsAppDemo(db, officerId, '321')).toThrow('whatsapp_account_already_owned');
  });

  it('records native IDs, scopes both directions, deduplicates retries and excludes live content from automated review', () => {
    const binding = bindWhatsAppDemo(db, officerId, phoneNumberId);
    // Directly inject even a misconfigured allow-list to exercise the separate review policy.
    const intakeConfig = { ...config, reviewAllowedCaptureMethods: ['whatsapp_business_live' as const] };
    const save = (input: Parameters<typeof ingestWhatsAppText>[4]) =>
      db.transaction(tx => ingestWhatsAppText(tx, binding, intakeConfig, [peer], input));
    expect(() => save({ ...message, peer: '12025550102' })).toThrow(/outside/);
    const incoming = save(message);
    expect(incoming).toMatchObject({ result: 'recorded', chatCreated: true });
    expect(save(message)).toMatchObject({ result: 'duplicate_event', messageId: incoming.messageId });
    const outgoing = save({ ...message, id: 'wamid.synthetic_reply', direction: 'outgoing', text: 'Synthetic reply' });
    expect(outgoing).toMatchObject({ result: 'recorded', chatCreated: false, chatId: incoming.chatId });
    db.transaction(tx => {
      expect(tx.get('SELECT COUNT(*) AS n FROM chats')).toEqual({ n: 1 });
      expect(tx.get('SELECT capture_method,source_message_id,sender_external_id FROM messages WHERE id=?', [incoming.messageId]))
        .toEqual({ capture_method: 'whatsapp_business_live', source_message_id: message.id, sender_external_id: peer });
      expect(tx.get('SELECT sender_external_id FROM messages WHERE id=?', [outgoing.messageId])).toEqual({ sender_external_id: phoneNumberId });
      expect(tx.all('SELECT status FROM reviews')).toEqual([{ status: 'not_permitted' }]);
      tx.run('DELETE FROM account_grants WHERE channel_account_id=? AND principal_id=?', [binding.accountId, officerId]);
      expect(isWhatsAppBindingActive(tx, binding)).toBe(false);
    });
    expect(() => save(message)).toThrow(/outside/);
    expect(() => bindWhatsAppDemo(db, officerId, phoneNumberId)).toThrow('whatsapp_binding_unavailable');
  });

  it('refuses generic intake by native or import connectors even with an account grant and enabled import', () => {
    const binding = bindWhatsAppDemo(db, officerId, phoneNumberId);
    const incoming = db.transaction(tx => ingestWhatsAppText(tx, binding, config, [peer], message));
    const event = { type: 'message.recorded' as const, direction: 'incoming' as const, sourceEventId: 'spoof', sourceMessageId: 'spoof', text: 'spoof' };
    const target = { source: 'whatsapp' as const, externalAccountId: phoneNumberId, externalChatId: peer };
    db.transaction(tx => {
      const fixture = provisionPrincipal(tx, { workspaceId, kind: 'connector', displayName: 'Test import', captureMethod: 'approved_import' }).principal;
      grantAccount(tx, fixture.id, binding.accountId);
      const local = toPrincipal(findPrincipalById(tx, binding.connectorId)!);
      for (const connector of [local, fixture]) {
        for (const destination of [target, { chatId: incoming.chatId }]) {
          expect(() => ingest(tx, connector, destination, event, { ...config, whatsappImportEnabled: true })).toThrow(/live connection|configured WhatsApp connection/);
        }
      }
      // Even a provisioner that inadvertently sets a valid bearer digest cannot expose the internal principal.
      tx.run('UPDATE principals SET token_sha256=? WHERE id=?', [hashToken('synthetic-credential'), binding.connectorId]);
      expect(tx.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 1 });
    });
    expect(createDemoIdentity(db).authenticate('Bearer synthetic-credential')).toBeNull();
  });

  it('protects a send in progress, removes its completed attempt on erase and rejects a replay of erased evidence', () => {
    const binding = bindWhatsAppDemo(db, officerId, phoneNumberId);
    const incoming = db.transaction(tx => ingestWhatsAppText(tx, binding, config, [peer], message));
    db.transaction(tx => {
      const officer = toPrincipal(findPrincipalById(tx, officerId)!);
      const { revision } = tx.get<{ revision: number }>('SELECT revision FROM chats WHERE id=?', [incoming.chatId])!;
      tx.run("INSERT INTO whatsapp_reply_attempts(message_id,state) VALUES (?,'sending')", [incoming.messageId]);
      expect(() => eraseChatHistory(tx, officer, incoming.chatId, revision)).toThrow(/send is in progress/);
      tx.run("UPDATE whatsapp_reply_attempts SET state='sent' WHERE message_id=?", [incoming.messageId]);
      eraseChatHistory(tx, officer, incoming.chatId, revision);
      expect(tx.all('SELECT * FROM whatsapp_reply_attempts')).toEqual([]);
      expect(() => ingestWhatsAppText(tx, binding, config, [peer], message)).toThrow(/erased conversation/);
      const delayed = { ...message, id: 'wamid.late-stop', text: 'STOP', sentAt: '2000-01-01T00:00:00.000Z' };
      expect(ingestWhatsAppWebhookText(tx, binding, config, [peer], delayed)).toBeNull();
      expect(isWhatsAppTesterOptedOut(tx, binding, peer)).toBe(true);
      expect(tx.all('SELECT id FROM messages')).toEqual([]);
    });
  });

  it.each([' sToP ', 'توقف'])('honors a standalone withdrawal and retains it across erasure', (text) => {
    const binding = bindWhatsAppDemo(db, officerId, phoneNumberId);
    const otherPeer = '12025550102';
    const testers = [peer, otherPeer];
    db.transaction(tx => {
      const save = (input: typeof message) => ingestWhatsAppText(tx, binding, config, testers, input);
      const previous = save({ ...message, text: 'Can we stop at noon?' });
      expect(isWhatsAppTesterOptedOut(tx, binding, peer)).toBe(false);
      const stop = save({ ...message, id: 'wamid.stop', text });
      expect(isWhatsAppTesterOptedOut(tx, binding, peer)).toBe(true);
      expect(() => save({ ...message, id: 'wamid.reopen', text: 'START' })).toThrow(WhatsAppTesterOptedOutError);
      expect(tx.get('SELECT COUNT(*) AS n FROM messages')).toEqual({ n: 2 });
      const echo = { ...message, id: 'wamid.echo', direction: 'outgoing' as const };
      expect(() => ingestWhatsAppText(tx, binding, config, testers, echo)).toThrow(WhatsAppTesterOptedOutError);
      tx.run("INSERT INTO whatsapp_reply_attempts(message_id,state) VALUES (?,'sent')", [previous.messageId]);
      expect(ingestWhatsAppText(tx, binding, config, testers, echo, previous.messageId).result).toBe('recorded');
      const { revision } = tx.get<{ revision: number }>('SELECT revision FROM chats WHERE id=?', [stop.chatId])!;
      eraseChatHistory(tx, toPrincipal(findPrincipalById(tx, officerId)!), stop.chatId, revision);
      expect(isWhatsAppTesterOptedOut(tx, binding, peer)).toBe(true);
      expect(() => save(message)).toThrow(WhatsAppTesterOptedOutError);
      expect(save({ ...message, peer: otherPeer })).toMatchObject({ result: 'recorded' });
    });
  });
});
