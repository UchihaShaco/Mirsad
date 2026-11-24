import { describe, expect, it } from 'vitest';
import { maskSensitiveText, truncateText } from '../../src/domain/masked-text.ts';

describe('masked text', () => {
  it('masks links, e-mail addresses, handles and long numbers and folds the text onto one line', () => {
    expect(maskSensitiveText('Pay https://pay.example.test/x\nor pay.example.test/y\nmail a@example.test, ask @fixture_user, acct 0000 0012 3456'))
      .toBe('Pay [link] or [link] mail [email], ask [handle], acct [number]');
  });

  it('keeps Arabic text and masks Arabic-Indic digits', () => {
    expect(maskSensitiveText('مرحبا، رقمي ٠١٢٣٤٥٦٧')).toBe('مرحبا، رقمي [number]');
  });

  it('cuts at a word boundary and marks the cut', () => {
    expect(truncateText('one two three four five', 12)).toBe('one two…');
    expect(truncateText('short', 12)).toBe('short');
  });
});
