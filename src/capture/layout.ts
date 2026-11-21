/**
 * Capture card geometry and body text layout (design section 19.6). Canvas shapes each drawn line and applies the
 * Unicode bidi algorithm to it; this module supplies what canvas lacks: paragraph splitting, each paragraph's base
 * direction, greedy word wrapping on measured width and grapheme-safe breaking of tokens wider than the card.
 *
 * Wrapping is greedy: a line takes as many whole tokens (words and runs of spaces) as fit, and a word wider than the
 * card is cut between graphemes. Each line end is found by a galloping search (lastFitting) instead of by adding one
 * token or grapheme at a time, so a line costs a few measureText calls whatever the text holds. Adding a token to a
 * line never makes it narrower, so the search finds the same breaks. Inside a word, joining can make an Arabic
 * letter narrower than its final form; where that happens at the card edge, a cut may land a grapheme or two later.
 * Every line still fits.
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
const SPACE = 0x20;
const SPACE_RUN = /( +)/;
const TRAILING_SPACES = / +$/;
/** A slice longer than this (about nine lines of Latin text) is measured by its start first. */
const LONG_SLICE_UNITS = 1_024;
/** Pixels by which a cut start may measure wider than inside the whole slice (an Arabic final form is under ten). */
const CUT_SLACK = 64;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

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

/** The line lengths last seen, in tokens and in graphemes: where the next search starts. */
export interface WrapGuesses {
  tokens: number;
  graphemes: number;
}

/** One paragraph being wrapped. `starts` holds each token's start offset, then the paragraph length. */
interface ParagraphScan {
  text: string;
  starts: readonly number[];
  fits: (from: number, to: number) => boolean;
  guesses: WrapGuesses;
  word: { token: number; bounds: readonly number[] } | null;
}

/** Where the next line starts: an offset inside token `token`, or the paragraph end. */
interface Cursor {
  token: number;
  offset: number;
}

/** A line to add (null adds none) and where the line after it starts (null ends the paragraph). */
interface Step {
  line: string | null;
  next: Cursor | null;
}

const newGuesses = (): WrapGuesses => ({ tokens: 1, graphemes: 1 });

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`layout_index_out_of_range: ${index}`);
  return value;
}

