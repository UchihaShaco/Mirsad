/**
 * `x-workflow-example`: the five calls the headless client (examples/headless-client/run.ts) makes, with the exact
 * request payloads it sends and representative responses. All values are synthetic. A test runs the client against
 * a live service and compares every request with this list. Positions are the ones the service gives this flow in a
 * fresh workspace (chat.created 1, chat_registered 2, dispatch_started 3, chat.control_changed 4, the message 5); the
 * timeline is shown as read right after the message was stored, before the workers have run, so its cursor is 5.
 */

const CHAT_ID = 'chat_0123456789abcdef0123456789abcdef';
const MESSAGE_ID = 'msg_0123456789abcdef0123456789abcdef';
const CAPTURE_ID = 'cap_0123456789abcdef0123456789abcdef';
const OFFICER = { id: 'pri_0123456789abcdef0123456789abcdef', displayName: 'Demo Officer 1' };
const REGISTERED_AT = '2026-11-21T08:00:00.000Z';
const MESSAGE_AT = '2026-11-21T08:00:02.000Z';
const TAKEN_OVER_AT = '2026-11-21T08:00:04.000Z';

const OFFICER_AUTH = 'Bearer <officer token>';
const CONNECTOR_AUTH = 'Bearer <connector token>';

const chat = (overrides: Record<string, unknown>) => ({
  id: CHAT_ID,
  source: 'telegram',
  channelLabel: 'Telegram',
  externalAccountId: 'tg-demo-officer',
  externalChatId: 'host-conversation-1001',
  displayLabel: 'Test Contact',
  inboxStatus: 'open',
  telegramReplyHold: { contactOptedOut: false, officerReview: null, evidenceItems: [] },
  lowerConcern: null, previousLowerConcern: null, firstContact: null, suspect: null,
  aiMode: 'not_started',
  revision: 1,
  controller: null,
  originLabel: 'No messages observed',
  initiatedBy: 'unknown',
  initiationBasis: null,
  firstObservedDirection: null,
  intakeAccount: false,
  acknowledgementTemplate: null,
  review: { state: 'idle', pending: 0, unavailable: 0 },
  watchlistMatches: [],
  messageCount: 0,
  lastActivityAt: REGISTERED_AT,
  createdAt: REGISTERED_AT,
  ...overrides,
});

const envelope = (data: unknown) => ({ success: true, data, error: null });

const message = {
  id: MESSAGE_ID,
  chatId: CHAT_ID,
  direction: 'incoming',
  origin: 'source',
  text: 'Hello, is this the right number for my order?',
  originalCaptured: true,
  unsupportedContent: [],
  sentAt: null,
  receivedAt: MESSAGE_AT,
  source: { channel: 'telegram', captureMethod: 'fixture_replay', sourceEventId: 'host-event-1', sourceMessageId: 'host-message-1' },
  // A source message always has a sender object; the event carried no sender fields, so each is null.
  sender: { externalId: null, displayName: null, phone: null },
  author: null,
  sendStatus: null,
  sendStatusLabel: null,
  capture: {
    id: CAPTURE_ID,
    status: 'pending',
    kind: 'mirsad_rendered_capture',
    artifactId: null,
    sha256: null,
    attempts: 0,
    errorCode: null,
    retryable: false,
    updatedAt: MESSAGE_AT,
  },
  review: { status: 'pending', outcome: null, updatedAt: MESSAGE_AT },
  editedAtSource: false,
  deletedAtSource: false,
  position: 5,
};

const caseAction = (id: string, type: string, position: number, extra: Record<string, unknown>) => ({
  id,
  chatId: CHAT_ID,
  type,
  actor: OFFICER,
  messageId: null,
  fromMode: null,
  toMode: null,
  revision: null,
  detail: null,
  occurredAt: REGISTERED_AT,
  position,
  ...extra,
});

