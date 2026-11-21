import { describe, expect, it } from 'vitest';
import type { AiMode } from '../../src/contract/enums.ts';
import { dispatchOutcome, transition, type ControlState } from '../../src/domain/control-machine.ts';

const ME = 'prn_me';
const OTHER = 'prn_other';
const INVALID = { ok: false, status: 409, code: 'invalid_transition' };
const NOT_CONTROLLER = { ok: false, status: 403, code: 'not_controller' };
const to = (aiMode: AiMode, controllerId: string | null) => ({ ok: true, aiMode, controllerId });

// Design section 8, one row per starting state; the actor is always ME.
const ROWS: { name: string; state: ControlState; pause: unknown; take_over: unknown; resume: unknown; dispatch: string }[] = [
  { name: 'not_started', state: { aiMode: 'not_started', controllerId: null }, pause: INVALID, take_over: to('officer_control', ME), resume: INVALID, dispatch: 'started' },
  { name: 'ai_active', state: { aiMode: 'ai_active', controllerId: null }, pause: to('paused', null), take_over: to('officer_control', ME), resume: INVALID, dispatch: 'already_active' },
  { name: 'paused', state: { aiMode: 'paused', controllerId: null }, pause: INVALID, take_over: to('officer_control', ME), resume: to('ai_active', null), dispatch: 'requires_resume' },
  { name: 'officer_control by actor', state: { aiMode: 'officer_control', controllerId: ME }, pause: INVALID, take_over: INVALID, resume: to('ai_active', null), dispatch: 'requires_resume' },
  { name: 'officer_control by another officer', state: { aiMode: 'officer_control', controllerId: OTHER }, pause: INVALID, take_over: to('officer_control', ME), resume: NOT_CONTROLLER, dispatch: 'requires_resume' },
];

describe('control machine', () => {
  for (const row of ROWS) {
    it(`transition from ${row.name} matches every cell of the design table`, () => {
      const before = { ...row.state };
      expect(transition(row.state, 'pause', ME)).toEqual(row.pause);
      expect(transition(row.state, 'take_over', ME)).toEqual(row.take_over);
      expect(transition(row.state, 'resume', ME)).toEqual(row.resume);
      expect(row.state).toEqual(before);
    });

    it(`dispatchOutcome from ${row.name} is ${row.dispatch}`, () => {
      expect(dispatchOutcome(row.state.aiMode)).toBe(row.dispatch);
    });
  }
});
