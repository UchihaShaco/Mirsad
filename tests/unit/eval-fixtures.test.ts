import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

/** Maps Arabic-Indic and Extended Arabic-Indic digits to ASCII. */
function toAsciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Reserved fictional ranges: +44 7700 900000-900999 and +1 <area> 555 0100-0199. */
function isReservedPhone(digits: string): boolean {
  const withoutIntlPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
  return /^(44|0)7700900\d{3}$/.test(withoutIntlPrefix) || /^1?\d{3}55501\d{2}$/.test(withoutIntlPrefix);
}

/** Phone-like spans: start with +, 00, 0 or ( and carry 7 to 15 digits. */
function phoneCandidates(text: string): string[] {
  const spans = toAsciiDigits(text).match(/(?<![\w+])(?:\+|\()?\d[\d \-().]{5,}\d(?!\w)/g) ?? [];
  return spans.filter((span) => {
    const digits = span.replace(/\D/g, '');
    const prefixed = span.startsWith('+') || span.startsWith('(') || digits.startsWith('0');
    return prefixed && digits.length >= 7 && digits.length <= 15;
  });
}

function hostCandidates(text: string): string[] {
  const hosts = text.match(/(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w-])/gi) ?? [];
  return hosts.map((host) => host.toLowerCase());
}

function isReservedHost(host: string): boolean {
  const labels = host.split('.');
  return host.endsWith('.test') || labels[labels.length - 2] === 'example';
}

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
          expect(isReservedPhone(span.replace(/\D/g, '')), `${where}: ${span}`).toBe(true);
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
