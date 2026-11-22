import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isReservedPhone, nonReservedPhones, phoneCandidates } from '../../src/domain/reserved-numbers.ts';
import { Transcript } from '../../src/review/eval/transcript-schema.ts';

const HELDOUT_DIR = path.resolve(import.meta.dirname, '../../fixtures/eval/heldout');
const README_PATH = path.resolve(import.meta.dirname, '../../fixtures/eval/README.md');
const MIN_PER_LANGUAGE = 6;
const MIN_TRANSCRIPTS = 18;
const MIN_MESSAGES = 3;
const MAX_MESSAGES = 7;
const MIN_TRANSCRIPTS_PER_TAG = 2;
const LANGUAGES = ['ar', 'en', 'mixed'] as const;
const REQUIRED_TAGS = [
  'benign_first_message',
  'quoted_third_party_number',
  'missing_payment_recipient',
  'instruction_injection',
  'payment_link',
  'changed_payment_destination',
  'routine_only',
] as const;
const FILE_NAME = /^(ar|en|mixed)-\d{2}-[a-z0-9-]+\.json$/;

interface LoadedFile {
  readonly name: string;
  readonly raw: unknown;
}

function loadFiles(): LoadedFile[] {
  if (!fs.existsSync(HELDOUT_DIR)) return [];
  return fs
    .readdirSync(HELDOUT_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, raw: JSON.parse(fs.readFileSync(path.join(HELDOUT_DIR, name), 'utf8')) as unknown }));
}

function loadTranscripts(): Transcript[] {
  return loadFiles().map((file) => Transcript.parse(file.raw));
}

