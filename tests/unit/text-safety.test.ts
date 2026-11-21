import { describe, expect, it } from 'vitest';
import { toDisplayText } from '../../src/domain/text-safety.ts';

// Code points are built at run time so this file stays ASCII and no invisible character hides in it.
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
const FSI = cp(0x2068);
const PDI = cp(0x2069);
/** The visible token the renderer draws for a code point, isolated so it cannot reorder surrounding text. */
const token = (codePoint: number): string => `${FSI}[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]${PDI}`;
const BIDI_CONTROLS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

describe('toDisplayText', () => {
  it('toDisplayText shows markup literally and replaces bidi controls with visible tokens', () => {
    const markup = '<b>bold</b> &amp; <script>alert(1)</script> <img src=x onerror=alert(2)>';
    expect(toDisplayText(markup)).toBe(markup);

    expect(toDisplayText(`invoice${cp(0x202e)}gnp.exe`)).toBe(`invoice${token(0x202e)}gnp.exe`);
    for (const control of BIDI_CONTROLS) {
      expect(toDisplayText(`a${cp(control)}b`)).toBe(`a${token(control)}b`);
    }
  });

  it('other control and invisible characters become tokens while newlines and tabs stay readable', () => {
    const invisible = [0x00, 0x07, 0x1b, 0x7f, 0x85, 0xad, 0x061c, 0x200b, 0x200d, 0x200e, 0x2028, 0x2060, 0xfeff, 0xe0041];
    for (const codePoint of invisible) {
      expect(toDisplayText(`x${cp(codePoint)}y`)).toBe(`x${token(codePoint)}y`);
    }
    expect(token(0xe0041)).toContain('[U+E0041]');
    expect(toDisplayText('line one\r\nline two\rline three\nline four')).toBe('line one\nline two\nline three\nline four');
    expect(toDisplayText('a\tb')).toBe('a    b');
  });

  it('a lone surrogate becomes a token', () => {
    expect(toDisplayText(`a${String.fromCharCode(0xd83d)}b`)).toBe(`a${token(0xd83d)}b`);
  });

  it('the single-line form also shows line breaks as tokens', () => {
    expect(toDisplayText('Test\r\nContact\nTwo', { singleLine: true })).toBe(`Test${token(0x0a)}Contact${token(0x0a)}Two`);
    expect(toDisplayText(`x${cp(0x202e)}y`, { singleLine: true })).toBe(`x${token(0x202e)}y`);
  });

  it('ordinary Arabic, English, digits and emoji pass through unchanged', () => {
    const arabic = cp(0x0645, 0x0631, 0x062d, 0x0628, 0x0627);
    const text = `${arabic} Hello 123 ${cp(0x0661, 0x0662)} ${cp(0x1f44d)} caf${cp(0xe9)}${cp(0xa0)}end`;
    expect(toDisplayText(text)).toBe(text);
  });
});
