/** Watchlist match badges and evidence links, shared by the inbox, the case panel and the Phone watchlist view. */
import { bdi, h, timeEl } from '../dom.js';
import { OBSERVATION_ORIGIN_LABELS } from '../format.js';
import { chatHref } from '../state/route.js';

const MATCH_LABEL = 'Watchlist match';

/** Links to the supporting evidence the officer may open; the service lists only observations in accessible chats. */
export function evidenceList(evidence, restricted) {
  const items = evidence.map((ref) =>
    h('li', {}, [
      h('a', { href: chatHref(ref.chatId, ref.messageId), text: OBSERVATION_ORIGIN_LABELS[ref.origin] ?? ref.origin }),
      h('span', { text: ': ' }),
      bdi(ref.sourceRepresentation),
      h('span', { text: ` (${ref.reason}) ` }),
      timeEl(ref.observedAt),
    ]),
  );
  return h('div', { className: 'evidence-block' }, [
    items.length > 0 ? h('ul', { className: 'evidence' }, items) : h('p', { className: 'hint', text: 'No evidence you can open.' }),
    restricted ? h('p', { className: 'hint', text: 'More evidence exists in chats you cannot open.' }) : null,
  ]);
}

export function matchList(matches) {
  return h(
    'ul',
    { className: 'matches' },
    matches.map((match) =>
      h('li', { dataset: { entryId: match.entryId } }, [
        h('strong', { className: 'badge badge-match', text: MATCH_LABEL }),
        h('span', { text: ' ' }),
        bdi(match.numberDisplay),
        h('span', { text: ' matched ' }),
        timeEl(match.matchedAt),
        evidenceList(match.evidence, match.restrictedEvidence),
      ]),
    ),
  );
}

/**
 * The compact inbox badge, shown only while the service lists a match with an approved entry: the number and a link
 * to each piece of supporting evidence the officer may open. The case panel shows the full detail.
 */
export function matchBadge(chat) {
  if (chat.watchlistMatches.length === 0) return null;
  const line = (match) =>
    h('p', { dataset: { entryId: match.entryId } }, [
      h('strong', { className: 'badge badge-match', text: MATCH_LABEL }),
      h('span', { text: ' ' }),
      bdi(match.numberDisplay),
      ...match.evidence.flatMap((ref) => [
        h('span', { text: ' ' }),
        h('a', { href: chatHref(ref.chatId, ref.messageId), text: OBSERVATION_ORIGIN_LABELS[ref.origin] ?? ref.origin }),
      ]),
      match.restrictedEvidence ? h('span', { className: 'hint', text: ' (more evidence in chats you cannot open)' }) : null,
    ]);
  return h('div', { className: 'chat-match' }, chat.watchlistMatches.map(line));
}