/** Writes every character outside printable ASCII and Arabic letters and digits as \uXXXX, so a failure names the probe exactly. */
function showInvisible(text: string): string {
  return text.replace(/[^\x20-\x7e\u0621-\u064a\u0660-\u0669\u06f0-\u06f9]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function hostCandidates(text: string): string[] {
  const hosts = text.match(/(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w-])/gi) ?? [];
  return hosts.map((host) => host.toLowerCase());
}

function isReservedHost(host: string): boolean {
  const labels = host.split('.');
  return host.endsWith('.test') || labels[labels.length - 2] === 'example';
}

/** True when the text holds a phone-like span outside the reserved ranges. */
function hasNonReservedPhone(text: string): boolean {
  return nonReservedPhones(text).length > 0;
}

/** True when the check finds exactly one phone-like span in the text and it is reserved. */
function readsAsOneReservedPhone(text: string): boolean {
  const spans = phoneCandidates(text);
  return spans.length === 1 && spans.every((span) => isReservedPhone(span));
}

/** Each probe is checked on its own and inside an English and an Arabic sentence. */
const PROBE_CONTEXTS = [
  (probe: string) => probe,
  (probe: string) => `please call me on ${probe} today`,
  (probe: string) => `كلمني على ${probe} لو سمحت`,
];

function inEveryContext(probes: readonly string[]): string[] {
  return probes.flatMap((probe) => PROBE_CONTEXTS.map((inContext) => inContext(probe)));
}

/** Numbers outside the reserved ranges, written the ways a fixture author might slip. */
const OUTSIDE_RESERVED = [
  '+44 7911 123456',
  '447911123456',
  '44 7911 123456',
  '07911 123456',
  '7911 123456',
  '+44 7700 901000',
  '٠٧٩١١ ١٢٣٤٥٦',
  '+44\u00a07911\u00a0123456',
  '٠٧٩١١\u00a0١٢٣٤٥٦',
  '07911\u202f123456',
  '07911\u200e123456',
  '+\u200f44 7911 123456',
  '312-555-0277',
  '312 555 0277',
  '312.555.0277',
  '1-312-555-0277',
  '312\u2013555\u20130277',
  '(312) 555-0277',
  '(312) 555-0099',
  '+1 312 555 0200',
  '3125550277',
  '13125550277',
  '555-0277',
  '+1 012 555 0123',
  '02 1555 0123',
  '021 555 0123',
  '20 7555 0123',
  '07700 900123 07911 123456',
] as const;

/** Reserved numbers in the layouts the README allows, including the range edges. */
const RESERVED = [
  '+44 7700 900123',
  '+447700900123',
  '0044 7700 900123',
  '447700900123',
  '07700 900123',
  '07700900123',
  '+44 7700 900000',
  '+44 7700 900999',
  '+٤٤ ٧٧٠٠ ٩٠٠٤٦٨',
  '٠٧٧٠٠ ٩٠٠١٢٣',
  '۰۷۷۰۰ ۹۰۰۱۲۳',
  '+44\u00a07700\u00a0900123',
  '\u200e+44 7700 900123\u200e',
  '+1 202 555 0143',
  '+1 (202) 555-0143',
  '001 312 555 0188',
  '1-312-555-0188',
  '(312) 555-0188',
  '(312) 555-0100',
  '(312) 555-0199',
  '312-555-0188',
  '312.555.0188',
  '312 555 0188',
  '3125550188',
  '555-0188',
] as const;

describe('held-out evaluation transcripts', () => {
  it('every held-out transcript matches the schema', () => {
    const files = loadFiles();
    expect(files.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPTS);
    const ids = new Set<string>();
    for (const file of files) {
      expect(file.name, file.name).toMatch(FILE_NAME);
      const transcript = Transcript.parse(file.raw);
      expect(file.name.startsWith(`${transcript.language}-`), file.name).toBe(true);
      expect(ids.has(transcript.id), `duplicate id ${transcript.id}`).toBe(false);
      ids.add(transcript.id);
      expect(transcript.messages.length, file.name).toBeGreaterThanOrEqual(MIN_MESSAGES);
      expect(transcript.messages.length, file.name).toBeLessThanOrEqual(MAX_MESSAGES);
      expect(new Set(transcript.messages.map((m) => m.id)).size, file.name).toBe(transcript.messages.length);
      for (const message of transcript.messages) {
        const where = `${file.name} ${message.id}`;
        if (message.direction === 'outgoing') expect(message.expected, where).toEqual([]);
        for (const item of message.expected) {
          if (item.kind === 'phone_number') expect(item.concern, where).not.toBeNull();
          else expect(item.concern, where).toBeNull();
        }
      }
    }
  });

  it('every expected value appears verbatim in its message', () => {
    const transcripts = loadTranscripts();
    expect(transcripts.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPTS);
    for (const transcript of transcripts) {
      for (const message of transcript.messages) {
        for (const item of message.expected) {
          expect(message.text.includes(item.value), `${transcript.id} ${message.id}: ${item.value}`).toBe(true);
        }
      }
    }
  });

  it('each language has at least six transcripts and every required tag is covered', () => {
    const transcripts = loadTranscripts();
    for (const language of LANGUAGES) {
      const count = transcripts.filter((t) => t.language === language).length;
      expect(count, language).toBeGreaterThanOrEqual(MIN_PER_LANGUAGE);
    }
    for (const tag of REQUIRED_TAGS) {
      const count = transcripts.filter((t) => t.tags.includes(tag)).length;
      expect(count, tag).toBeGreaterThanOrEqual(MIN_TRANSCRIPTS_PER_TAG);
    }
    expect(transcripts.some((t) => t.tags.includes('arabic_indic_digits'))).toBe(true);
  });

  it('all domains and phone numbers come from the reserved ranges', () => {
    const transcripts = loadTranscripts();
    expect(transcripts.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPTS);
    let phonesSeen = 0;
    for (const transcript of transcripts) {
      for (const message of transcript.messages) {
        const where = `${transcript.id} ${message.id}`;
        for (const host of hostCandidates(message.text)) {
          expect(isReservedHost(host), `${where}: ${host}`).toBe(true);
        }
        for (const span of phoneCandidates(message.text)) {
          phonesSeen += 1;
          expect(isReservedPhone(span), `${where}: ${span}`).toBe(true);
        }
      }
    }
    expect(phonesSeen).toBeGreaterThan(0);
  });

  it('the README quotes no held-out transcript id or expected value', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const transcripts = loadTranscripts();
    expect(transcripts.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPTS);
    const heldOutStrings = transcripts.flatMap((t) => [t.id, ...t.messages.flatMap((m) => m.expected.map((item) => item.value))]);
    expect(heldOutStrings.filter((value) => readme.includes(value))).toEqual([]);
  });
});

describe('reserved-range phone check', () => {
  it('flags numbers outside the reserved ranges in any layout, digit set or spacing', () => {
    const missed = inEveryContext(OUTSIDE_RESERVED).filter((text) => !hasNonReservedPhone(text));
    expect(missed.map(showInvisible)).toEqual([]);
  });

  it('accepts reserved numbers in the layouts the README allows', () => {
    const rejected = inEveryContext(RESERVED).filter((text) => !readsAsOneReservedPhone(text));
    expect(rejected.map(showInvisible)).toEqual([]);
  });
});