/** The last index whose value is at most `value`, in an ascending array. */
function lastAtMost(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (at(values, middle) <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The largest index in [low, high] that fits. low is the caller's floor (known to fit, or a forced minimum) and is
 * never tested; fits must hold up to some index and fail after it. The search tests `guess` first, gallops from it
 * with steps of 1, 2, 4 and so on, then bisects. A guess within one of the answer costs two to four calls.
 */
function lastFitting(low: number, high: number, guess: number, fits: (index: number) => boolean): number {
  let lo = low;
  let hi = high;
  if (lo >= hi) return lo;
  const first = Math.min(Math.max(guess, lo + 1), hi);
  if (fits(first)) {
    lo = first;
    for (let step = 1; lo < hi; step *= 2) {
      const next = Math.min(lo + step, hi);
      if (!fits(next)) {
        hi = next - 1;
        break;
      }
      lo = next;
    }
  } else {
    hi = first - 1;
    for (let step = 1; lo < hi; step *= 2) {
      const next = Math.max(hi - step + 1, lo + 1);
      if (fits(next)) {
        lo = next;
        break;
      }
      hi = next - 1;
    }
  }
  while (lo < hi) {
    const middle = lo + Math.ceil((hi - lo) / 2);
    if (fits(middle)) lo = middle;
    else hi = middle - 1;
  }
  return lo;
}

/** Moves a cut back by one unit when it would split a surrogate pair. */
function codePointCut(text: string, index: number): number {
  const unit = text.charCodeAt(index - 1);
  return unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST ? index - 1 : index;
}

/**
 * Whether text[from, to) fits. A long slice whose start alone is well past the card edge overflows whole, so it is
 * not measured in full: one message can be a single token of over half a million units.
 */
function sliceFitter(ctx: SKRSContext2D, text: string, maxWidth: number): (from: number, to: number) => boolean {
  const width = (from: number, to: number): number => ctx.measureText(text.slice(from, to)).width;
  return (from, to) => {
    if (to - from > LONG_SLICE_UNITS && width(from, codePointCut(text, from + LONG_SLICE_UNITS)) > maxWidth + CUT_SLACK) return false;
    return width(from, to) <= maxWidth;
  };
}

/** Each token's start offset, then the paragraph length. Words and runs of spaces alternate. */
function tokenStarts(paragraph: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const token of paragraph.split(SPACE_RUN)) {
    if (token === '') continue;
    starts.push(offset);
    offset += token.length;
  }
  starts.push(offset);
  return starts;
}

const isSpaceRun = (scan: ParagraphScan, token: number): boolean => scan.text.charCodeAt(at(scan.starts, token)) === SPACE;
const trimTrailingSpaces = (line: string): string => line.replace(TRAILING_SPACES, '');

/** The grapheme boundaries of word `token`, both ends included; kept while the word is being cut. */
function wordBounds(scan: ParagraphScan, token: number): readonly number[] {
  if (scan.word?.token === token) return scan.word.bounds;
  const start = at(scan.starts, token);
  const bounds: number[] = [];
  for (const { index } of graphemes.segment(scan.text.slice(start, at(scan.starts, token + 1)))) bounds.push(start + index);
  bounds.push(at(scan.starts, token + 1));
  scan.word = { token, bounds };
  return bounds;
}

/** The token index a line from `from` stops at: the tokens before it fit. `floor` tokens are known to fit already. */
function tokenLineEnd(scan: ParagraphScan, from: number, first: number, floor: number): number {
  const end = lastFitting(floor, scan.starts.length - 1, first + scan.guesses.tokens, (token) => scan.fits(from, at(scan.starts, token)));
  if (end > first) scan.guesses.tokens = end - first;
  return end;
}

/** Where a piece of word `token` that starts at `from` ends: as many graphemes as fit, and at least one. */
function pieceEnd(scan: ParagraphScan, token: number, from: number): number {
  const bounds = wordBounds(scan, token);
  const start = lastAtMost(bounds, from);
  const end = lastFitting(start + 1, bounds.length - 1, start + scan.guesses.graphemes, (index) => scan.fits(from, at(bounds, index)));
  scan.guesses.graphemes = end - start;
  return at(bounds, end);
}

/** Ends the line from `from` before token `end`: a run of spaces there is dropped, trailing spaces are trimmed. */
function closeLine(scan: ParagraphScan, from: number, end: number): Step {
  const stop = at(scan.starts, end);
  if (end === scan.starts.length - 1) return { line: trimTrailingSpaces(scan.text.slice(from)), next: null };
  if (isSpaceRun(scan, end)) return { line: scan.text.slice(from, stop), next: { token: end + 1, offset: at(scan.starts, end + 1) } };
  const line = scan.text.slice(from, stop);
  return { line: line.trim() ? trimTrailingSpaces(line) : null, next: { token: end, offset: stop } };
}

/** The next line from `cursor`, by the greedy rule: whole tokens while they fit, a word too wide alone is cut. */
function nextLine(scan: ParagraphScan, { token, offset }: Cursor): Step {
  if (offset === scan.text.length) return { line: '', next: null };
  const tokenEnd = at(scan.starts, token + 1);
  if (offset === at(scan.starts, token)) {
    const end = tokenLineEnd(scan, offset, token, token);
    if (end > token) return closeLine(scan, offset, end);
    // Nothing fits: a run of spaces is dropped, a word is cut below.
    if (isSpaceRun(scan, token)) return { line: null, next: { token: token + 1, offset: tokenEnd } };
  }
  const cut = pieceEnd(scan, token, offset);
  if (cut < tokenEnd) return { line: scan.text.slice(offset, cut), next: { token, offset: cut } };
  // The rest of the word fits, so the line goes on with the tokens after it.
  return closeLine(scan, offset, tokenLineEnd(scan, offset, token, token + 1));
}

/**
 * Greedy wrapping on measured width. Spaces at a line break are dropped; no other character is. `guesses` carries
 * line lengths from one paragraph to the next.
 */
export function wrapParagraph(ctx: SKRSContext2D, paragraph: string, maxWidth: number, guesses: WrapGuesses = newGuesses()): string[] {
  if (paragraph === '') return [''];
  const scan: ParagraphScan = { text: paragraph, starts: tokenStarts(paragraph), fits: sliceFitter(ctx, paragraph, maxWidth), guesses, word: null };
  const lines: string[] = [];
  let cursor: Cursor | null = { token: 0, offset: 0 };
  while (cursor) {
    const step = nextLine(scan, cursor);
    if (step.line !== null) lines.push(step.line);
    cursor = step.next;
  }
  return lines;
}

/**
 * Every line of the display text. Beyond maxLines the body is cut and a visible notice line says so; the lines past
 * the cut are still wrapped, at the same few measureText calls per line, so the notice can give their number.
 */
export function layoutBody(ctx: SKRSContext2D, displayText: string, maxLines: number): BodyLine[] {
  ctx.font = BODY_FONT;
  const guesses = newGuesses();
  const lines: BodyLine[] = [];
  for (const paragraph of displayText.split(LF)) {
    const direction = baseDirection(paragraph);
    ctx.direction = direction;
    for (const text of wrapParagraph(ctx, paragraph, CONTENT_WIDTH, guesses)) lines.push({ text, direction });
  }
  if (lines.length <= maxLines) return lines;
  const notice = `[TRUNCATED: ${maxLines} of ${lines.length} lines shown; SHA-256 below covers the full text]`;
  return [...lines.slice(0, maxLines), { text: notice, direction: 'ltr' }];
}
