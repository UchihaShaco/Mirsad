/**
 * The one intake function behind POST /v1/ingest and POST /v1/chats/{chatId}/events (design section 7). It runs
 * inside the caller's transaction: message text and its pending capture are saved together, and a refused event
 * stores nothing. Provenance (capture method, start-marker trust) comes from the connector, never the payload.
 */
import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';
import type { ConnectorCaptureMethod, Direction, StartMarkerResult } from '../contract/enums.ts';
import { AppError } from '../contract/errors.ts';
import { CHANNEL_LABELS } from '../contract/labels.ts';
import type { IngestResult, IntakeEvent } from '../contract/schemas.ts';
import { decideStartMarker, initiatorFor } from '../domain/initiation.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import { newId } from '../storage/ids.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { insertPendingCapture } from '../storage/repos/captures.ts';
import { findChatByExternalId, findChatById, insertChat, updateChatBookkeeping, type ChatBookkeepingPatch } from '../storage/repos/chats.ts';
import * as messages from '../storage/repos/messages.ts';
import { findChannelAccount, findChannelAccountById, hasGrant } from '../storage/repos/principals.ts';
import { insertReview } from '../storage/repos/reviews.ts';
import type { ChannelAccountRow, ChatRow, MessageEventRow, MessageRow } from '../storage/rows.ts';
import { canAccessChat } from './access.ts';
import { initialReviewStatus, requeueRetryableReviews } from './review-queue.ts';
import { appendStreamEvent } from './stream.ts';
import * as watchlist from './watchlist.ts';

export type IntakeTarget =
  | { chatId: string }
  | { source: ChannelAccountRow['source']; externalAccountId: string; externalChatId: string; chat?: { displayLabel?: string } };

export type IntakeConfig = Pick<Config, 'whatsappImportEnabled' | 'reviewAllowedCaptureMethods'>;

type RecordedEvent = Extract<IntakeEvent, { type: 'message.recorded' }>;
type EditedEvent = Extract<IntakeEvent, { type: 'message.edited' }>;
type DeletedEvent = Extract<IntakeEvent, { type: 'message.deleted' }>;

interface IntakeContext {
  tx: Tx;
  connector: Principal;
  captureMethod: ConnectorCaptureMethod;
  account: ChannelAccountRow;
  config: IntakeConfig;
  chatCreated: boolean;
}