const dispatchedChat = chat({ aiMode: 'ai_active', revision: 2, lastActivityAt: REGISTERED_AT });
const timelineChat = chat({
  aiMode: 'ai_active',
  revision: 2,
  inboxStatus: 'open',
  originLabel: 'First observed: incoming',
  firstObservedDirection: 'incoming',
  messageCount: 1,
  lastActivityAt: MESSAGE_AT,
  review: { state: 'active', pending: 1, unavailable: 0 },
});

export const WORKFLOW_EXAMPLE = [
  {
    step: 1,
    name: 'register_chat',
    summary: 'The host registers one of its conversations on the officer account.',
    method: 'POST',
    path: '/v1/chats',
    headers: { Authorization: OFFICER_AUTH, 'Content-Type': 'application/json' },
    requestBody: {
      source: 'telegram',
      externalAccountId: 'tg-demo-officer',
      externalChatId: 'host-conversation-1001',
      displayLabel: 'Test Contact',
    },
    response: { status: 201, body: envelope({ chat: chat({}), created: true }) },
  },
  {
    step: 2,
    name: 'dispatch',
    summary: 'The officer starts AI review on the chat. The Idempotency-Key makes a retry safe.',
    method: 'POST',
    path: '/v1/dispatches',
    headers: { Authorization: OFFICER_AUTH, 'Content-Type': 'application/json', 'Idempotency-Key': '<unique key>' },
    requestBody: { chatIds: [CHAT_ID] },
    response: {
      status: 200,
      body: envelope({
        dispatchId: 'dsp_0123456789abcdef0123456789abcdef',
        results: [{ chatId: CHAT_ID, status: 'started', aiMode: dispatchedChat.aiMode, revision: dispatchedChat.revision }],
      }),
    },
  },
  {
    step: 3,
    name: 'submit_inbound_event',
    summary: 'The connector reports one incoming message for the registered chat.',
    method: 'POST',
    path: '/v1/chats/{chatId}/events',
    headers: { Authorization: CONNECTOR_AUTH, 'Content-Type': 'application/json' },
    requestBody: {
      type: 'message.recorded',
      sourceEventId: 'host-event-1',
      sourceMessageId: 'host-message-1',
      direction: 'incoming',
      text: 'Hello, is this the right number for my order?',
    },
    response: {
      status: 201,
      body: envelope({
        chatId: CHAT_ID,
        chatCreated: false,
        result: 'recorded',
        messageId: MESSAGE_ID,
        messageEventId: 'mev_0123456789abcdef0123456789abcdef',
        receivedAt: MESSAGE_AT,
        captureId: CAPTURE_ID,
        startMarker: 'none',
        textConflict: false,
      }),
    },
  },
  {
    step: 4,
    name: 'fetch_timeline',
    summary: 'The officer reads the stored messages, case actions and the stream cursor.',
    method: 'GET',
    path: '/v1/chats/{chatId}/timeline',
    headers: { Authorization: OFFICER_AUTH },
    response: {
      status: 200,
      body: envelope({
        chat: timelineChat,
        messages: [message],
        messageEvents: [],
        caseActions: [
          caseAction('act_00000000000000000000000000000001', 'chat_registered', 2, {}),
          caseAction('act_00000000000000000000000000000002', 'dispatch_started', 3, { fromMode: 'not_started', toMode: 'ai_active', revision: 2 }),
        ],
        findings: [],
        caseReferences: [],
        testSession: null,
        cursor: '5',
      }),
    },
  },
  {
    step: 5,
    name: 'take_over',
    summary: 'The officer takes over at the revision the timeline reported.',
    method: 'POST',
    path: '/v1/chats/{chatId}/control',
    headers: { Authorization: OFFICER_AUTH, 'Content-Type': 'application/json' },
    requestBody: { action: 'take_over', expectedRevision: timelineChat.revision },
    response: {
      status: 200,
      body: envelope({
        chat: { ...timelineChat, aiMode: 'officer_control', revision: 3, controller: OFFICER, lastActivityAt: TAKEN_OVER_AT },
        changedAt: TAKEN_OVER_AT,
      }),
    },
  },
] as const;
