/**
 * Text an officer reads outside its source message: one line, with links (with or without a scheme), e-mail addresses,
 * handles and long numbers masked, so a secondary surface never repeats a value that belongs only in the message itself.
 */
import { maskUrls } from './links.ts';

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const HANDLE = /(^|[^\p{L}\p{N}_])@[A-Za-z0-9_]{3,32}/gu;
/** A host written without a scheme, such as pay.example.test/checkout. */
const BARE_HOST = /(?<![\p{L}\p{N}@._-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:[/?#][^\s]*)?/gu;
/** Six or more digits, in any script, with the separators people type: phone, account and card numbers, IBAN digits. */
const LONG_NUMBER = /\+?[0-9٠-٩۰-۹](?:[\s().\/-]*[0-9٠-٩۰-۹]){5,}/gu;
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/gu;
const EDGE_QUOTES = /^["'“”‘’«»„]+|["'“”‘’«»„]+$/gu;

/** Each link in `text` becomes "[link]"; maskUrls blanks a link's characters in place, so positions line up. */
function withLinksMasked(text: string): string {
  const masked = maskUrls(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (masked[i] === text[i]) out += text[i];
    else if (masked[i - 1] === text[i - 1] || i === 0) out += '[link]';
  }
  return out;
}

/** Masks contact and payment values and folds the text onto one line. Quotes at the edges are dropped. */
export function maskSensitiveText(value: string): string {
  return withLinksMasked(value.normalize('NFKC').replace(HIDDEN_CHARACTERS, ' '))
    .replace(EMAIL, '[email]')
    .replace(HANDLE, '$1[handle]')
    .replace(BARE_HOST, '[link]')
    .replace(LONG_NUMBER, '[number]')
    .replace(/[`{}]/gu, '')
    .replace(/_/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(EDGE_QUOTES, '')
    .trim();
}

/** Shortens at a word boundary when one is near, and marks the cut with an ellipsis. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.،؛-]+$/u, '') + '…';
}