interface StoredEvent {
  message: MessageRow;
  messageEvent: MessageEventRow;
  captureId: string | null;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const toUtc = (iso: string | undefined): string | null => (iso === undefined ? null : new Date(iso).toISOString());

function assertChannelEnabled(source: ChannelAccountRow['source'], config: IntakeConfig): void {
  if (source === 'whatsapp' && !config.whatsappImportEnabled) {
    throw AppError.of('channel_not_enabled', 'WhatsApp intake is not enabled until the Telegram controlled test is verified.');
  }
}

function eventDirection(event: IntakeEvent): Direction | undefined {
  return event.direction;
}

/** The host's label, else the sender's name when the event is incoming (an outgoing sender is the officer), else a fallback. */
function newChatLabel(target: Extract<IntakeTarget, { externalChatId: string }>, event: IntakeEvent): string {
  const senderName = event.type === 'message.recorded' && event.direction === 'incoming' ? event.sender?.displayName : undefined;
  return target.chat?.displayLabel ?? senderName ?? `${CHANNEL_LABELS[target.source]} chat ${target.externalChatId}`;
}

function resolveById(tx: Tx, connector: Principal, chatId: string, config: IntakeConfig) {
  const chat = findChatById(tx, chatId);
  if (!chat || !canAccessChat(tx, connector, chat)) throw AppError.of('chat_not_found', 'Chat not found.');
  const account = findChannelAccountById(tx, chat.channel_account_id);
  if (!account) throw new Error('chat_account_missing');
  assertChannelEnabled(account.source, config);
  return { chat, account, created: false };
}

function resolveChat(tx: Tx, connector: Principal, target: IntakeTarget, event: IntakeEvent, config: IntakeConfig) {
  if ('chatId' in target) return resolveById(tx, connector, target.chatId, config);
  assertChannelEnabled(target.source, config);
  const account = findChannelAccount(tx, connector.workspaceId, target.source, target.externalAccountId);
  if (!account || !hasGrant(tx, connector.id, account.id)) {
    throw AppError.of('account_not_authorized', 'This connector is not authorized for that channel account.');
  }
  const existing = findChatByExternalId(tx, connector.workspaceId, account.id, target.externalChatId);
  if (existing) return { chat: existing, account, created: false };
  const inboxStatus = eventDirection(event) === 'incoming' ? 'new_inbound' : 'open';
  const chat = insertChat(tx, {
    workspaceId: connector.workspaceId,
    channelAccountId: account.id,
    externalChatId: target.externalChatId,
    displayLabel: newChatLabel(target, event),
    createdVia: 'ingest',
    createdBy: connector.id,
    inboxStatus,
  });
  appendStreamEvent(tx, { workspaceId: chat.workspace_id, type: 'chat.created', chatId: chat.id, data: { inboxStatus } });
  return { chat, account, created: true };
}

function buildResult(
  ctx: IntakeContext,
  chatId: string,
  kind: IngestResult['result'],
  messageId: string,
  stored: StoredEvent | null,
  startMarker: StartMarkerResult = 'none',
): IngestResult {
  return {
    chatId,
    chatCreated: ctx.chatCreated,
    result: kind,
    messageId,
    messageEventId: stored?.messageEvent.id ?? null,
    receivedAt: stored?.messageEvent.received_at ?? null,
    captureId: stored?.captureId ?? null,
    startMarker,
    textConflict: kind === 'conflicting_copy',
  };
}

/** Pending capture for content, a review row for incoming text, and the automatic retry in ai_active chats. */
function addEvidenceWork(ctx: IntakeContext, chat: ChatRow, message: MessageRow, messageEvent: MessageEventRow, unsupported: readonly string[]): string | null {
  const text = messageEvent.text ?? '';
  const ids = { chatId: chat.id, messageId: message.id, messageEventId: messageEvent.id };
  const captureId = text.length > 0 || unsupported.length > 0 ? insertPendingCapture(ctx.tx, ids).id : null;
  if (message.direction !== 'incoming') return captureId;
  if (text.length > 0) {
    insertReview(ctx.tx, { ...ids, status: initialReviewStatus(chat, ctx.account.source, ctx.captureMethod, ctx.config) });
  }
  if (chat.ai_mode === 'ai_active') requeueRetryableReviews(ctx.tx, chat.id);
  return captureId;
}

function insertEvent(ctx: IntakeContext, base: { id: string; chatId: string; messageId: string; position: number }, type: MessageEventRow['type'], sourceEventId: string, text: string | null, occurredAt: string | null): MessageEventRow {
  return messages.insertMessageEvent(ctx.tx, {
    ...base,
    type,
    sourceEventId,
    text,
    textSha256: text === null ? null : sha256(text),
    sourceOccurredAt: occurredAt,
    receivedAt: ctx.tx.now(),
    captureMethod: ctx.captureMethod,
    connectorId: ctx.connector.id,
  });
}

function toContent(event: RecordedEvent): messages.SourceContent {
  return {
    direction: event.direction,
    text: event.text,
    textSha256: sha256(event.text),
    unsupportedContent: event.unsupportedContent ?? [],
    sentAt: toUtc(event.sentAt),
    senderExternalId: event.sender?.externalId ?? null,
    senderDisplayName: event.sender?.displayName ?? null,
    senderPhoneRaw: event.sender?.phone?.raw ?? null,
  };
}

/** First observed direction, initiation and contact fields; each is set only while still empty. */
function bookkeepingPatch(chat: ChatRow, direction: Direction | null | undefined, event: RecordedEvent | null, marker: StartMarkerResult): ChatBookkeepingPatch {
  const patch: ChatBookkeepingPatch = {};
  if (chat.first_observed_direction === null && direction) patch.firstObservedDirection = direction;
  if (marker === 'accepted' && event?.conversationStart) {
    patch.initiatedBy = initiatorFor(event.direction);
    patch.initiationBasis = event.conversationStart.basis;
  }
  const sender = event?.direction === 'incoming' ? event.sender : undefined;
  if (sender?.externalId && chat.contact_external_id === null) patch.contactExternalId = sender.externalId;
  if (sender?.displayName && chat.contact_display_name === null) patch.contactDisplayName = sender.displayName;
  if (sender?.phone && chat.contact_phone_raw === null) patch.contactPhoneRaw = sender.phone.raw;
  return patch;
}

function storeConflictingCopy(ctx: IntakeContext, chat: ChatRow, existing: MessageRow, event: RecordedEvent): IngestResult {
  const eventId = newId('mev');
  const position = appendStreamEvent(ctx.tx, {
    workspaceId: chat.workspace_id, type: 'message.conflicting_copy', chatId: chat.id, data: { messageId: existing.id, messageEventId: eventId },
  });
  const base = { id: eventId, chatId: chat.id, messageId: existing.id, position };
  const messageEvent = insertEvent(ctx, base, 'conflicting_copy', event.sourceEventId, event.text, toUtc(event.sentAt));
  caseActions.record(ctx.tx, {
    chatId: chat.id, workspaceId: chat.workspace_id, type: 'text_conflict_recorded', actorId: ctx.connector.id,
    messageId: existing.id, detail: { messageEventId: eventId },
  });
  const updated = updateChatBookkeeping(ctx.tx, chat.id, {});
  const captureId = addEvidenceWork(ctx, updated, existing, messageEvent, event.unsupportedContent ?? []);
  const marker: StartMarkerResult = event.conversationStart ? 'ignored_conflict' : 'none';
  return buildResult(ctx, chat.id, 'conflicting_copy', existing.id, { message: existing, messageEvent, captureId }, marker);
}

function storeRecorded(ctx: IntakeContext, chat: ChatRow, event: RecordedEvent): IngestResult {
  const existing = messages.findMessageBySourceId(ctx.tx, chat.id, event.sourceMessageId);
  const content = toContent(event);
  if (existing && existing.original_captured === 1) {
    if (existing.text_sha256 === content.textSha256) return buildResult(ctx, chat.id, 'duplicate_message', existing.id, null);
    return storeConflictingCopy(ctx, chat, existing, event);
  }
  const messageId = existing?.id ?? newId('msg');
  const position = appendStreamEvent(ctx.tx, {
    workspaceId: chat.workspace_id, type: 'message.recorded', chatId: chat.id, data: { messageId, direction: event.direction, origin: 'source' },
  });
  const message = existing
    ? messages.fillPlaceholder(ctx.tx, existing.id, content)
    : messages.insertSourceMessage(ctx.tx, {
        id: messageId, chatId: chat.id, workspaceId: chat.workspace_id, sourceMessageId: event.sourceMessageId,
        captureMethod: ctx.captureMethod, receivedAt: ctx.tx.now(), position, content,
      });
  const base = { id: newId('mev'), chatId: chat.id, messageId, position };
  const messageEvent = insertEvent(ctx, base, 'recorded', event.sourceEventId, event.text, content.sentAt);
  const marker = decideStartMarker({
    hasMarker: event.conversationStart !== undefined,
    connectorTrusted: ctx.connector.trustedStartMarker,
    currentInitiatedBy: chat.initiated_by,
    markedSentAt: content.sentAt,
    otherSentAts: messages.otherSourceMessageTimes(ctx.tx, chat.id, messageId),
  });
  const patch = bookkeepingPatch(chat, event.direction, event, marker);
  const updated = updateChatBookkeeping(ctx.tx, chat.id, patch);
  const captureId = addEvidenceWork(ctx, updated, message, messageEvent, content.unsupportedContent);
  if (patch.contactPhoneRaw !== undefined && event.sender?.phone) {
    watchlist.onContactPhoneKnown(ctx.tx, { chat: updated, message, messageEvent }, event.sender.phone);
  }
  return buildResult(ctx, chat.id, 'recorded', messageId, { message, messageEvent, captureId }, marker);
}

/** The message an edit or deletion refers to, or a placeholder for one Mirsad never saw. */
function findOrPlaceholder(ctx: IntakeContext, chat: ChatRow, event: EditedEvent | DeletedEvent, position: number, messageId: string): MessageRow {
  const existing = messages.findMessageBySourceId(ctx.tx, chat.id, event.sourceMessageId);
  if (existing) return existing;
  return messages.insertSourceMessage(ctx.tx, {
    id: messageId, chatId: chat.id, workspaceId: chat.workspace_id, sourceMessageId: event.sourceMessageId,
    captureMethod: ctx.captureMethod, receivedAt: ctx.tx.now(), position, content: null, placeholderDirection: event.direction ?? null,
  });
}

function storeEditOrDeletion(ctx: IntakeContext, chat: ChatRow, event: EditedEvent | DeletedEvent): IngestResult {
  const known = messages.findMessageBySourceId(ctx.tx, chat.id, event.sourceMessageId);
  if (!known && event.type === 'message.edited' && !event.direction) {
    throw AppError.of('direction_required', 'An edit for a message Mirsad has not seen must carry its direction.');
  }
  const messageId = known?.id ?? newId('msg');
  const eventId = newId('mev');
  const type = event.type === 'message.edited' ? 'message.edited' : 'message.deleted';
  const position = appendStreamEvent(ctx.tx, { workspaceId: chat.workspace_id, type, chatId: chat.id, data: { messageId, messageEventId: eventId } });
  const target = findOrPlaceholder(ctx, chat, event, position, messageId);
  const base = { id: eventId, chatId: chat.id, messageId, position };
  const updated = updateChatBookkeeping(ctx.tx, chat.id, bookkeepingPatch(chat, event.direction, null, 'none'));
  if (event.type === 'message.deleted') {
    const message = messages.markDeletedAtSource(ctx.tx, target.id);
    const messageEvent = insertEvent(ctx, base, 'deleted', event.sourceEventId, null, toUtc(event.deletedAt));
    return buildResult(ctx, chat.id, 'recorded', messageId, { message, messageEvent, captureId: null });
  }
  const message = messages.markEditedAtSource(ctx.tx, target.id);
  const messageEvent = insertEvent(ctx, base, 'edited', event.sourceEventId, event.text, toUtc(event.editedAt));
  const captureId = addEvidenceWork(ctx, updated, message, messageEvent, []);
  return buildResult(ctx, chat.id, 'recorded', messageId, { message, messageEvent, captureId });
}

export function ingest(tx: Tx, connector: Principal, target: IntakeTarget, event: IntakeEvent, config: IntakeConfig): IngestResult {
  if (connector.kind !== 'connector' || connector.captureMethod === null) {
    throw AppError.of('forbidden_for_principal', 'Only an ingestion connector can submit events.');
  }
  const { chat, account, created } = resolveChat(tx, connector, target, event, config);
  const ctx: IntakeContext = { tx, connector, captureMethod: connector.captureMethod, account, config, chatCreated: created };
  const duplicate = messages.findEventBySourceEventId(tx, chat.id, event.sourceEventId);
  if (duplicate) return buildResult(ctx, chat.id, 'duplicate_event', duplicate.message_id, null);
  if (event.type === 'message.recorded') return storeRecorded(ctx, chat, event);
  return storeEditOrDeletion(ctx, chat, event);
}
