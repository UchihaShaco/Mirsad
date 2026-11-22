/**
 * The URL fragment (pure): a one-time #token= sign-in, and the routes #/, #/chats/{chatId},
 * #/chats/{chatId}/messages/{messageId} and #/watchlist.
 */

const TOKEN_PREFIX = '#token=';
const INBOX = { view: 'inbox', chatId: null, messageId: null };

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function tokenFromFragment(hash) {
  if (!hash.startsWith(TOKEN_PREFIX)) return null;
  const token = decode(hash.slice(TOKEN_PREFIX.length));
  return token === null || token.trim() === '' ? null : token.trim();
}

export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((part) => part !== '').map(decode);
  if (parts.some((part) => part === null)) return INBOX;
  if (parts[0] === 'watchlist') return { view: 'watchlist', chatId: null, messageId: null };
  if (parts[0] !== 'chats' || !parts[1]) return INBOX;
  const messageId = parts[2] === 'messages' && parts[3] ? parts[3] : null;
  return { view: 'inbox', chatId: parts[1], messageId };
}

export function chatHref(chatId, messageId = null) {
  const base = `#/chats/${encodeURIComponent(chatId)}`;
  return messageId === null ? base : `${base}/messages/${encodeURIComponent(messageId)}`;
}
