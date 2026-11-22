import type { ChannelAdapter } from '../../ports/channel-adapter.ts';
import type { IntakeEnvelope, IntakeEvent } from '../../contract/schemas.ts';
import { MEDIA_KINDS, type TelegramChat, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './types.ts';

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

/**
 * What the message carries outside its visible text and media kinds that Mirsad does not store, listed after the media
 * kinds so the capture and the timeline say it was left out: a formatted link's hidden URL (`text_link`), buttons
 * (`inline_keyboard`), a forward's origin (`forwarded`), and content of a kind Mirsad does not know, when the message
 * has neither text nor a known media kind (`other`). The text itself is kept exactly as sent.
 */
function hiddenContentOf(msg: TelegramMessage, text: string, mediaKinds: readonly string[]): string[] {
  const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
  const markers: [string, boolean][] = [
    ['text_link', entities.some((entity) => entity.type === 'text_link')],
    ['inline_keyboard', (msg.reply_markup?.inline_keyboard ?? []).some((row) => row.length > 0)],
    ['forwarded', msg.forward_origin !== undefined && msg.forward_origin !== null],
    ['other', text === '' && mediaKinds.length === 0],
  ];
  return markers.filter(([, present]) => present).map(([marker]) => marker);
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

  /** Every event carries the chat's own name, so a chat first seen through an edit or a deletion is named after the contact. */
  const envelope = (chat: TelegramChat, event: IntakeEvent): IntakeEnvelope => {
    const chatLabel = fullName(chat);
    return {
      source: 'telegram',
      externalAccountId: options.externalAccountId,
      externalChatId: String(chat.id),
      ...(chatLabel ? { chat: { displayLabel: chatLabel } } : {}),
      event,
    };
  };

  const recorded = (updateId: number, msg: TelegramMessage): IntakeEnvelope => {
    const direction = directionOf(msg, options.businessUserId);
    const text = msg.text ?? msg.caption ?? '';
    const media = mediaKindsOf(msg);
    const unsupported = [...media, ...hiddenContentOf(msg, text, media)];
    const sender = senderOf(msg, direction);
    const isStart = starts.some((s) => s.chatId === msg.chat.id && s.messageId === msg.message_id);
    return envelope(msg.chat, {
      type: 'message.recorded',
      sourceEventId: `tg:u${updateId}:m${msg.message_id}`,
      sourceMessageId: `tg:${msg.message_id}`,
      direction,
      text,
      sentAt: toIso(msg.date),
      ...(sender ? { sender } : {}),
      ...(isStart ? { conversationStart: { basis: 'source_start_marker' as const } } : {}),
      ...(unsupported.length > 0 ? { unsupportedContent: unsupported } : {}),
    });
  };

  // The intake contract gives message.edited no unsupportedContent, so an edit's hidden content (a text_link whose URL
  // alone changed, say) cannot be listed; docs/telegram/fixtures.md records this limit.
  const edited = (updateId: number, msg: TelegramMessage): IntakeEnvelope => {
    const editStamp = msg.edit_date ?? msg.date;
    return envelope(msg.chat, {
      type: 'message.edited',
      sourceEventId: `tg:u${updateId}:m${msg.message_id}:e${editStamp}`,
      sourceMessageId: `tg:${msg.message_id}`,
      text: msg.text ?? msg.caption ?? '',
      editedAt: toIso(editStamp),
      direction: directionOf(msg, options.businessUserId),
    });
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
          .map((messageId) =>
            envelope(removed.chat, {
              type: 'message.deleted',
              sourceEventId: `tg:u${update.update_id}:m${messageId}:del`,
              sourceMessageId: `tg:${messageId}`,
            }),
          );
      }
      return [];
    },
  };
}
