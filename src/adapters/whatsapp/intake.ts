import { randomUUID } from 'node:crypto';
import type { Direction } from '../../contract/enums.ts';
import { AppError } from '../../contract/errors.ts';
import type { IngestResult } from '../../contract/schemas.ts';
import { ingest, type IntakeConfig } from '../../services/intake.ts';
import type { Db, Tx } from '../../storage/db.ts';
import {
  findChannelAccount, findPrincipalById, grantAccount, insertChannelAccount, insertPrincipal, toPrincipal,
} from '../../storage/repos/principals.ts';

export interface WhatsAppDemoBinding {
  accountId: string;
  connectorId: string;
  workspaceId: string;
  officerId: string;
  phoneNumberId: string;
}

export class WhatsAppTesterOptedOutError extends Error {
  constructor() {
    super('whatsapp_tester_opted_out');
    this.name = 'WhatsAppTesterOptedOutError';
  }
}

export function isWhatsAppTesterOptedOut(tx: Tx, binding: WhatsAppDemoBinding, peer: string): boolean {
  return !!tx.get(`SELECT 1 FROM chats c JOIN whatsapp_demo_opt_outs o ON o.chat_id=c.id
    WHERE c.workspace_id=? AND c.channel_account_id=? AND c.external_chat_id=?`, [binding.workspaceId, binding.accountId, peer]);
}

/** Check current grants as well as the configured pairing. Revoking either grant takes effect on the next operation. */
export function isWhatsAppBindingActive(tx: Tx, binding: WhatsAppDemoBinding): boolean {
  return !!tx.get(`SELECT 1 FROM whatsapp_demo_bindings b
    JOIN channel_accounts a ON a.id=b.account_id
    JOIN principals c ON c.id=b.connector_id AND c.workspace_id=a.workspace_id
    JOIN principals o ON o.id=b.officer_id AND o.workspace_id=a.workspace_id
    JOIN account_grants cg ON cg.principal_id=c.id AND cg.channel_account_id=a.id
    JOIN account_grants og ON og.principal_id=o.id AND og.channel_account_id=a.id
    WHERE b.phone_number_id=:phoneNumberId AND b.account_id=:accountId AND b.connector_id=:connectorId AND b.officer_id=:officerId
      AND a.workspace_id=:workspaceId AND a.external_account_id=b.phone_number_id AND a.source='whatsapp'
      AND c.kind='connector' AND c.disabled=0 AND c.capture_method='whatsapp_business_live' AND o.kind='officer' AND o.disabled=0`,
  { ...binding });
}

export function bindWhatsAppDemo(db: Db, officerId: string, phoneNumberId: string): WhatsAppDemoBinding {
  // Graph provides a numeric sender ID. YCloud authenticates the WABA and E.164 sender together.
  if (!/^(?:[0-9]+|ycloud:[1-9]\d{0,19}:[1-9]\d{6,14})$/.test(phoneNumberId)) throw new Error('whatsapp_account_invalid');
  return db.transaction(tx => {
    const officer = findPrincipalById(tx, officerId);
    if (!officer || officer.kind !== 'officer' || officer.disabled) throw new Error('whatsapp_officer_unavailable');
    const workspaceId = officer.workspace_id;
    const previous = tx.get<{accountId: string; connectorId: string}>(
      'SELECT account_id AS accountId, connector_id AS connectorId FROM whatsapp_demo_bindings WHERE phone_number_id=?', [phoneNumberId]);
    if (previous) {
      const binding = { ...previous, phoneNumberId, workspaceId, officerId };
      if (!isWhatsAppBindingActive(tx, binding)) throw new Error('whatsapp_binding_unavailable');
      return binding;
    }
    if (findChannelAccount(tx, workspaceId, 'whatsapp', phoneNumberId)) throw new Error('whatsapp_account_already_owned');
    const { id: accountId } = insertChannelAccount(tx, { workspaceId, source: 'whatsapp', externalAccountId: phoneNumberId,
      label: 'WhatsApp Business demo', isIntake: true });
    // Bearer auth searches only SHA-256 hex digests. This internal connector has no bearer credential.
    const { id: connectorId } = insertPrincipal(tx, { workspaceId, kind: 'connector', displayName: 'WhatsApp Business demo',
      tokenSha256: 'internal:' + randomUUID(), captureMethod: 'whatsapp_business_live' });
    grantAccount(tx, connectorId, accountId);
    grantAccount(tx, officerId, accountId);
    tx.run('INSERT INTO whatsapp_demo_bindings (phone_number_id, account_id, connector_id, officer_id) VALUES (?,?,?,?)',
      [phoneNumberId, accountId, connectorId, officerId]);
    return { accountId, connectorId, workspaceId, officerId, phoneNumberId };
  });
}

