/**
 * Pure state modules of the reference dashboard (src/dashboard/js/state/): composer, inbox grouping and the timeline
 * merge. The dashboard holds no case rules; these modules only decide what to show and which request a click makes.
 */
import { describe, expect, it } from 'vitest';
import type { CaseAction, ChatSummary, Finding, Message, MessageEvent } from '../../src/contract/schemas.ts';
import {
  canCompose,
  canInsertAcknowledgement,
  initialComposer,
  updateComposer,
} from '../../src/dashboard/js/state/composer.js';
import { groupInbox } from '../../src/dashboard/js/state/inbox.js';
import { chatHref, parseRoute, tokenFromFragment } from '../../src/dashboard/js/state/route.js';
import { latestIncomingMessageId, timelineEntries } from '../../src/dashboard/js/state/timeline.js';

const AT = '2026-11-21T08:00:00.000Z';
const OFFICER_A = { id: 'prn_officer_a', displayName: 'Demo Officer 1' };
const OFFICER_B = { id: 'prn_officer_b', displayName: 'Demo Officer 2' };

function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'chat_1',
    source: 'telegram',
    channelLabel: 'Telegram',
    externalAccountId: 'tg-intake-1',
    externalChatId: '1001',
    displayLabel: 'Test Contact',
    inboxStatus: 'open',
    aiMode: 'not_started',
    revision: 1,
    controller: null,
    originLabel: 'First observed: incoming',
    initiatedBy: 'unknown',
    initiationBasis: null,
    firstObservedDirection: 'incoming',
    intakeAccount: false,
    acknowledgementTemplate: null,
    review: { state: 'idle', pending: 0, unavailable: 0 },
    watchlistMatches: [],
    messageCount: 1,
    lastActivityAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

/** An intake-account chat that officer A has taken over. */
const intakeChatUnderA = (): ChatSummary =>
  chatSummary({
    aiMode: 'officer_control',
    controller: OFFICER_A,
    revision: 3,
    intakeAccount: true,
    acknowledgementTemplate: 'Message received.',
  });

/** A named object, not an inline literal, so it fits Message['sender'] both with and without its newer phone field. */
const CONTACT_SENDER = { externalId: 'tg-user-1', displayName: 'Test Contact', phone: null };

function message(id: string, position: number, direction: 'incoming' | 'outgoing' = 'incoming'): Message {
  return {
    id,
    chatId: 'chat_1',
    direction,
    origin: 'source',
    text: 'Hello, is anyone there?',
    originalCaptured: true,
    unsupportedContent: [],
    sentAt: null,
    receivedAt: AT,
    source: { channel: 'telegram', captureMethod: 'fixture_replay', sourceEventId: `tg:u${position}:m${position}`, sourceMessageId: `tg:${position}` },
    sender: CONTACT_SENDER,
    author: null,
    sendStatus: null,
    sendStatusLabel: null,
    capture: null,
    review: null,
    editedAtSource: false,
    deletedAtSource: false,
    position,
  };
}

function messageEvent(id: string, messageId: string, position: number): MessageEvent {
  return {
    id,
    chatId: 'chat_1',
    messageId,
    type: 'edited',
    text: 'Hello, is anyone there? (edited)',
    sourceEventId: `tg:u${position}:m1:e${position}`,
    sourceOccurredAt: null,
    receivedAt: AT,
    captureMethod: 'fixture_replay',
    capture: null,
    review: null,
    position,
  };
}

function caseAction(id: string, position: number): CaseAction {
  return {
    id,
    chatId: 'chat_1',
    type: 'control_take_over',
    actor: OFFICER_A,
    messageId: null,
    fromMode: 'not_started',
    toMode: 'officer_control',
    revision: 2,
    detail: null,
    occurredAt: AT,
    position,
  };
}

function finding(id: string, messageId: string, position: number): Finding {
  return {
    id,
    chatId: 'chat_1',
    messageId,
    messageEventId: 'mev_1',
    kind: 'payment_link',
    label: 'New payment link',
    quote: 'pay at https://pay.example.test/invoice',
    extractedValue: 'https://pay.example.test/invoice',
    concern: null,
    changedFrom: null,
    caseReferenceId: null,
    note: 'New payment link in a message from the contact.',
    createdAt: AT,
    position,
  };
}

