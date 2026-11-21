import type { Source } from '../contract/enums.ts';
import type { IntakeEnvelope } from '../contract/schemas.ts';

/** Maps one raw channel payload to zero or more intake envelopes. Pure: no IO. */
export interface ChannelAdapter<Raw> {
  readonly source: Source;
  normalize(raw: Raw): IntakeEnvelope[];
}