interface WhatsAppText {
  id: string;
  peer: string;
  text: string;
  direction: Direction;
  sentAt: string;
}

function isWithdrawal(input: WhatsAppText): boolean {
  return input.direction === 'incoming' && /^(?:stop|توقف|توقّف)$/iu.test(input.text.trim());
}

/** The caller has authenticated the webhook or received the native ID of a successful send. */
export function ingestWhatsAppText(tx: Tx, binding: WhatsAppDemoBinding, config: IntakeConfig,
  testerIds: readonly string[], input: WhatsAppText, deliveredFor?: string): IngestResult {
  if (!isWhatsAppBindingActive(tx, binding) || !testerIds.includes(input.peer)) {
    throw AppError.of('account_not_authorized', 'This participant is outside the WhatsApp demo.');
  }
  if (isWhatsAppTesterOptedOut(tx, binding, input.peer)) {
    // Preserve the receipt for a reply already sent when STOP arrived. Later mobile echoes are ignored.
    const inFlightReceipt = input.direction === 'outgoing' && deliveredFor && tx.get(`SELECT 1 FROM whatsapp_reply_attempts a
      JOIN messages m ON m.id=a.message_id JOIN chats c ON c.id=m.chat_id
      WHERE a.message_id=? AND a.state='sent' AND c.channel_account_id=? AND c.external_chat_id=?`,
    [deliveredFor, binding.accountId, input.peer]);
    if (!inFlightReceipt) throw new WhatsAppTesterOptedOutError();
  }
  const connector = toPrincipal(findPrincipalById(tx, binding.connectorId)!);
  const result = ingest(tx, connector, { source: 'whatsapp', externalAccountId: binding.phoneNumberId, externalChatId: input.peer }, {
    type: 'message.recorded', sourceEventId: input.id, sourceMessageId: input.id, text: input.text,
    sentAt: input.sentAt, direction: input.direction,
    sender: { externalId: input.direction === 'incoming' ? input.peer : binding.phoneNumberId },
  }, { ...config, authorizeWhatsAppDemo(account, peer) {
    if (account.id !== binding.accountId || peer !== input.peer) {
      throw AppError.of('account_not_authorized', 'This conversation is outside the WhatsApp demo.');
    }
  } });
  if (isWithdrawal(input)) {
    tx.run('INSERT OR IGNORE INTO whatsapp_demo_opt_outs(chat_id,opted_out_at) VALUES (?,?)', [result.chatId, tx.now()]);
  }
  return result;
}

/** Webhook retries can bring back erased events. Honor a late STOP without restoring any of that evidence. */
export function ingestWhatsAppWebhookText(tx: Tx, binding: WhatsAppDemoBinding, config: IntakeConfig,
  testerIds: readonly string[], input: WhatsAppText): IngestResult | null {
  try {
    return ingestWhatsAppText(tx, binding, config, testerIds, input);
  } catch (error) {
    if (error instanceof WhatsAppTesterOptedOutError) return null;
    if (!(error instanceof AppError) || error.code !== 'history_erased') throw error;
    if (isWithdrawal(input)) {
      tx.run(`INSERT OR IGNORE INTO whatsapp_demo_opt_outs(chat_id,opted_out_at)
        SELECT id,? FROM chats WHERE workspace_id=? AND channel_account_id=? AND external_chat_id=?`,
      [tx.now(), binding.workspaceId, binding.accountId, input.peer]);
    }
    return null;
  }
}
