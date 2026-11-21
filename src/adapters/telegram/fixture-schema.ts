/** zod schema for synthetic Telegram fixture files (design section 13): the replay tool's only input boundary. */
import { z } from 'zod';

const userSchema = z.looseObject({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const chatSchema = z.looseObject({
  id: z.number().int(),
  type: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

const contactSchema = z.looseObject({
  phone_number: z.string(),
  first_name: z.string(),
  last_name: z.string().optional(),
  user_id: z.number().int().optional(),
});

const messageSchema = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int().nonnegative(),
  chat: chatSchema,
  from: userSchema.optional(),
  business_connection_id: z.string(),
  sender_business_bot: userSchema.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  edit_date: z.number().int().nonnegative().optional(),
  contact: contactSchema.optional(),
});

const businessConnectionSchema = z.looseObject({
  id: z.string(),
  user: userSchema,
  user_chat_id: z.number().int(),
  date: z.number().int().nonnegative(),
  rights: z.record(z.string(), z.boolean()).optional(),
  is_enabled: z.boolean(),
});

const deletedMessagesSchema = z.looseObject({
  business_connection_id: z.string(),
  chat: chatSchema,
  message_ids: z.array(z.number().int()),
});

export const telegramUpdateSchema = z.looseObject({
  update_id: z.number().int(),
  business_connection: businessConnectionSchema.optional(),
  business_message: messageSchema.optional(),
  edited_business_message: messageSchema.optional(),
  deleted_business_messages: deletedMessagesSchema.optional(),
});

export const SYNTHETIC_MARK_PROBLEM = 'fixture is not marked synthetic: true';

export const telegramFixtureSchema = z.object({
  description: z.string().min(1),
  synthetic: z.literal(true, { error: SYNTHETIC_MARK_PROBLEM }),
  account: z.enum(['intake', 'officer']),
  businessUserId: z.number().int(),
  businessConnectionId: z.string(),
  updates: z.array(telegramUpdateSchema),
  conversationStarts: z.array(z.object({ chatId: z.number().int(), messageId: z.number().int() })).optional(),
});

export type TelegramFixture = z.infer<typeof telegramFixtureSchema>;
