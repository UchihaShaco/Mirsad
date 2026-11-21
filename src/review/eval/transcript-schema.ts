/** Evaluation transcript format shared by the dev and held-out sets (Tasks 8 and 12). */
import { z } from 'zod';

export const ExpectedItem = z.object({
  kind: z.enum(['payment_link', 'payment_recipient', 'phone_number']),
  value: z.string().min(1),
  concern: z.enum(['payment_request', 'callback_request', 'credential_request', 'other_concern']).nullable(),
});
export type ExpectedItem = z.infer<typeof ExpectedItem>;

export const TranscriptMessage = z.object({
  id: z.string().min(1),
  direction: z.enum(['incoming', 'outgoing']),
  text: z.string(),
  expected: z.array(ExpectedItem),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

export const Transcript = z.object({
  id: z.string().min(1),
  language: z.enum(['ar', 'en', 'mixed']),
  tags: z.array(z.string().min(1)),
  description: z.string(),
  messages: z.array(TranscriptMessage),
});
export type Transcript = z.infer<typeof Transcript>;
