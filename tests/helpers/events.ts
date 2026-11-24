/**
 * Telegram-shaped normalized intake events built inline (design section 19.8 field mapping). All data is
 * synthetic: generic names and phone numbers from the reserved +44 7700 900xxx range.
 */
let counter = 0;

/** A fresh suffix so each test uses its own conversation and message IDs. */
export function uniqueId(prefix = 'x'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export interface RecordedOptions {
  messageId: number | string;
  updateId?: number;
  direction?: 'incoming' | 'outgoing';
  text?: string;
  sentAt?: string;
  sender?: { externalId?: string; displayName?: string; phone?: { raw: string; country?: string; internationalFormat?: boolean } };
  conversationStart?: { basis: 'source_start_marker' | 'confirmed_complete_history' };
  unsupportedContent?: string[];
}

export function recorded(opts: RecordedOptions): Record<string, unknown> {
  const updateId = opts.updateId ?? Number(opts.messageId) + 1000;
  const event: Record<string, unknown> = {
    type: 'message.recorded',
    sourceEventId: `tg:u${updateId}:m${opts.messageId}`,
    sourceMessageId: `tg:${opts.messageId}`,
    direction: opts.direction ?? 'incoming',
    text: opts.text ?? 'Hello, is anyone there?',
  };
  if (opts.sentAt) event.sentAt = opts.sentAt;
  if (opts.sender) event.sender = opts.sender;
  if (opts.conversationStart) event.conversationStart = opts.conversationStart;
  if (opts.unsupportedContent) event.unsupportedContent = opts.unsupportedContent;
  return event;
}

export function edited(opts: { messageId: number | string; updateId: number; text: string; editedAt?: string; direction?: 'incoming' | 'outgoing' }): Record<string, unknown> {
  const editSeconds = opts.editedAt ? Math.floor(Date.parse(opts.editedAt) / 1000) : opts.updateId;
  const event: Record<string, unknown> = {
    type: 'message.edited',
    sourceEventId: `tg:u${opts.updateId}:m${opts.messageId}:e${editSeconds}`,
    sourceMessageId: `tg:${opts.messageId}`,
    text: opts.text,
  };
  if (opts.editedAt) event.editedAt = opts.editedAt;
  if (opts.direction) event.direction = opts.direction;
  return event;
}

export function deleted(opts: { messageId: number | string; updateId: number; direction?: 'incoming' | 'outgoing' }): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: 'message.deleted',
    sourceEventId: `tg:u${opts.updateId}:m${opts.messageId}:del`,
    sourceMessageId: `tg:${opts.messageId}`,
  };
  if (opts.direction) event.direction = opts.direction;
  return event;
}

export interface Envelope {
  source: 'telegram';
  externalAccountId: string;
  externalChatId: string;
  chat?: { displayLabel?: string };
  event: Record<string, unknown>;
}

export function envelope(
  account: { source: 'telegram'; externalAccountId: string },
  externalChatId: string,
  event: Record<string, unknown>,
  displayLabel?: string,
): Envelope {
  const body: Envelope = { source: account.source, externalAccountId: account.externalAccountId, externalChatId, event };
  if (displayLabel) body.chat = { displayLabel };
  return body;
}
