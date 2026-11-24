/**
 * Citizen reports: scam reports a citizen shared from Mirsad Android (report v1, mirsad-android/docs/EVIDENCE_SCHEMA.md),
 * imported by an officer. Each report becomes one incoming message in a Citizen report chat, one chat per reported
 * sender, recorded through the normal intake path so captures, the stream and sender matching work as for any message.
 * The numbers it names go to the phone watchlist for review. A citizen report has no conversation behind it, so it can
 * never be dispatched, taken over or answered, and nothing in it is sent to a model.
 */
import { ZodError } from 'zod';
import { AppError } from '../contract/errors.ts';
import { CitizenReport, type CitizenReportImportRequest, type ChatSummary, type Timeline } from '../contract/schemas.ts';
import { normalizePhone } from '../domain/phone.ts';
import { provisionPrincipal } from '../identity/provision.ts';
import type { Principal } from '../ports/identity.ts';
import type { Tx } from '../storage/db.ts';
import * as caseActions from '../storage/repos/case-actions.ts';
import { findChannelAccount, grantAccount, insertChannelAccount, toPrincipal } from '../storage/repos/principals.ts';
import type { ChannelAccountRow, ChatRow, MessageEventRow, MessageRow, PrincipalRow } from '../storage/rows.ts';
import { ingest, type IntakeConfig } from './intake.ts';
import * as watchlist from './watchlist.ts';

/** The one channel account per workspace that holds citizen reports. */
export const CITIZEN_REPORT_ACCOUNT = 'mirsad-android';
const CONNECTOR_NAME = 'Mirsad Android report import';
const LEVEL_WORDS = { HOLD: 'held', WARN: 'flagged', ALLOW: 'allowed' } as const;
const CHANNEL_WORDS = { SMS: 'SMS', CALL: 'call', CHAT: 'chat message' } as const;

export interface CitizenReportImportResult {
  chatId: string;
  messageId: string;
  created: boolean;
  demo: boolean;
  watchlistNumbers: number;
}

export function isCitizenReportChat(tx: Tx, chat: Pick<ChatRow, 'channel_account_id'>): boolean {
  return tx.get('SELECT 1 FROM channel_accounts WHERE id=? AND source=?', [chat.channel_account_id, 'citizen_report']) !== undefined;
}

/** 409 for anything that would answer, dispatch or take over a citizen report. */
export function refuseCitizenReport(tx: Tx, chat: Pick<ChatRow, 'channel_account_id'>): void {
  if (isCitizenReportChat(tx, chat)) {
    throw AppError.of('citizen_report_only', 'A citizen report has no conversation to dispatch, take over or answer.');
  }
}

/**
 * The workspace's Citizen report account and its import connector, created on first use. Every officer of the workspace
 * may read citizen reports, so each import also grants the account to officers added since. The connector's token is
 * never kept: nothing outside this service can submit as it.
 */
function citizenReportIntake(tx: Tx, workspaceId: string): { account: ChannelAccountRow; connector: Principal } {
  const account = findChannelAccount(tx, workspaceId, 'citizen_report', CITIZEN_REPORT_ACCOUNT)
    ?? insertChannelAccount(tx, { workspaceId, source: 'citizen_report', externalAccountId: CITIZEN_REPORT_ACCOUNT, label: 'Citizen reports', isIntake: false });
  const existing = tx.get<PrincipalRow>(`SELECT p.* FROM principals p JOIN account_grants g ON g.principal_id=p.id
    WHERE g.channel_account_id=? AND p.kind='connector' ORDER BY p.created_at LIMIT 1`, [account.id]);
  const connector = existing ? toPrincipal(existing)
    : provisionPrincipal(tx, { workspaceId, kind: 'connector', displayName: CONNECTOR_NAME, captureMethod: 'approved_import' }).principal;
  grantAccount(tx, connector.id, account.id);
  for (const { id } of tx.all<{ id: string }>("SELECT id FROM principals WHERE workspace_id=? AND kind='officer'", [workspaceId])) {
    grantAccount(tx, id, account.id);
  }
  return { account, connector };
}

