/** Watchlist matches and evidence links for the case panel and Phone watchlist. */
import { bdi, h, timeEl } from '../dom.js';
import { OBSERVATION_ORIGIN_LABELS } from '../format.js';
import { chatHref } from '../state/route.js';

const MATCH_LABEL = 'Watchlist match';

/** Links to the supporting evidence the officer may open; the service lists only observations in accessible chats. */
export function evidenceList(evidence, restricted, scope = 'watchlist') {
  const items = evidence.map((ref) =>
    h('li', {}, [
      h('a', {
        href: chatHref(ref.chatId, ref.messageId), text: OBSERVATION_ORIGIN_LABELS[ref.origin] ?? ref.origin,
        dataset: { focusKey: `evidence:${scope}:${ref.observationId}` },
      }),
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
        evidenceList(match.evidence, match.restrictedEvidence, match.entryId),
      ]),
    ),
  );
}
