/**
 * Officer actions on a chat under takeover (design section 8): the composer, which records a simulated send and
 * delivers nothing to any channel, and the "Leave unanswered" decision.
 */
import { createHash } from 'node:crypto';
import type { Source } from '../contract/enums.ts';
import { AppError } from '../contract/errors.ts';
import type { CaseAction, Message, OfficerDecisionRequest, OfficerMessageRequest } from '../contract/schemas.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { newId } from '../storage/ids.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { updateChatBookkeeping } from '../storage/repos/chats.ts';
import * as messages from '../storage/repos/messages.ts';
import { findChannelAccountById } from '../storage/repos/principals.ts';
import type { CaseActionRow, ChatRow, MessageRow } from '../storage/rows.ts';
import { requireChat } from './access.ts';
import { assertRevision } from './control.ts';
import { principalLookup, toCaseAction, toMessage } from './mappers.ts';
import { appendStreamEvent } from './stream.ts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The takeover checks, in order: the chat is under takeover (409), by the caller (403), at the expected revision (409). */
function requireControlledChat(tx: Tx, officer: Principal, chatId: string, expectedRevision: number): ChatRow {
  const chat = requireChat(tx, officer, chatId);
  if (chat.ai_mode !== 'officer_control') throw AppError.of('not_in_takeover', 'The chat is not under officer takeover.');
  if (chat.controller_id !== officer.id) throw AppError.of('not_controller', 'Only the officer who controls this chat can do this.');
  assertRevision(chat, expectedRevision);
  return chat;
}

function channelOf(tx: Tx, chat: ChatRow): Source {
  const account = findChannelAccountById(tx, chat.channel_account_id);
  if (!account) throw new Error('chat_account_missing');
  return account.source;
}

/**
 * Inserts the outgoing message, its `recorded` event (no capture, no review), the `officer_message_sent` case
 * action and the `message.recorded` stream event in the caller's transaction.
 */
export function submitOfficerMessage(tx: Tx, officer: Principal, chatId: string, request: OfficerMessageRequest): Message {
  const chat = requireControlledChat(tx, officer, chatId, request.expectedRevision);
  const messageId = newId('msg');
  const position = appendStreamEvent(tx, {
    workspaceId: chat.workspace_id, type: 'message.recorded', chatId: chat.id,
    data: { messageId, direction: 'outgoing', origin: 'officer_composer' },
  });
  // The message and its recorded event share the text, the receipt time and the position.
  const shared = { chatId: chat.id, text: request.text, textSha256: sha256(request.text), receivedAt: tx.now(), position };
  const row = messages.insertComposerMessage(tx, { ...shared, id: messageId, workspaceId: chat.workspace_id, authorOfficerId: officer.id });
  const recordedEvent = messages.insertMessageEvent(tx, {
    ...shared, id: newId('mev'), messageId, type: 'recorded', sourceEventId: null, sourceOccurredAt: null,
    captureMethod: row.capture_method, connectorId: null,
  });
  caseActions.record(tx, {
    chatId: chat.id, workspaceId: chat.workspace_id, type: 'officer_message_sent', actorId: officer.id, messageId, revision: chat.revision,
  });
  updateChatBookkeeping(tx, chat.id, {}); // moves the chat's last activity forward
  // The timeline's own mapping, so the response is exactly the entry the timeline shows.
  return toMessage(row, channelOf(tx, chat), { recordedEvent }, principalLookup(tx));
}

function requireIncomingMessage(tx: Tx, chat: ChatRow, messageId: string): MessageRow {
  const message = messages.findMessageById(tx, messageId);
  if (!message || message.chat_id !== chat.id || message.direction !== 'incoming') {
    throw AppError.of('message_not_found', 'Message not found.');
  }
  return message;
}

function findLeaveUnanswered(tx: Tx, chatId: string, messageId: string): CaseActionRow | undefined {
  return tx.get<CaseActionRow>(
    `SELECT * FROM case_actions WHERE chat_id = :chatId AND message_id = :messageId AND type = 'leave_unanswered'
     ORDER BY position LIMIT 1`,
    { chatId, messageId },
  );
}

export interface DecisionResult {
  caseAction: CaseAction;
  created: boolean;
}

/**
 * Records "Leave unanswered" for an incoming message of the chat: only a case action, the chat stays open and
 * capture continues. A repeat for the same message returns the action already recorded.
 */
export function recordDecision(tx: Tx, officer: Principal, chatId: string, request: OfficerDecisionRequest): DecisionResult {
  const chat = requireControlledChat(tx, officer, chatId, request.expectedRevision);
  const message = requireIncomingMessage(tx, chat, request.messageId);
  const existing = findLeaveUnanswered(tx, chat.id, message.id);
  if (existing) return { caseAction: toCaseAction(existing, principalLookup(tx)), created: false };
  const row = caseActions.record(tx, {
    chatId: chat.id, workspaceId: chat.workspace_id, type: 'leave_unanswered', actorId: officer.id,
    messageId: message.id, revision: chat.revision,
  });
  return { caseAction: toCaseAction(row, principalLookup(tx)), created: true };
}
