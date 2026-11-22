/**
 * Case references (design section 10, "Case references"): an officer records a merchant's payment confirmation for a
 * chat. Hosts are normalized the same way link hosts are. Then every payment link of the chat whose host none of the
 * chat's confirmations lists is flagged as Suspected fraud: the stored payment link findings, and the links the
 * code-side check finds in the stored text of every incoming message event, so the rule never depends on what the
 * model reported. This is a rule over stored evidence and an officer-entered fact, so it runs in any AI mode and for
 * any capture method.
 */
import type { Concern, Direction } from '../contract/enums.ts';
import { AppError } from '../contract/errors.ts';
import { LABELS } from '../contract/labels.ts';
import type { CaseReference, CaseReferenceRequest } from '../contract/schemas.ts';
import { findPaymentLinks, hostOfNormalizedLink, normalizeHost } from '../domain/links.ts';
import type { Principal } from '../ports/identity.ts';
import { findingNote } from '../review/notes.ts';
import type { Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { recordCaseDetail } from '../storage/repos/case-details.ts';
import { insertCaseReference, listCaseReferences, paymentHostsOf } from '../storage/repos/case-references.ts';
import { findCitedEvidence, insertFinding, listFindingsOfKind } from '../storage/repos/findings.ts';
import { listIncomingTextEvents } from '../storage/repos/messages.ts';
import type { ChatRow, FindingRow } from '../storage/rows.ts';
import { requireChat } from './access.ts';
import { principalLookup, toCaseReference } from './mappers.ts';
import * as watchlist from './watchlist.ts';

export interface RecordCaseReferenceResult {
  caseReference: CaseReference;
  findingsCreated: number;
}

/** What one confirmation is checked against. */
interface FraudCheck {
  chat: ChatRow;
  caseReferenceId: string;
  confirmedHosts: ReadonlySet<string>;
  /** The hosts each message event already has a Suspected fraud finding for. */
  flaggedHosts: Map<string, Set<string>>;
}

/** A conflicting link and the message event it is quoted from. */
interface ConflictingLink {
  messageId: string;
  messageEventId: string;
  direction: Direction | null;
  quote: string;
  extractedValue: string;
  normalizedValue: string;
  concern: Concern | null;
  changedFrom: string | null;
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

function markFlagged(check: FraudCheck, finding: Pick<FindingRow, 'message_event_id' | 'normalized_value'>): void {
  const hosts = check.flaggedHosts.get(finding.message_event_id) ?? new Set<string>();
  check.flaggedHosts.set(finding.message_event_id, hosts.add(hostOfNormalizedLink(finding.normalized_value)));
}

function startCheck(tx: Tx, chat: ChatRow, caseReferenceId: string): FraudCheck {
  const confirmedHosts = new Set(listCaseReferences(tx, chat.id).flatMap(paymentHostsOf));
  const check: FraudCheck = { chat, caseReferenceId, confirmedHosts, flaggedHosts: new Map() };
  for (const finding of listFindingsOfKind(tx, chat.id, 'suspected_fraud')) markFlagged(check, finding);
  return check;
}

/** The Suspected fraud finding for one conflicting link, citing the new reference; none when the event already has it. */
function flag(tx: Tx, check: FraudCheck, link: ConflictingLink): FindingRow[] {
  const flagged = insertFinding(tx, {
    chatId: check.chat.id,
    workspaceId: check.chat.workspace_id,
    reviewId: null,
    messageId: link.messageId,
    messageEventId: link.messageEventId,
    kind: 'suspected_fraud',
    quote: link.quote,
    extractedValue: link.extractedValue,
    normalizedValue: link.normalizedValue,
    concern: link.concern,
    changedFrom: link.changedFrom,
    caseReferenceId: check.caseReferenceId,
    note: findingNote(LABELS.suspectedFraud, link.direction),
  });
  if (!flagged) return [];
  markFlagged(check, flagged);
  return [flagged];
}

/** Suspected fraud for each stored payment link finding whose host the chat's confirmations do not list. */
function flagStoredLinkFindings(tx: Tx, check: FraudCheck): FindingRow[] {
  return listFindingsOfKind(tx, check.chat.id, 'payment_link')
    .filter((link) => !check.confirmedHosts.has(hostOfNormalizedLink(link.normalized_value)))
    .flatMap((link) => flag(tx, check, {
      messageId: link.message_id,
      messageEventId: link.message_event_id,
      direction: findCitedEvidence(tx, link).message.direction,
      quote: link.quote,
      extractedValue: link.extracted_value,
      normalizedValue: link.normalized_value,
      concern: link.concern as Concern | null,
      changedFrom: link.changed_from,
    }));
}

/**
 * Suspected fraud for each payment link the code-side check finds in the stored text of an incoming message event, once
 * per event and conflicting host. The link is recorded as a detail the chat has surfaced, as review publishing records a
 * conflicting link it finds in code, so a later repeat of it is suppressed whatever the model reported.
 */
function flagLinksInStoredText(tx: Tx, check: FraudCheck): FindingRow[] {
  return listIncomingTextEvents(tx, check.chat.id).flatMap((event) =>
    findPaymentLinks(event.text).flatMap((link) => {
      const host = hostOfNormalizedLink(link.normalizedValue);
      if (check.confirmedHosts.has(host) || check.flaggedHosts.get(event.id)?.has(host)) return [];
      recordCaseDetail(tx, {
        chatId: check.chat.id,
        category: 'payment_link',
        normalizedValue: link.normalizedValue,
        displayValue: link.url,
        messageId: event.message_id,
        position: event.position,
      });
      return flag(tx, check, {
        messageId: event.message_id,
        messageEventId: event.id,
        direction: 'incoming',
        quote: link.quote,
        extractedValue: link.url,
        normalizedValue: link.normalizedValue,
        concern: null,
        changedFrom: null,
      });
    }),
  );
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
  const check = startCheck(tx, chat, reference.id);
  // Stored findings first, so the text check skips an event whose host they have just flagged.
  const flagged = [...flagStoredLinkFindings(tx, check), ...flagLinksInStoredText(tx, check)];
  notifyWatchlist(tx, chat, flagged);
  return { caseReference: toCaseReference(reference, principalLookup(tx)), findingsCreated: flagged.length };
}
