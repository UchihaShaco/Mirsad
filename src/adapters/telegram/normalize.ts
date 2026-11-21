import type { ChannelAdapter } from '../../ports/channel-adapter.ts';
import type { IntakeEnvelope, IntakeEvent } from '../../contract/schemas.ts';
import { MEDIA_KINDS, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './types.ts';

export interface TelegramAdapterOptions {
  businessUserId: number;
  businessConnectionId: string;
  externalAccountId: string;
  /** Fixture-author assertions only; real updates carry no start marker. */
  conversationStarts?: { chatId: number; messageId: number }[];
}

const toIso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

const fullName = (user: TelegramUser | { first_name?: string; last_name?: string }): string | undefined => {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name === '' ? undefined : name;
};

function directionOf(msg: TelegramMessage, businessUserId: number): 'incoming' | 'outgoing' {
  return msg.sender_business_bot !== undefined || msg.from?.id === businessUserId ? 'outgoing' : 'incoming';
}

function mediaKindsOf(msg: TelegramMessage): string[] {
  return MEDIA_KINDS.filter((kind) => msg[kind] !== undefined && msg[kind] !== null);
}

function senderOf(msg: TelegramMessage, direction: 'incoming' | 'outgoing') {
  if (!msg.from) return undefined;
  const displayName = fullName(msg.from);
  const ownCard = direction === 'incoming' && msg.contact !== undefined && msg.contact.user_id === msg.from.id;
  return {
    externalId: String(msg.from.id),
    ...(displayName ? { displayName } : {}),
    ...(ownCard && msg.contact ? { phone: { raw: msg.contact.phone_number, internationalFormat: true } } : {}),
  };
}

export function createTelegramAdapter(options: TelegramAdapterOptions): ChannelAdapter<TelegramUpdate> {
  const starts = options.conversationStarts ?? [];

  const envelope = (msg: TelegramMessage, event: IntakeEvent, label: boolean): IntakeEnvelope => {
    const chatLabel = label ? fullName(msg.chat) : undefined;
    return {
      source: 'telegram',
      externalAccountId: options.externalAccountId,
      externalChatId: String(msg.chat.id),
      ...(chatLabel ? { chat: { displayLabel: chatLabel } } : {}),
      event,
    };
  };

  const recorded = (updateId: number, msg: TelegramMessage): IntakeEnvelope => {
    const direction = directionOf(msg, options.businessUserId);
    const unsupported = mediaKindsOf(msg);
    const sender = senderOf(msg, direction);
    const isStart = starts.some((s) => s.chatId === msg.chat.id && s.messageId === msg.message_id);
    return envelope(
      msg,
      {
        type: 'message.recorded',
        sourceEventId: `tg:u${updateId}:m${msg.message_id}`,
        sourceMessageId: `tg:${msg.message_id}`,
        direction,
        text: msg.text ?? msg.caption ?? '',
        sentAt: toIso(msg.date),
        ...(sender ? { sender } : {}),
        ...(isStart ? { conversationStart: { basis: 'source_start_marker' as const } } : {}),
        ...(unsupported.length > 0 ? { unsupportedContent: unsupported } : {}),
      },
      true,
    );
  };

  const edited = (updateId: number, msg: TelegramMessage): IntakeEnvelope => {
    const editStamp = msg.edit_date ?? msg.date;
    return envelope(
      msg,
      {
        type: 'message.edited',
        sourceEventId: `tg:u${updateId}:m${msg.message_id}:e${editStamp}`,
        sourceMessageId: `tg:${msg.message_id}`,
        text: msg.text ?? msg.caption ?? '',
        editedAt: toIso(editStamp),
        direction: directionOf(msg, options.businessUserId),
      },
      false,
    );
  };

  const accepts = (connectionId: string | undefined, messageId?: number): boolean =>
    connectionId === options.businessConnectionId && messageId !== 0;

  return {
    source: 'telegram',
    normalize(update: TelegramUpdate): IntakeEnvelope[] {
      const created = update.business_message;
      if (created && accepts(created.business_connection_id, created.message_id)) {
        return [recorded(update.update_id, created)];
      }
      const edit = update.edited_business_message;
      if (edit && accepts(edit.business_connection_id, edit.message_id)) {
        return [edited(update.update_id, edit)];
      }
      const removed = update.deleted_business_messages;
      if (removed && accepts(removed.business_connection_id)) {
        return removed.message_ids
          .filter((messageId) => messageId !== 0)
          .map((messageId) => ({
            source: 'telegram' as const,
            externalAccountId: options.externalAccountId,
            externalChatId: String(removed.chat.id),
            event: {
              type: 'message.deleted' as const,
              sourceEventId: `tg:u${update.update_id}:m${messageId}:del`,
              sourceMessageId: `tg:${messageId}`,
            },
          }));
      }
      return [];
    },
  };
}
