import { createHash } from 'node:crypto';
import { extractUrlTokens, hostOfNormalizedLink, maskUrls, normalizeTelegramLink, urlTokenOffset } from '../domain/links.ts';
import type { ModelPaymentLinkCandidate } from './reply-generator.ts';

const MAX_CANDIDATES = 8;
const EXCERPT_SIDE_LENGTH = 160;

export interface PaymentLinkSource {
  messageId: string;
  messageEventId: string;
  itemKey: string;
}

export type PaymentLinkCandidate = ModelPaymentLinkCandidate & PaymentLinkSource;

interface SourceText {
  messageId: string;
  messageEventId: string;
  text: string;
}

export function paymentLinkKey(chatId: string, normalizedUrl: string): string {
  return createHash('sha256').update(JSON.stringify([chatId, 'payment_link', normalizedUrl])).digest('hex');
}

function excerptFor(text: string, masked: string, url: string): string {
  const offset = urlTokenOffset(text, url);
  const end = offset + url.length;
  const before = masked.slice(Math.max(0, offset - EXCERPT_SIDE_LENGTH), offset).trim();
  const after = masked.slice(end, end + EXCERPT_SIDE_LENGTH).trim();
  return `${before} [candidate link] ${after}`.trim();
}

/** The model can select an index. The local event ID and link digest establish the actual citation. */
export function candidatePaymentLinks(chatId: string, sources: readonly SourceText[], alreadyFlagged: readonly string[]): PaymentLinkCandidate[] {
  const seen = new Set(alreadyFlagged);
  const candidates: PaymentLinkCandidate[] = [];
  for (const { messageId, messageEventId, text } of sources) {
    const urls = extractUrlTokens(text, normalizeTelegramLink);
    if (urls.length === 0) continue;
    const masked = maskUrls(text, normalizeTelegramLink);
    for (const url of urls) {
      const normalized = normalizeTelegramLink(url);
      if (!normalized) continue;
      const itemKey = paymentLinkKey(chatId, normalized);
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);
      candidates.push({ id: candidates.length + 1, messageId, messageEventId, itemKey,
        host: hostOfNormalizedLink(normalized), excerpt: excerptFor(text, masked, url) });
      if (candidates.length === MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}