/** Grants a new officer the workspace's Citizen report account, when it exists. */
export function grantCitizenReports(tx: Tx, officerId: string, workspaceId: string): void {
  const account = findChannelAccount(tx, workspaceId, 'citizen_report', CITIZEN_REPORT_ACCOUNT);
  if (account) grantAccount(tx, officerId, account.id);
}

function parseReport(raw: unknown, allowDemo: boolean): CitizenReport {
  if (raw !== null && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    if ('userVerdict' in candidate) {
      throw AppError.of('report_not_accepted', 'This is a false-positive report meant for the app’s developers, not a scam report.');
    }
    if ('version' in candidate && candidate.version !== 1) {
      throw AppError.of('report_not_accepted', `Report version ${String(candidate.version)} is not supported. This portal reads version 1.`);
    }
  }
  let report: CitizenReport;
  try {
    report = CitizenReport.parse(raw);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw AppError.of('validation_failed', 'This file is not a Mirsad Android scam report.', {
      issues: error.issues.slice(0, 5).map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  if (report.synthetic && !allowDemo) {
    throw AppError.of('report_not_accepted', 'This is a Demo or test report from the app. Import it as a demo to use it for testing.');
  }
  return report;
}

function summaryText(report: CitizenReport): string {
  const what = `Scam ${CHANNEL_WORDS[report.channel]} ${LEVEL_WORDS[report.level]} on a citizen’s phone (risk ${Math.round(report.score * 100)}%).`;
  return `${what} The citizen did not share the message text.`;
}

/** One chat per reported sender; without a shareable sender, one per message family (fingerprint). */
function chatKey(report: CitizenReport): { externalChatId: string; label: string } {
  const sender = report.artifacts.sender;
  if (sender && (report.artifacts.senderType === 'NUMBER' || report.artifacts.senderType === 'ALPHANUMERIC')) {
    return { externalChatId: sender, label: sender };
  }
  return { externalChatId: `fingerprint:${report.fingerprint}`, label: `Unknown sender · ${report.fingerprint.slice(0, 6)}` };
}

function e164Of(raw: string): string | null {
  return normalizePhone(raw, raw.startsWith('+') || raw.startsWith('00') ? { internationalFormat: true } : { country: 'AE' }).e164;
}

/** Imports one report. Re-importing the same report changes nothing and returns the chat it is in. */
export function importCitizenReport(tx: Tx, officer: Principal, request: CitizenReportImportRequest, config: IntakeConfig): CitizenReportImportResult {
  const report = parseReport(request.report, request.demo === true);
  const prior = tx.get<{ chat_id: string; message_id: string; demo: number }>(
    'SELECT chat_id, message_id, demo FROM citizen_reports WHERE workspace_id=? AND report_id=?', [officer.workspaceId, report.reportId]);
  if (prior) return { chatId: prior.chat_id, messageId: prior.message_id, created: false, demo: prior.demo === 1, watchlistNumbers: 0 };

  const { connector } = citizenReportIntake(tx, officer.workspaceId);
  const { externalChatId, label } = chatKey(report);
  const senderNumber = report.artifacts.senderType === 'NUMBER' && report.artifacts.sender ? report.artifacts.sender : null;
  const result = ingest(tx, connector, { source: 'citizen_report', externalAccountId: CITIZEN_REPORT_ACCOUNT, externalChatId, chat: { displayLabel: label } }, {
    type: 'message.recorded',
    sourceEventId: report.reportId,
    sourceMessageId: report.reportId,
    direction: 'incoming',
    text: report.text ?? summaryText(report),
    sentAt: report.createdAt,
    sender: {
      externalId: externalChatId,
      ...(report.artifacts.senderType === 'ALPHANUMERIC' && report.artifacts.sender && { displayName: report.artifacts.sender }),
      // A demo report never tells the watchlist about its sender, even as a sighting.
      ...(senderNumber && !report.synthetic && { phone: { raw: senderNumber, internationalFormat: senderNumber.startsWith('+') } }),
    },
  }, config);

  const chat = tx.get<ChatRow>('SELECT * FROM chats WHERE id=?', [result.chatId])!;
  const message = tx.get<MessageRow>('SELECT * FROM messages WHERE id=?', [result.messageId])!;
  const messageEvent = tx.get<MessageEventRow>('SELECT * FROM message_events WHERE id=?', [result.messageEventId])!;
  tx.run(`INSERT INTO citizen_reports (message_id, chat_id, workspace_id, report_id, report, demo, imported_by, imported_at)
    VALUES (?,?,?,?,?,?,?,?)`, [message.id, chat.id, chat.workspace_id, report.reportId, JSON.stringify(report), report.synthetic ? 1 : 0, officer.id, tx.now()]);
  caseActions.record(tx, { chatId: chat.id, workspaceId: chat.workspace_id, type: 'citizen_report_imported', actorId: officer.id,
    messageId: message.id, detail: { reportId: report.reportId, demo: report.synthetic } });

  let watchlistNumbers = 0;
  if (!report.synthetic) {
    const numbers: watchlist.ReportedNumber[] = [];
    const level = LEVEL_WORDS[report.level];
    if (senderNumber) {
      const e164 = e164Of(senderNumber);
      if (e164) numbers.push({ raw: senderNumber, e164, reason: `Sender of a scam ${CHANNEL_WORDS[report.channel]} a citizen’s phone ${level}` });
    }
    for (const raw of report.artifacts.phones) {
      const e164 = e164Of(raw);
      if (e164 && !numbers.some(n => n.e164 === e164)) numbers.push({ raw, e164, reason: 'Named in a scam message a citizen reported' });
    }
    watchlistNumbers = watchlist.onCitizenReport(tx, { chat, message, messageEvent }, numbers);
  }
  return { chatId: chat.id, messageId: message.id, created: true, demo: report.synthetic, watchlistNumbers };
}

/** The summary line for a Citizen report chat: how many reports and the newest verdict. */
export function readCitizenReportSummary(tx: Tx, chatId: string): ChatSummary['citizenReport'] {
  const rows = tx.all<{ report: string; demo: number }>(
    'SELECT r.report, r.demo FROM citizen_reports r JOIN messages m ON m.id=r.message_id WHERE r.chat_id=? ORDER BY m.position', [chatId]);
  const latest = rows.at(-1);
  if (!latest) return null;
  const report = JSON.parse(latest.report) as CitizenReport;
  return { count: rows.length, latestLevel: report.level, latestChannel: report.channel, demo: rows.every(row => row.demo === 1) };
}

/** Every report in the chat, oldest first, for the timeline. */
export function readCitizenReports(tx: Tx, chatId: string): Timeline['citizenReports'] {
  return tx.all<{ message_id: string; report: string; demo: number; imported_at: string; imported_by: string; officer: string | null }>(
    `SELECT r.message_id, r.report, r.demo, r.imported_at, r.imported_by, p.display_name AS officer
     FROM citizen_reports r JOIN messages m ON m.id=r.message_id LEFT JOIN principals p ON p.id=r.imported_by
     WHERE r.chat_id=? ORDER BY m.position`, [chatId],
  ).map((row) => {
    const report = JSON.parse(row.report) as CitizenReport;
    return {
      messageId: row.message_id, reportId: report.reportId, createdAt: new Date(report.createdAt).toISOString(), importedAt: row.imported_at,
      importedBy: row.officer ? { id: row.imported_by, displayName: row.officer } : null, demo: row.demo === 1,
      channel: report.channel, level: report.level, score: report.score, reasonCodes: report.reasonCodes, fingerprint: report.fingerprint,
      textShared: report.text !== null, artifacts: report.artifacts,
    };
  });
}
