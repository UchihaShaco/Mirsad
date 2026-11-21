/**
 * Capture card geometry and body text layout (design section 19.6). Canvas shapes each drawn line and applies the
 * Unicode bidi algorithm to it; this module supplies what canvas lacks: paragraph splitting, each paragraph's base
 * direction, greedy word wrapping on measured width and grapheme-safe breaking of tokens wider than the card.
 */
import type { SKRSContext2D } from '@napi-rs/canvas';
import { FONT } from './fonts.ts';

export const CARD_WIDTH = 960;
export const PADDING = 32;
export const CONTENT_WIDTH = CARD_WIDTH - PADDING * 2;
export const BODY_FONT = `18px ${FONT.sans}, ${FONT.arabic}`;
export const BODY_LINE_HEIGHT = 28;
/** Stay well below Skia and PNG practical limits; longer bodies are cut with a visible notice. */
export const MAX_CARD_HEIGHT = 30_000;

const LF = String.fromCharCode(0x0a);

export type TextDirection = 'ltr' | 'rtl';

export interface BodyLine {
  text: string;
  direction: TextDirection;
}

type CodePointRanges = readonly (readonly [number, number])[];

const RTL_RANGES: CodePointRanges = [[0x0590, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfefe], [0x10800, 0x10fff], [0x1e800, 0x1efff]];
const LTR_RANGES: CodePointRanges = [
  [0x0041, 0x005a], [0x0061, 0x007a], [0x00c0, 0x02af], [0x0370, 0x058f], [0x0900, 0x1fff], [0x2c00, 0xfb1c], [0x20000, 0x3ffff],
];

const inRanges = (codePoint: number, ranges: CodePointRanges): boolean => ranges.some(([low, high]) => codePoint >= low && codePoint <= high);

/** The first strong character decides (a simplified form of UBA rules P2 and P3); without one the paragraph is LTR. */
export function baseDirection(paragraph: string): TextDirection {
  for (const char of paragraph) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (inRanges(codePoint, RTL_RANGES)) return 'rtl';
    if (inRanges(codePoint, LTR_RANGES)) return 'ltr';
  }
  return 'ltr';
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Splits a token wider than the card between graphemes, so no character is cut in half. */
function breakLongWord(ctx: SKRSContext2D, word: string, maxWidth: number): string[] {
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
}

/** Greedy wrapping on measured width. Spaces at a line break are dropped; no other character is. */
export function wrapParagraph(ctx: SKRSContext2D, paragraph: string, maxWidth: number): string[] {
  if (paragraph === '') return [''];
  const tokens = paragraph.split(/( +)/).filter((token) => token !== '');
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current + token;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (/^ +$/.test(token)) {
      if (current) lines.push(current);
      current = '';
      continue;
    }
    if (current.trim()) lines.push(current.replace(/ +$/, ''));
    current = '';
    if (ctx.measureText(token).width <= maxWidth) {
      current = token;
      continue;
    }
    const pieces = breakLongWord(ctx, token, maxWidth);
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  lines.push(current.replace(/ +$/, ''));
  return lines;
}

/** Every line of the display text. Beyond maxLines the body is cut and a visible notice line says so. */
export function layoutBody(ctx: SKRSContext2D, displayText: string, maxLines: number): BodyLine[] {
  ctx.font = BODY_FONT;
  const lines: BodyLine[] = [];
  for (const paragraph of displayText.split(LF)) {
    const direction = baseDirection(paragraph);
    ctx.direction = direction;
    for (const text of wrapParagraph(ctx, paragraph, CONTENT_WIDTH)) lines.push({ text, direction });
  }
  if (lines.length <= maxLines) return lines;
  const notice = `[TRUNCATED: ${maxLines} of ${lines.length} lines shown; SHA-256 below covers the full text]`;
  return [...lines.slice(0, maxLines), { text: notice, direction: 'ltr' }];
}
