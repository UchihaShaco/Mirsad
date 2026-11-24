import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface AliPromptSnapshot {
  readonly text: string;
  readonly minimumDistinctIndicators: number;
  readonly version: string;
}

export class AliPromptReloadError extends Error {
  readonly reason: 'invalid' | 'unreadable';

  constructor(reason: 'invalid' | 'unreadable') {
    super(reason === 'invalid'
      ? 'Use UTF-8, set minimum_distinct_indicators to 2, 3 or 4, and include instructions.'
      : 'The saved Ali prompt could not be read.');
    this.name = 'AliPromptReloadError';
    this.reason = reason;
  }
}

function readSavedPrompt(): AliPromptSnapshot {
  let bytes: Buffer;
  try {
    bytes = readFileSync(new URL('../../prompts/ali.md', import.meta.url));
  } catch {
    throw new AliPromptReloadError('unreadable');
  }
  if (!isUtf8(bytes)) throw new AliPromptReloadError('invalid');
  const text = bytes.toString('utf8');
  const settings = /^\uFEFF?---\r?\nminimum_distinct_indicators: ([2-4])\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!settings || !text.slice(settings[0].length).trim()) throw new AliPromptReloadError('invalid');
  return Object.freeze({ text, minimumDistinctIndicators: Number(settings[1]), version: createHash('sha256').update(bytes).digest('hex').slice(0, 12) });
}

let active = readSavedPrompt();
// Live bindings preserve the existing public imports used by evaluation and preview tools.
export let ALI_PROMPT = active.text;
export let MINIMUM_DISTINCT_INDICATORS = active.minimumDistinctIndicators;

export function currentAliPrompt(): AliPromptSnapshot {
  return active;
}

export function reloadAliPrompt(): { version: string; changed: boolean } {
  const next = readSavedPrompt();
  if (next.text === active.text) return { version: active.version, changed: false };
  active = next;
  ALI_PROMPT = next.text;
  MINIMUM_DISTINCT_INDICATORS = next.minimumDistinctIndicators;
  return { version: next.version, changed: true };
}
