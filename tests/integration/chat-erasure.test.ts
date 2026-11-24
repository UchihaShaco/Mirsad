import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionLiveConnector } from '../../scripts/telegram-provision.ts';
import { findLiveBindings, type LiveBinding } from '../../src/adapters/telegram/live-connector.ts';
import { loadConfig } from '../../src/config.ts';
import { IngestRequest } from '../../src/contract/schemas.ts';
import { provisionPrincipal, provisionWorkspace } from '../../src/identity/provision.ts';
import type { Principal } from '../../src/ports/identity.ts';
import { eraseChatHistory } from '../../src/services/chat-erasure.ts';
import { startFreshChatTest } from '../../src/services/chat-test-session.ts';
import { listChats } from '../../src/services/chats.ts';
import { ingest } from '../../src/services/intake.ts';
import { getTelegramReplyHold } from '../../src/services/telegram-reply-holds.ts';
import { openDatabase, type Db } from '../../src/storage/db.ts';
import { record } from '../../src/storage/repos/case-actions.ts';
import { insertEntry, insertObservation, insertReview } from '../../src/storage/repos/watchlist.ts';
import { edited, envelope, recorded } from '../helpers/events.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

const owner = '6000000511', first = '6000000512', other = '6000000513';
const config = loadConfig({ TELEGRAM_APPROVED_CHAT_IDS: first, TELEGRAM_AI_REPLY_CONSENT_REFERENCE: 'SYNTHETIC' });

