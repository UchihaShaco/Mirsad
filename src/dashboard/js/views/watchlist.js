/**
 * The Phone watchlist view (design sections 6 and 11): each entry with its status, first and last seen times, the
 * evidence the officer may open, matches and the last decision, plus approve, clear and reopen with a required reason.
 * The decisions offered mirror section 11; the service decides and answers a stale or refused one with an error.
 */
import { bdi, clear, h, timeEl, withFocus } from '../dom.js';
import { chatHref } from '../state/route.js';
import { evidenceList } from './matches.js';

const REASON_MIN = 3;
const REASON_MAX = 500;
const DECISIONS_BY_STATUS = { needs_review: ['approve', 'clear'], approved: ['clear', 'reopen'], cleared: ['reopen'] };
const DECISION_LABELS = { approve: 'Approve', clear: 'Clear', reopen: 'Reopen' };
const DECISION_PAST = { approve: 'Approved', clear: 'Cleared', reopen: 'Reopened' };

function lastDecision(decision) {
  if (decision === null) return h('p', { className: 'hint', text: 'No review decision yet.' });
  const parts = [h('span', { text: `${DECISION_PAST[decision.decision]} by ` }), bdi(decision.officer.displayName), h('span', { text: ', ' }), timeEl(decision.decidedAt)];
  if (decision.reason !== null) parts.push(h('span', { text: '. Reason: ' }), h('span', { dir: 'auto', text: decision.reason }));
  return h('p', {}, parts);
}

function matches(entry) {
  if (entry.matches.length === 0) return null;
  return h('ul', { className: 'evidence' }, entry.matches.map((match) =>
    h('li', {}, [h('a', { href: chatHref(match.chatId), text: 'Matched inbound chat' }), h('span', { text: ', ' }), timeEl(match.matchedAt)]),
  ));
}

function reviewForm(entry, state, handlers, drafts) {
  const inputId = `reason-${entry.id}`;
  const reason = h('textarea', { id: inputId, rows: 2, maxlength: REASON_MAX, dir: 'auto', value: drafts.get(entry.id) ?? '', dataset: { focusKey: `reason:${entry.id}` } });
  const buttons = (DECISIONS_BY_STATUS[entry.status] ?? []).map((decision) =>
    h('button', { type: 'submit', value: decision, text: DECISION_LABELS[decision], dataset: { focusKey: `decide:${entry.id}:${decision}` } }),
  );
  const update = () => {
    const ready = reason.value.trim().length >= REASON_MIN && state.pending === null;
    for (const button of buttons) button.disabled = !ready;
  };
  reason.addEventListener('input', () => {
    drafts.set(entry.id, reason.value);
    update();
  });
  const form = h('form', { className: 'review-form' }, [
    h('label', { for: inputId, text: `Reason (required, ${REASON_MIN} to ${REASON_MAX} characters)` }),
    reason,
    h('div', { className: 'review-actions' }, buttons),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const decision = event.submitter instanceof HTMLButtonElement ? event.submitter.value : null;
    if (decision) handlers.onReviewEntry(entry, decision, reason.value.trim());
  });
  update();
  return form;
}

function entryCard(entry, state, handlers, drafts) {
  return h('article', { className: 'wl-entry', dataset: { entryId: entry.id, status: entry.status } }, [
    h('h2', {}, [bdi(entry.number.display)]),
    h('p', {}, [
      h('strong', { className: 'badge', text: entry.statusLabel }),
      entry.newEvidenceSinceReview ? h('span', { className: 'flag', text: ' New evidence since the last review' }) : null,
      entry.number.exactMatchEligible ? null : h('span', { className: 'hint', text: ' Not normalized: never matched automatically' }),
      // Contact sync (null while it is off): whether the number reached the "Known Scammer" contact on phones.
      entry.contactSync
        ? h('span', { className: entry.contactSync.state === 'not_sent' ? 'flag' : 'hint', dataset: { contactSync: entry.contactSync.state }, text: ` ${entry.contactSync.label}` })
        : null,
    ]),
    h('p', { className: 'hint' }, [h('span', { text: 'First seen ' }), timeEl(entry.firstSeenAt), h('span', { text: ', last seen ' }), timeEl(entry.lastSeenAt)]),
    h('h3', { text: 'Evidence' }),
    evidenceList(entry.evidence, entry.restrictedEvidence),
    matches(entry),
    lastDecision(entry.lastDecision),
    entry.canReview ? reviewForm(entry, state, handlers, drafts) : h('p', { className: 'hint', text: 'You can view this entry; reviewing it needs access to its evidence.' }),
  ]);
}

function statusMessage(watchlist, handlers) {
  if (watchlist.status === 'unavailable') return h('p', { className: 'placeholder', text: 'Watchlist is not available yet.' });
  if (watchlist.status === 'error') {
    const retry = h('button', { type: 'button', text: 'Try again' });
    retry.addEventListener('click', () => handlers.onReloadWatchlist());
    return h('div', {}, [h('p', { className: 'error', text: watchlist.message ?? 'The watchlist could not be loaded.' }), retry]);
  }
  if (watchlist.status !== 'ready') return h('p', { className: 'placeholder', text: 'Loading the watchlist.' });
  if (watchlist.entries.length === 0) return h('p', { className: 'placeholder', text: 'No phone numbers on the watchlist.' });
  return null;
}

export function createWatchlistView(container) {
  const drafts = new Map();
  return {
    render(state, handlers) {
      withFocus(container, () => {
        clear(container);
        const message = statusMessage(state.watchlist, handlers);
        if (message !== null) container.append(message);
        if (state.watchlist.entries.length === 0) return;
        container.append(h('div', { className: 'wl-entries' }, state.watchlist.entries.map((entry) => entryCard(entry, state, handlers, drafts))));
      });
    },
    clearDraft(entryId) {
      drafts.delete(entryId);
    },
    clearDrafts() { drafts.clear(); },
  };
}
