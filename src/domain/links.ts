/**
 * Links in message text (design section 10): tokens bounded by whitespace, brackets and quotes; host normalization
 * shared with case references; and payment link detection in code, so the Suspected fraud rule never depends on what
 * a reviewer chose to report. This is the only place in the code base that parses or normalizes a link.
 */
import { hasPaymentCue } from './cues.ts';

const TOKEN = /[^\s()[\]{}<>"'`«»“”‘’„‹›]+/gu;
const EDGE_PUNCTUATION = /^[.,;:!?…،؛؟]+|[.,;:!?…،؛؟]+$/g;
const WEB_SCHEME = /^https?:\/\//i;
/** Another scheme, such as mailto: or javascript:. A colon followed by a digit is a port, not a scheme. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const URL_START = /^(?:https?:\/\/|www\.)/i;
const PATH_START = /[/\\?#]/;
const WHITESPACE = /\s/;
const TRAILING_DOT = /\.$/;
const WWW_PREFIX = 'www.';
const PAYMENT_URL_HINTS = ['pay', 'checkout', 'invoice', 'billing'];

export interface TextToken {
  text: string;
  start: number;
  end: number;
}

export function tokenize(text: string): TextToken[] {
  return [...text.matchAll(TOKEN)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

/** Drops sentence punctuation stuck to either end of a token. */
export function trimEdgePunctuation(token: string): string {
  return token.replace(EDGE_PUNCTUATION, '');
}

/** The trimmed line of the text that holds the offset: always an exact substring of the text, usable as a quote. */
export function lineAt(text: string, offset: number): string {
  const start = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end < 0 ? text.length : end).trim();
}

/** An http(s) URL, with https:// assumed when no scheme is written; null for anything else. */
function parseWebUrl(input: string): URL | null {
  const value = input.trim();
  if (value === '' || WHITESPACE.test(value)) return null;
  const hasWebScheme = WEB_SCHEME.test(value);
  if (!hasWebScheme && OTHER_SCHEME.test(value)) return null;
  try {
    return new URL(hasWebScheme ? value : `https://${value}`);
  } catch {
    return null;
  }
}

/**
 * The lower-case punycode host name of a host, host:port or URL, without a leading www., the port or a trailing dot.
 * Null when the input does not parse to a host name that contains a dot.
 */
export function normalizeHost(input: string): string | null {
  const url = parseWebUrl(input);
  if (!url) return null;
  const host = url.hostname.replace(TRAILING_DOT, '');
  const bare = host.startsWith(WWW_PREFIX) && host.slice(WWW_PREFIX.length).includes('.') ? host.slice(WWW_PREFIX.length) : host;
  return bare.includes('.') ? bare : null;
}

/** Path and query exactly as written (no fragment); a missing path reads as /. */
function pathAndQueryAsWritten(link: string): string {
  const afterScheme = link.replace(WEB_SCHEME, '');
  const start = afterScheme.search(PATH_START);
  const rest = start < 0 ? '' : afterScheme.slice(start);
  const fragmentAt = rest.indexOf('#');
  const pathAndQuery = fragmentAt < 0 ? rest : rest.slice(0, fragmentAt);
  return pathAndQuery.startsWith('/') || pathAndQuery.startsWith('\\') ? pathAndQuery : `/${pathAndQuery}`;
}

/** normalizeHost(host) + path + query as written; trailing sentence punctuation is not part of a link. */
export function normalizeLink(value: string): string | null {
  const written = trimEdgePunctuation(value.trim());
  const host = normalizeHost(written);
  return host === null ? null : `${host}${pathAndQueryAsWritten(written)}`;
}

export function hostOfNormalizedLink(normalized: string): string {
  const end = normalized.search(/[/\\]/);
  return end < 0 ? normalized : normalized.slice(0, end);
}

const isUrlToken = (token: string): boolean => URL_START.test(token) && normalizeHost(token) !== null;

/** http, https and www. URLs written as whole tokens, without edge punctuation, each once, in order. */
export function extractUrlTokens(text: string): string[] {
  const urls = tokenize(text)
    .map((token) => trimEdgePunctuation(token.text))
    .filter(isUrlToken);
  return [...new Set(urls)];
}

/** Where a URL that extractUrlTokens returned first appears as a token of the text. */
export function urlTokenOffset(text: string, url: string): number {
  return tokenize(text).find((token) => trimEdgePunctuation(token.text) === url)?.start ?? 0;
}

/** The text with every URL token blanked out (same length), so cues and numbers inside links are not read as prose. */
export function maskUrls(text: string): string {
  return tokenize(text)
    .filter((token) => isUrlToken(trimEdgePunctuation(token.text)))
    .reduce((masked, token) => masked.slice(0, token.start) + ' '.repeat(token.end - token.start) + masked.slice(token.end), text);
}

function namesPayment(url: string): boolean {
  const parsed = parseWebUrl(url);
  if (!parsed) return false;
  const where = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  return PAYMENT_URL_HINTS.some((hint) => where.includes(hint));
}

/**
 * The URLs of a message that count as payment links: all of them when the prose carries a payment cue, otherwise
 * those whose host or path names pay, checkout, invoice or billing.
 */
export function detectPaymentLinks(text: string): string[] {
  const cue = hasPaymentCue(maskUrls(text));
  return extractUrlTokens(text).filter((url) => cue || namesPayment(url));
}

/** A payment link the code-side check found in a text. */
export interface FoundPaymentLink {
  /** The URL token as written, without edge punctuation. */
  url: string;
  normalizedValue: string;
  /** The trimmed line the URL is on: an exact substring of the text. */
  quote: string;
}

/** The payment links of a text (detectPaymentLinks), each once by normalized value, in the order they appear. */
export function findPaymentLinks(text: string): FoundPaymentLink[] {
  const seen = new Set<string>();
  return detectPaymentLinks(text).flatMap((url) => {
    const normalizedValue = normalizeLink(url);
    if (normalizedValue === null || seen.has(normalizedValue)) return [];
    seen.add(normalizedValue);
    return [{ url, normalizedValue, quote: lineAt(text, urlTokenOffset(text, url)) }];
  });
}