describe('permanently erasing a single chat', () => {
  let db: Db, clock: FakeClock, officer: Principal, binding: LiveBinding;
  beforeEach(() => {
    clock = new FakeClock();
    db = openDatabase(':memory:', { clock });
    officer = db.transaction(tx => provisionPrincipal(tx, {
      workspaceId: provisionWorkspace(tx, { name: 'Synthetic workspace' }).id, kind: 'officer', displayName: 'Test officer',
    }).principal);
    provisionLiveConnector(db, { ownerUserId: owner, officers: ['Test officer'] });
    binding = db.transaction(tx => findLiveBindings(tx))[0]!;
  });
  afterEach(() => db.close());
  function send(chatId: string, event: Record<string, unknown>) {
    const body = IngestRequest.parse(envelope({ source:'telegram', externalAccountId:owner }, chatId, event));
    return db.transaction(tx => ingest(tx, binding.principal, body, body.event, config));
  }
  function message(chat: string, n: number, text = 'Synthetic message', label = 'Original sender') {
    return send(chat, recorded({messageId:n,text,sentAt:clock.now().toISOString(),sender:{externalId:chat,displayName:label}}));
  }
  const query = { limit:100, offset:0 };

  it('erases all test sessions and artifacts, fences replays, and reopens only on a new incoming message', () => {
    const one = message(first, 1), two = message(other, 1);
    const eraseId = one.chatId;
    db.transaction(tx => startFreshChatTest(tx,eraseId,officer.id));
    clock.advance(1000);
    message(first, 2);
    db.transaction(tx => {
      tx.run('INSERT INTO dispatch_briefs VALUES (?,?,?,?)', [eraseId,'Synthetic brief',officer.id,tx.now()]);
      tx.run('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?,?)',
        [officer.id,'officer-message:' + eraseId,'sample','digest',201,'{"data":{"text":"Synthetic old text"}}',tx.now()]);
      const { revision } = eraseChatHistory(tx,officer,eraseId,2);
      expect(revision).toBe(3);
      for (const table of ['messages','message_events','artifacts','captures','findings','case_references','case_details',
        'reviews','dispatch_briefs','telegram_evidence_sources','telegram_dispatch_contacts']) {
        expect(tx.get(`SELECT 1 FROM ${table} WHERE chat_id=?`, [eraseId])).toBeUndefined();
      }
      expect(tx.get('SELECT count(*) AS n FROM erased_evidence_files WHERE chat_id=?',[eraseId])).toEqual({n:2});
      expect(tx.get('SELECT status_code,request_sha256,response_body FROM idempotency_keys WHERE key=?',['sample'])).toEqual({
        status_code:410,request_sha256:'',response_body:expect.not.stringContaining('Synthetic old text'),
      });
      expect(tx.all('SELECT type FROM case_actions WHERE chat_id=?',[eraseId])).toEqual([{type:'chat_test_started'}]);
      expect(tx.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(listChats(tx,officer,query).chats.map(c=>c.id)).toEqual([two.chatId]);
    });
    expect(() => message(first,2)).toThrow(/erased/);
    expect(() => send(first,edited({messageId:9,updateId:3001,text:'Old edit',direction:'incoming'}))).toThrow(/erased/);
    clock.advance(1000);
    send(first,recorded({messageId:8,direction:'outgoing',sentAt:clock.now().toISOString()}));
    expect(db.transaction(tx=>listChats(tx,officer,query).total)).toBe(1);
    message(first,9,'Fresh start','Fresh label');
    db.transaction(tx => {
      const visible = listChats(tx,officer,query);
      expect(visible.total).toBe(2);
      expect(visible.chats.find(c=>c.id===eraseId)).toMatchObject({messageCount:2,displayLabel:'Fresh label',previousLowerConcern:null});
      expect(tx.all('PRAGMA foreign_key_check')).toEqual([]);
    });
  });
  it('preserves a contact STOP and converts an unresolved evidence hold into a pause, without source details', () => {
    const item = message(first,1,'Stop');
    db.transaction(tx => {
      record(tx,{chatId:item.chatId,workspaceId:officer.workspaceId,type:'telegram_officer_review_requested',
        actorId:null,messageId:item.messageId,detail:{reason:'bank_details',messageEventId:item.messageEventId,holdsReplies:true}});
      eraseChatHistory(tx,officer,item.chatId,1);
      expect(tx.get('SELECT ai_mode FROM chats WHERE id=?',[item.chatId])).toEqual({ai_mode:'paused'});
      expect(getTelegramReplyHold(tx,item.chatId)).toEqual({contactOptedOut:true,officerReview:null,evidenceItems:[]});
      expect(tx.get("SELECT message_id,detail FROM case_actions WHERE type='telegram_contact_opted_out'"))
        .toEqual({message_id:null,detail:expect.not.stringContaining('messageEventId')});
    });
  });
  it('cannot erase across a stale revision, a pending Telegram send or a revoked grant', () => {
    const {chatId} = message(first,1);
    expect(()=>db.transaction(tx=>eraseChatHistory(tx,officer,chatId,2))).toThrow(/changed/);
    db.transaction(tx=>tx.run('INSERT INTO telegram_pending_sends(chat_id,trigger_id,expires_at) VALUES (?,?,?)',[chatId,'synthetic','2099-01-01T00:00:00.000Z']));
    expect(()=>db.transaction(tx=>eraseChatHistory(tx,officer,chatId,1))).toThrow(/send is in progress/);
    db.transaction(tx=>tx.run('DELETE FROM account_grants WHERE principal_id=?',[officer.id]));
    expect(()=>db.transaction(tx=>eraseChatHistory(tx,officer,chatId,1))).toThrow(/not found/);
    expect(db.transaction(tx=>tx.get('SELECT count(*) AS n FROM messages WHERE chat_id=?',[chatId]))).toEqual({n:1});
  });
  it('removes single-chat watchlist records but preserves independent observations and decisions for a shared number', () => {
    const one = message(first,1), two = message(other,1);
    db.transaction(tx=>{
      const entry = (key:string) => insertEntry(tx,{workspaceId:officer.workspaceId,matchKey:key,e164:key,
        display:'Original representation',seenAt:tx.now()});
      const shared = entry('+447700900051'), solo = entry('+447700900052');
      const observe = (entryId:string, source:typeof one, representation:string) => insertObservation(tx,{
        entryId,workspaceId:officer.workspaceId,chatId:source.chatId,messageId:source.messageId,messageEventId:source.messageEventId!,
        findingId:null,origin:'message_mention',sourceRepresentation:representation,reason:'SYNTHETIC',observedAt:tx.now(),
      });
      observe(shared.id,one,'Erased representation');
      observe(shared.id,two,'Independent representation');
      observe(solo.id,one,'Erased representation');
      for(const item of [shared,solo]) {
        insertReview(tx,{entryId:item.id,decision:'approve',reason:'Synthetic decision',officerId:officer.id,
          fromStatus:'needs_review',toStatus:'approved',revision:2});
        tx.run("UPDATE watchlist_entries SET status='approved' WHERE id=?",[item.id]);
      }
      eraseChatHistory(tx,officer,one.chatId,1);
      expect(tx.get('SELECT 1 FROM watchlist_entries WHERE id=?',[solo.id])).toBeUndefined();
      expect(tx.get('SELECT 1 FROM watchlist_reviews WHERE entry_id=?',[solo.id])).toBeUndefined();
      expect(tx.all('SELECT chat_id FROM watchlist_observations WHERE entry_id=?',[shared.id])).toEqual([{chat_id:two.chatId}]);
      expect(tx.get('SELECT status,display FROM watchlist_entries WHERE id=?',[shared.id])).toEqual({
        status:'approved',display:'Independent representation',
      });
      expect(tx.get('SELECT reason FROM watchlist_reviews WHERE entry_id=?',[shared.id])).toEqual({reason:'Synthetic decision'});
    });
  });
});
