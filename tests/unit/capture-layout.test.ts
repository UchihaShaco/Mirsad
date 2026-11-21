import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureFonts } from '../../src/capture/fonts.ts';
import { BODY_FONT, CONTENT_WIDTH, baseDirection, layoutBody, wrapParagraph } from '../../src/capture/layout.ts';
import { toDisplayText } from '../../src/domain/text-safety.ts';

// Code points are built at run time so this file stays ASCII.
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
const TELEGRAM_MAX_TEXT = 4_096;
const NO_TRUNCATION = Number.MAX_SAFE_INTEGER;
/**
 * A line costs two measureText calls when the previous line's length is exactly right and up to six when it is a few
 * graphemes off. Adding one grapheme at a time cost over a hundred per line of zero-width tokens.
 */
const CALLS_PER_LINE = 6;
/** The first line has no guess and gallops up from one token or grapheme. */
const FIRST_LINE_CALLS = 32;
const HIDDEN = [0x200b, 0x200c, 0x200d, 0x200e, 0x202e, 0x2060, 0x2066, 0xfeff];
const ARABIC_WORDS = [cp(0x0645, 0x0631, 0x062d, 0x0628, 0x0627), cp(0x0628, 0x0643, 0x0645), cp(0x0641, 0x064a), cp(0x0627, 0x0644, 0x0645, 0x0648, 0x0639, 0x062f)];

registerCaptureFonts();

interface MeasuringContext {
  ctx: SKRSContext2D;
  calls: () => number;
}

/** A measuring context that counts measureText calls; the real method still runs. */
function measuringContext(): MeasuringContext {
  const ctx = createCanvas(10, 10).getContext('2d');
  const measure = vi.spyOn(Object.getPrototypeOf(ctx) as SKRSContext2D, 'measureText');
  return { ctx, calls: () => measure.mock.calls.length };
}

/** Invisible characters in a varied order, so consecutive lines differ. */
const hiddenText = (length: number): string => Array.from({ length }, (_, i) => cp(HIDDEN[(i * 5 + (i >> 4)) % HIDDEN.length] ?? 0x200b)).join('');

/** The wrapping rule as first written: add one token, or one grapheme of an over-wide token, at a time. */
function referenceWrap(ctx: SKRSContext2D, paragraph: string, maxWidth: number): string[] {
  const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const breakLongWord = (word: string): string[] => {
    const pieces: string[] = [];
    let current = '';
    for (const { segment } of graphemes.segment(word)) {
      if (current && ctx.measureText(current + segment).width > maxWidth) {
        pieces.push(current);
        current = segment;
      } else {
        current += segment;
      }
    }
    if (current) pieces.push(current);
    return pieces;
  };
  if (paragraph === '') return [''];
  const lines: string[] = [];
  let current = '';
  for (const token of paragraph.split(/( +)/).filter((t) => t !== '')) {
    if (ctx.measureText(current + token).width <= maxWidth) {
      current += token;
    } else if (/^ +$/.test(token)) {
      if (current) lines.push(current);
      current = '';
    } else {
      if (current.trim()) lines.push(current.replace(/ +$/, ''));
      current = '';
      const pieces = ctx.measureText(token).width <= maxWidth ? [token] : breakLongWord(token);
      lines.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? '';
    }
  }
  lines.push(current.replace(/ +$/, ''));
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capture body layout', () => {
  it('a zero-width message of Telegram maximum length costs a few measureText calls per line', () => {
    for (const text of [cp(0x200b).repeat(TELEGRAM_MAX_TEXT), hiddenText(TELEGRAM_MAX_TEXT)]) {
      const { ctx, calls } = measuringContext();
      const lines = layoutBody(ctx, toDisplayText(text), NO_TRUNCATION);
      expect(lines.length).toBeGreaterThan(300);
      expect(calls()).toBeLessThanOrEqual(CALLS_PER_LINE * lines.length + FIRST_LINE_CALLS);
      vi.restoreAllMocks();
    }
  });

  it('a paragraph of many short words costs a few measureText calls per line', () => {
    const words = Array.from({ length: 1_000 }, (_, i) => 'abcdefgh'.slice(0, 1 + ((i * 3) % 8)));
    const { ctx, calls } = measuringContext();
    const lines = layoutBody(ctx, words.join(' '), NO_TRUNCATION);
    expect(lines.length).toBeGreaterThan(40);
    expect(calls()).toBeLessThanOrEqual(CALLS_PER_LINE * lines.length + FIRST_LINE_CALLS);
  });

  it('lines past the card cap are counted for the notice at the same cost', () => {
    const display = toDisplayText(hiddenText(TELEGRAM_MAX_TEXT));
    const total = layoutBody(createCanvas(10, 10).getContext('2d'), display, NO_TRUNCATION).length;
    const { ctx, calls } = measuringContext();
    const lines = layoutBody(ctx, display, 10);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toEqual({ text: `[TRUNCATED: 10 of ${total} lines shown; SHA-256 below covers the full text]`, direction: 'ltr' });
    expect(calls()).toBeLessThanOrEqual(CALLS_PER_LINE * total + FIRST_LINE_CALLS);
  });

  it('line breaks are the same as adding one token or grapheme at a time', () => {
    const english = 'Please confirm the delivery address and the time of the visit. '.repeat(12);
    const arabic = Array.from({ length: 120 }, (_, i) => ARABIC_WORDS[i % ARABIC_WORDS.length]).join(' ');
    const mixed = `${ARABIC_WORDS[0]} https://pay.example.test/path?q=1 Mirsad +44 7700 900123 ${cp(0x0661, 0x0662, 0x0663)} `.repeat(8);
    const paragraphs = [
      '',
      english,
      arabic,
      mixed,
      `https://pay.example.test/${'segment/'.repeat(60)}`,
      toDisplayText(hiddenText(700)),
      `short ${'W'.repeat(200)} tail words ${'m'.repeat(150)}`,
      `      leading spaces ${english}`,
      `start${' '.repeat(300)}end`,
      `${' '.repeat(300)}word after a wide run of spaces`,
      `${'x'.repeat(80)}${' '.repeat(300)}`,
      `${cp(0xa0, 0xa0)} ${'W'.repeat(200)}`,
      `${'e'.concat(cp(0x0301)).repeat(150)} combining marks`,
      cp(0x1f600).repeat(120),
    ];
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = BODY_FONT;
    for (const paragraph of paragraphs) {
      ctx.direction = baseDirection(paragraph);
      expect(wrapParagraph(ctx, paragraph, CONTENT_WIDTH), JSON.stringify(paragraph.slice(0, 40))).toEqual(referenceWrap(ctx, paragraph, CONTENT_WIDTH));
    }
  });
});