describe('composer state', () => {
  it('inserting the acknowledgement fills the composer and creates no request', () => {
    const chat = intakeChatUnderA();
    const blank = initialComposer();
    expect(blank.text).toBe('');
    expect(canInsertAcknowledgement(chat)).toBe(true);

    const inserted = updateComposer(blank, { type: 'insert_acknowledgement', chat });
    expect(inserted.state.text).toBe('Message received.');
    expect(inserted.request).toBeNull();

    // The text stays editable, and only the explicit Send produces the one request.
    const edited = updateComposer(inserted.state, { type: 'edit', text: 'Message received. Thank you.' });
    expect(edited.request).toBeNull();
    const sent = updateComposer(edited.state, { type: 'send', chat, me: OFFICER_A, newKey: 'key-1' });
    expect(sent.request).toEqual({
      chatId: chat.id,
      text: 'Message received. Thank you.',
      expectedRevision: 3,
      idempotencyKey: 'key-1',
    });

    // An account that is not an intake account offers no acknowledgement, and inserting changes nothing.
    const officerAccountChat = chatSummary({ aiMode: 'officer_control', controller: OFFICER_A });
    expect(canInsertAcknowledgement(officerAccountChat)).toBe(false);
    const unchanged = updateComposer(blank, { type: 'insert_acknowledgement', chat: officerAccountChat });
    expect(unchanged).toEqual({ state: blank, request: null });
  });

  it('the composer is offered only to the controlling officer', () => {
    const underA = intakeChatUnderA();
    expect(canCompose(underA, OFFICER_A)).toBe(true);
    expect(canCompose(underA, OFFICER_B)).toBe(false);
    expect(canCompose(underA, null)).toBe(false);
    expect(canCompose(chatSummary({ aiMode: 'paused' }), OFFICER_A)).toBe(false);
    expect(canCompose(chatSummary({ aiMode: 'ai_active' }), OFFICER_A)).toBe(false);
    expect(canCompose(chatSummary({ aiMode: 'not_started' }), OFFICER_A)).toBe(false);

    // A send attempted by anyone else, or with a blank composer, makes no request.
    const typed = updateComposer(initialComposer(), { type: 'edit', text: 'Thank you, we are looking into it.' }).state;
    expect(updateComposer(typed, { type: 'send', chat: underA, me: OFFICER_B, newKey: 'key-2' }).request).toBeNull();
    expect(updateComposer(typed, { type: 'send', chat: chatSummary({ aiMode: 'paused' }), me: OFFICER_A, newKey: 'key-3' }).request).toBeNull();
    const blankSend = updateComposer(initialComposer(), { type: 'send', chat: underA, me: OFFICER_A, newKey: 'key-4' });
    expect(blankSend.request).toBeNull();
  });

  it('a retried send reuses its idempotency key until the send succeeds', () => {
    const chat = intakeChatUnderA();
    const typed = updateComposer(initialComposer(), { type: 'edit', text: 'We are checking.' }).state;
    const first = updateComposer(typed, { type: 'send', chat, me: OFFICER_A, newKey: 'key-1' });
    expect(first.state.sending).toBe(true);
    // A second click while the first is in flight sends nothing.
    expect(updateComposer(first.state, { type: 'send', chat, me: OFFICER_A, newKey: 'key-2' }).request).toBeNull();

    const failed = updateComposer(first.state, { type: 'send_failed' }).state;
    expect(failed.text).toBe('We are checking.');
    const retry = updateComposer(failed, { type: 'send', chat, me: OFFICER_A, newKey: 'key-3' });
    expect(retry.request?.idempotencyKey).toBe('key-1');

    const done = updateComposer(retry.state, { type: 'send_succeeded' }).state;
    expect(done).toEqual(initialComposer());
  });
});

describe('inbox grouping', () => {
  it('inbox grouping puts new_inbound chats in the New inbound queue', () => {
    const chats = [
      chatSummary({ id: 'chat_open_older', inboxStatus: 'open', lastActivityAt: '2026-11-21T08:00:00.000Z' }),
      chatSummary({ id: 'chat_new_older', inboxStatus: 'new_inbound', lastActivityAt: '2026-11-21T08:01:00.000Z' }),
      chatSummary({ id: 'chat_open_newer', inboxStatus: 'open', lastActivityAt: '2026-11-21T08:03:00.000Z' }),
      chatSummary({ id: 'chat_new_newer', inboxStatus: 'new_inbound', lastActivityAt: '2026-11-21T08:02:00.000Z' }),
    ];
    const before = chats.map((chat) => chat.id);

    const groups = groupInbox(chats);

    expect(groups.newInbound.map((chat) => chat.id)).toEqual(['chat_new_newer', 'chat_new_older']);
    expect(groups.open.map((chat) => chat.id)).toEqual(['chat_open_newer', 'chat_open_older']);
    expect(chats.map((chat) => chat.id)).toEqual(before);
  });
});

