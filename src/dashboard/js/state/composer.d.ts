/** Types for composer.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
import type { ChatSummary, PrincipalRef } from '../../../contract/schemas.ts';

export type ComposerChat = Pick<
  ChatSummary,
  'id' | 'aiMode' | 'controller' | 'revision' | 'intakeAccount' | 'acknowledgementTemplate'
>;
export type SignedInOfficer = Pick<PrincipalRef, 'id'>;

/** One POST /v1/chats/{chatId}/officer-messages, made only by an explicit Send. */
export interface SendRequest {
  chatId: string;
  text: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface ComposerState {
  readonly text: string;
  readonly sending: boolean;
  /** The last send attempted; a retry with the same text and revision reuses its idempotency key. */
  readonly pendingSend: SendRequest | null;
}

export type ComposerAction =
  | { type: 'edit'; text: string }
  | { type: 'insert_acknowledgement'; chat: ComposerChat }
  | { type: 'send'; chat: ComposerChat; me: SignedInOfficer | null; newKey: string }
  | { type: 'send_succeeded' }
  | { type: 'send_failed' }
  | { type: 'reset' };

export interface ComposerUpdate {
  state: ComposerState;
  request: SendRequest | null;
}

export function canCompose(chat: Pick<ChatSummary, 'aiMode' | 'controller'>, me: SignedInOfficer | null): boolean;
export function canInsertAcknowledgement(chat: Pick<ChatSummary, 'intakeAccount' | 'acknowledgementTemplate'>): boolean;
export function canSend(state: ComposerState): boolean;
export function initialComposer(): ComposerState;
export function updateComposer(state: ComposerState, action: ComposerAction): ComposerUpdate;
