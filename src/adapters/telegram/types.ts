/** The slice of the Telegram Bot API business types that Mirsad reads (design section 19.8). No SDK. */

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

/** Media kinds Mirsad lists as unsupported content, in the order they are reported. */
export const MEDIA_KINDS = [
  'photo',
  'document',
  'video',
  'audio',
  'voice',
  'video_note',
  'sticker',
  'animation',
  'location',
  'venue',
  'poll',
  'contact',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * A formatting span of the text or caption. Only `type` is read: a `text_link` points to `url`, which the visible text
 * does not show and Mirsad does not store (it lists `text_link` as unsupported content instead).
 */
export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

/** Buttons attached to a message (labels, links, actions); Mirsad stores none of them. */
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard?: unknown[][];
}

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  business_connection_id?: string;
  sender_business_bot?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_markup?: TelegramInlineKeyboardMarkup;
  /** Set on a forwarded message; who or where it came from is not stored. */
  forward_origin?: unknown;
  edit_date?: number;
  contact?: TelegramContact;
} & { [K in Exclude<MediaKind, 'contact'>]?: unknown };

export interface TelegramBusinessConnection {
  id: string;
  user: TelegramUser;
  user_chat_id: number;
  date: number;
  rights?: Record<string, boolean>;
  is_enabled: boolean;
}

export interface TelegramDeletedMessages {
  business_connection_id: string;
  chat: TelegramChat;
  message_ids: number[];
}

export interface TelegramUpdate {
  update_id: number;
  business_connection?: TelegramBusinessConnection;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: TelegramDeletedMessages;
}

/** A synthetic Telegram-shaped fixture file (design section 13); the shape is defined by its zod schema. */
export type { TelegramFixture } from './fixture-schema.ts';