describe('timeline merge', () => {
  it('timeline entries from all arrays sort by position', () => {
    const timeline = {
      messages: [message('msg_2', 14), message('msg_1', 10)],
      messageEvents: [messageEvent('mev_2', 'msg_1', 13)],
      caseActions: [caseAction('act_2', 15), caseAction('act_1', 11)],
      findings: [finding('fnd_1', 'msg_1', 12)],
    };

    const entries = timelineEntries(timeline);

    expect(entries.map((entry) => `${entry.kind}:${entry.id}:${entry.position}`)).toEqual([
      'message:msg_1:10',
      'case_action:act_1:11',
      'finding:fnd_1:12',
      'message_event:mev_2:13',
      'message:msg_2:14',
      'case_action:act_2:15',
    ]);
    expect(entries[0]?.item).toBe(timeline.messages[1]);
    expect(timeline.messages.map((m) => m.id)).toEqual(['msg_2', 'msg_1']);
  });

  it('the newest incoming source message is the default target for Leave unanswered', () => {
    const composerReply: Message = { ...message('msg_3', 30, 'outgoing'), origin: 'officer_composer' };
    const timeline = { messages: [message('msg_1', 10), message('msg_2', 20), composerReply, message('msg_0', 5, 'outgoing')] };
    expect(latestIncomingMessageId(timeline)).toBe('msg_2');
    expect(latestIncomingMessageId({ messages: [composerReply] })).toBeNull();
  });
});

describe('URL fragment', () => {
  it('a #token= fragment yields its decoded, trimmed token; anything else yields none', () => {
    expect(tokenFromFragment('#token=abc123')).toBe('abc123');
    expect(tokenFromFragment('#token=%20abc%2B123%20')).toBe('abc+123');
    expect(tokenFromFragment('#token=')).toBeNull();
    expect(tokenFromFragment('#token=%20%20')).toBeNull();
    expect(tokenFromFragment('#token=%E0%A4%A')).toBeNull();
    expect(tokenFromFragment('#/chats/chat_1')).toBeNull();
    expect(tokenFromFragment('#/token=abc')).toBeNull();
    expect(tokenFromFragment('')).toBeNull();
  });

  it('routes parse to the inbox, a chat, a message in a chat or the watchlist, and a token fragment is never a route', () => {
    const inbox = { view: 'inbox', chatId: null, messageId: null };
    expect(parseRoute('')).toEqual(inbox);
    expect(parseRoute('#/')).toEqual(inbox);
    expect(parseRoute('#/unknown/place')).toEqual(inbox);
    expect(parseRoute('#/chats')).toEqual(inbox);
    expect(parseRoute('#/watchlist')).toEqual({ view: 'watchlist', chatId: null, messageId: null });
    expect(parseRoute('#/chats/chat_1')).toEqual({ view: 'inbox', chatId: 'chat_1', messageId: null });
    expect(parseRoute('#/chats/chat_1/messages/msg_1')).toEqual({ view: 'inbox', chatId: 'chat_1', messageId: 'msg_1' });
    expect(parseRoute('#chats/chat_1/')).toEqual({ view: 'inbox', chatId: 'chat_1', messageId: null });
    // A malformed escape anywhere sends the officer to the inbox rather than to a guessed chat.
    expect(parseRoute('#/chats/%E0%A4%A')).toEqual(inbox);
    expect(parseRoute('#token=abc123')).toEqual(inbox);
  });

  it('chat links round-trip through the route parser, with IDs escaped', () => {
    expect(chatHref('chat_1')).toBe('#/chats/chat_1');
    expect(chatHref('chat/1', 'msg 1')).toBe('#/chats/chat%2F1/messages/msg%201');
    expect(parseRoute(chatHref('chat/1', 'msg 1'))).toEqual({ view: 'inbox', chatId: 'chat/1', messageId: 'msg 1' });
  });
});
