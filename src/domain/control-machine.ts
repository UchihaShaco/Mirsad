/** The per-chat control state machine (design section 8). Pure: no IO, inputs are never modified. */
import type { AiMode, ControlAction, DispatchOutcome } from '../contract/enums.ts';

export interface ControlState {
  aiMode: AiMode;
  controllerId: string | null;
}

export type TransitionResult =
  | { ok: true; aiMode: AiMode; controllerId: string | null }
  | { ok: false; status: 409 | 403; code: 'invalid_transition' | 'not_controller' };

const INVALID: TransitionResult = { ok: false, status: 409, code: 'invalid_transition' };
const NOT_CONTROLLER: TransitionResult = { ok: false, status: 403, code: 'not_controller' };

function to(aiMode: AiMode, controllerId: string | null): TransitionResult {
  return { ok: true, aiMode, controllerId };
}

function pause(state: ControlState): TransitionResult {
  return state.aiMode === 'ai_active' ? to('paused', null) : INVALID;
}

function takeOver(state: ControlState, actorId: string): TransitionResult {
  if (state.aiMode === 'officer_control' && state.controllerId === actorId) return INVALID;
  return to('officer_control', actorId);
}

function resume(state: ControlState, actorId: string): TransitionResult {
  if (state.aiMode === 'paused') return to('ai_active', null);
  if (state.aiMode !== 'officer_control') return INVALID;
  return state.controllerId === actorId ? to('ai_active', null) : NOT_CONTROLLER;
}

export function transition(state: ControlState, action: ControlAction, actorId: string): TransitionResult {
  switch (action) {
    case 'pause':
      return pause(state);
    case 'take_over':
      return takeOver(state, actorId);
    case 'resume':
      return resume(state, actorId);
  }
}

/** The dispatch column: only a chat that never started is started; paused or taken-over chats need a resume. */
export function dispatchOutcome(aiMode: AiMode): DispatchOutcome {
  if (aiMode === 'not_started') return 'started';
  if (aiMode === 'ai_active') return 'already_active';
  return 'requires_resume';
}
