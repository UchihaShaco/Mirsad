/**
 * Case references (design section 10, "Case references"): an officer records a merchant's payment confirmation for a
 * chat. Hosts are normalized the same way link hosts are, then every payment link already found in the chat whose host
 * none of the chat's confirmations lists is flagged as Suspected fraud. This is a rule over stored evidence and an
 * officer-entered fact, so it runs in any AI mode.
 */
import type { Concern } from '../contract/enums.ts';
import { AppError } from '../contract/errors.ts';
import { LABELS } from '../contract/labels.ts';
import type { CaseReference, CaseReferenceRequest } from '../contract/schemas.ts';
import { hostOfNormalizedLink, normalizeHost } from '../domain/links.ts';
import type { Principal } from '../ports/identity.ts';
import { findingNote } from '../review/notes.ts';
import type { Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { insertCaseReference, listCaseReferences, paymentHostsOf } from '../storage/repos/case-references.ts';
import { findCitedEvidence, insertFinding, listFindingsOfKind } from '../storage/repos/findings.ts';
import type { CaseReferenceRow, ChatRow, FindingRow } from '../storage/rows.ts';
import { requireChat } from './access.ts';
import * as watchlist from './watchlist.ts';

export interface RecordCaseReferenceResult {
  caseReference: CaseReference;
  findingsCreated: number;
}

/** Normalized and de-duplicated; a value that does not parse is 400 validation_failed naming its position. */
function normalizePaymentHosts(hosts: readonly string[]): string[] {
  const normalized = hosts.map(normalizeHost);
  const fields = normalized.flatMap((host, index) =>
    host === null ? [{ path: `paymentHosts.${index}`, message: 'Expected a host name, host:port or URL' }] : [],
  );
  if (fields.length > 0) throw AppError.of('validation_failed', 'The request is not valid.', { fields });
  return [...new Set(normalized.filter((host): host is string => host !== null))];
}

/** Suspected fraud for each stored payment link whose host the chat's confirmations do not list. */
function flagExistingLinks(tx: Tx, chat: ChatRow, caseReferenceId: string): FindingRow[] {
  const confirmed = new Set(listCaseReferences(tx, chat.id).flatMap(paymentHostsOf));
  return listFindingsOfKind(tx, chat.id, 'payment_link')
    .filter((link) => !confirmed.has(hostOfNormalizedLink(link.normalized_value)))
    .flatMap((link) => {
      const { message } = findCitedEvidence(tx, link);
      const flagged = insertFinding(tx, {
        chatId: chat.id,
        workspaceId: chat.workspace_id,
        reviewId: null,
        messageId: link.message_id,
        messageEventId: link.message_event_id,
        kind: 'suspected_fraud',
        quote: link.quote,
        extractedValue: link.extracted_value,
        normalizedValue: link.normalized_value,
        concern: link.concern as Concern | null,
        changedFrom: link.changed_from,
        caseReferenceId,
        note: findingNote(LABELS.suspectedFraud, message.direction),
      });
      return flagged ? [flagged] : [];
    });
}

/** One watchlist call per message event that gained Suspected fraud findings. */
function notifyWatchlist(tx: Tx, chat: ChatRow, flagged: readonly FindingRow[]): void {
  const byEvent = new Map<string, FindingRow[]>();
  for (const finding of flagged) byEvent.set(finding.message_event_id, [...(byEvent.get(finding.message_event_id) ?? []), finding]);
  for (const findings of byEvent.values()) {
    const [first] = findings;
    if (!first) continue;
    watchlist.onEvidencePublished(tx, { chat, ...findCitedEvidence(tx, first) }, {
      phoneMentions: [],
      suspectedFraudFindingIds: findings.map((finding) => finding.id),
    });
  }
}

function toCaseReference(row: CaseReferenceRow, officer: Principal): CaseReference {
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind,
    paymentHosts: paymentHostsOf(row),
    sourceNote: row.source_note,
    recordedBy: { id: officer.id, displayName: officer.displayName },
    recordedAt: row.recorded_at,
  };
}

export function recordCaseReference(tx: Tx, officer: Principal, chatId: string, input: CaseReferenceRequest): RecordCaseReferenceResult {
  const chat = requireChat(tx, officer, chatId);
  const paymentHosts = normalizePaymentHosts(input.paymentHosts);
  const reference = insertCaseReference(tx, {
    chatId: chat.id,
    workspaceId: chat.workspace_id,
    paymentHosts,
    sourceNote: input.sourceNote,
    recordedBy: officer.id,
  });
  caseActions.record(tx, {
    chatId: chat.id,
    workspaceId: chat.workspace_id,
    type: 'case_reference_recorded',
    actorId: officer.id,
    detail: { caseReferenceId: reference.id },
  });
  const flagged = flagExistingLinks(tx, chat, reference.id);
  notifyWatchlist(tx, chat, flagged);
  return { caseReference: toCaseReference(reference, officer), findingsCreated: flagged.length };
}
