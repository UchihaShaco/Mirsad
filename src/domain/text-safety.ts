/**
 * The one text-safety step for anything drawn on a capture (design section 9). Text stays plain text: markup is
 * shown literally, and every invisible or direction-changing code point is replaced by a visible token such as
 * [U+202E]. Code points are written as numbers so this file stays ASCII and nothing invisible hides in it.
 */

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const TAB = String.fromCharCode(0x09);
const TAB_AS_SPACES = '    ';
const LINE_FEED = 0x0a;
const TOKEN_HEX_DIGITS = 4;

/**
 * Tokenised ranges: C0 and C1 controls (except LF and TAB, handled above), soft hyphen, Arabic letter mark, Hangul
 * fillers, Mongolian vowel separator, zero-width characters with LRM and RLM, line and paragraph separators, bidi
 * embeddings and overrides (202A-202E), word joiner, invisible operators and isolates (2060-206F), variation
 * selectors, BOM, interlinear annotation characters, tag characters and lone surrogates.
 */
const TOKEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], [0x000b, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c],
  [0x115f, 0x1160], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xd800, 0xdfff], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

/**
 * Tokens sit inside renderer-inserted FSI ... PDI (U+2068 / U+2069), so a Latin token behaves as a neutral inside
 * right-to-left text and cannot reorder the letters around it. Isolates in the input are tokenised themselves.
 */
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

const isTokenised = (codePoint: number): boolean => TOKEN_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

const visibleToken = (codePoint: number): string =>
  `${FSI}[U+${codePoint.toString(16).toUpperCase().padStart(TOKEN_HEX_DIGITS, '0')}]${PDI}`;

export interface DisplayTextOptions {
  /** Also show line breaks as tokens, for values drawn on one line (labels and IDs). */
  singleLine?: boolean;
}

export function toDisplayText(text: string, options: DisplayTextOptions = {}): string {
  const normalised = text.replaceAll(CR + LF, LF).replaceAll(CR, LF).replaceAll(TAB, TAB_AS_SPACES);
  const parts: string[] = [];
  // for...of walks code points and yields a lone surrogate as a single unit.
  for (const char of normalised) {
    const codePoint = char.codePointAt(0) ?? 0;
    const hidden = isTokenised(codePoint) || (options.singleLine === true && codePoint === LINE_FEED);
    parts.push(hidden ? visibleToken(codePoint) : char);
  }
  return parts.join('');
}
