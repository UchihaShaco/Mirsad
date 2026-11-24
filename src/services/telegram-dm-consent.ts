import type { Tx } from '../storage/db.ts';
import { isTelegramContactOptOut } from './telegram-reply-holds.ts';

/** This first reply is sent locally. The AI provider receives only messages after acceptance. */
export const DM_CONSENT_NOTICE = [
  'Ali is an AI assistant. If you agree, new messages in this chat can go to our AI provider (through OpenRouter when enabled) for replies and fraud screening. Officers can review the chat. Reply I AGREE, then send your message. Send STOP at any time to end AI replies.',
  'علي مساعد بالذكاء الاصطناعي. إذا وافقت، ممكن نرسل رسايلك الياية في هالمحادثة لمزوّد الذكاء الاصطناعي (عبر OpenRouter إذا كان مفعّل) عشان نرد ونتحقق من مؤشرات الاحتيال. الضباط يقدرون يراجعون المحادثة. اكتب «أوافق» وبعدين أرسل رسالتك. تقدر تكتب «توقف» في أي وقت عشان توقف الردود الآلية.',
].join('\n\n');

type ConsentState = {
  status: 'invited' | 'accepted' | 'withdrawn';
  position: number;
  second: number;
  noticeSeen: boolean;
  /** Telegram message IDs are ordered inside one private chat, even within a single second. */
  noticeTelegramId: number | null;
  /** Which live connection delivered the invitation, and whether an officer selected this chat. */
  noticePolicyKey?: string;
  officerInvited?: true;
  acceptanceTelegramId?: number;
  withdrawalTelegramId?: number;
};

type ConsentTurn = { action: 'notice' | 'reply' | 'wait'; enrolledAfter: number; enrolledSecond: number; afterTelegramId?: number };

export const officerDispatchScopeSql = `a.type='telegram_dispatch_approved'
  AND json_extract(a.detail,'$.connectorId')=:connector AND json_extract(a.detail,'$.policyKey')=:policyKey`;

export function hasOfficerDispatchApproval(tx: Tx, chatId: string, connector: string, policyKey: string): boolean {
  return !!tx.get(`SELECT 1 FROM case_actions a WHERE a.chat_id=:chatId AND ${officerDispatchScopeSql} LIMIT 1`,
    { chatId, connector, policyKey });
}

/** Dispatch can confirm a participant who originally accepted an automatic invitation on this connection. */
export function isOfficerEnrolledConsent(tx: Tx, consent: ConsentState | undefined, chatId: string,
  connector: string, policyKey?: string): boolean {
  return consent?.officerInvited === true ||
    (consent?.status === 'accepted' && !!policyKey && hasOfficerDispatchApproval(tx, chatId, connector, policyKey));
}

export function recordedDmConsent(tx: Tx, connector: string, chat: string, policyKey?: string): ConsentState | undefined {
  const row = tx.get<{ value: string }>('SELECT value FROM connector_state WHERE connector_id=? AND key=?',
    [connector, 'dm_ai_consent_v1:' + chat]);
  const state = row && JSON.parse(row.value) as ConsentState;
  if (!policyKey || !state) return state;
  const sameNotice = state.noticePolicyKey ? state.noticePolicyKey === policyKey
    : provenConsentMessage(tx, connector, chat, policyKey, state.noticeTelegramId, true);
  // A changed connection never inherits acceptance or a delivered invitation. Keep an existing opt-out.
  if (!sameNotice) return state.status === 'withdrawn' ? { ...state, noticeSeen: false, officerInvited: undefined } : undefined;
  if (state.noticePolicyKey) return state;
  if (state.status === 'accepted' && !provenConsentMessage(tx, connector, chat, policyKey, state.acceptanceTelegramId, false)) return undefined;
  return { ...state, noticePolicyKey: policyKey };
}

function write(tx: Tx, connector: string, chat: string, state: ConsentState): void {
  tx.run(`INSERT INTO connector_state(connector_id,key,value,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(connector_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [connector, 'dm_ai_consent_v1:' + chat, JSON.stringify(state), tx.now()]);
}

/** Legacy invitations stored the Telegram message id before they also stored the connection identity. */
function provenConsentMessage(tx: Tx, connector: string, chat: string, policyKey: string, telegramId: number | null | undefined, ownSend: boolean): boolean {
  return !!telegramId && !!tx.get(
    `SELECT 1 FROM messages m JOIN telegram_message_proofs p ON p.message_id=m.id
     WHERE m.chat_id=? AND p.message_number=? AND p.connector_id=? AND p.connection_hash=substr(?,-64)
       AND p.content_kind='normal' AND p.own_send=? AND m.direction=?`,
    [chat, telegramId, connector, policyKey, Number(ownSend), ownSend ? 'outgoing' : 'incoming']);
}

function accepts(text: string): boolean {
  const words = text.trim().toLowerCase().normalize('NFKC').replace(/[\u064B-\u065F\u0670]/gu, '')
    .replace(/[أإآ]/gu, 'ا').replace(/\s+/gu, ' ').replace(/[.!۔。]+$/u, '').trimEnd();
  return ['i agree', 'اوافق', 'i agree to receive automated replies from mirsad', 'اوافق على تلقي ردود الية من مرصاد'].includes(words);
}

function source(tx: Tx, chatId: string, messageId: string) {
  return tx.get<{ position: number; second: number; telegram: number | null }>(
    `SELECT position, unixepoch(COALESCE(sent_at,received_at)) AS second,
       CASE WHEN source_message_id GLOB 'tg:[0-9]*' THEN CAST(substr(source_message_id,4) AS INTEGER) END AS telegram
     FROM messages WHERE chat_id=? AND id=?`, [chatId, messageId]);
}

/** Only after Telegram accepts our invitation can an incoming message grant permission. */
export function markDmConsentNotice(tx: Tx, connectorId: string, chatId: string, messageId: string, outgoingId?: string,
  policyKey?: string, officerInvited = false): void {
  const trigger = source(tx, chatId, messageId);
  if (!trigger) return;
  const previous = recordedDmConsent(tx, connectorId, chatId, policyKey);
  if (previous && (previous.noticeSeen || previous.position >= trigger.position)) return;
  const notice = outgoingId ? source(tx, chatId, outgoingId) : undefined;
  write(tx, connectorId, chatId, {
    status: 'invited', position: trigger.position,
    second: notice?.second ?? Math.floor(Date.parse(tx.now()) / 1000),
    noticeSeen: true, noticeTelegramId: notice?.telegram ?? null,
    ...(policyKey && { noticePolicyKey: policyKey }), ...(officerInvited && { officerInvited: true }),
  });
}

/** Called at intake for an original message authored by the contact. An edit, quote or forward cannot grant consent. */
export function observeDmConsent(tx: Tx, connectorId: string, chatId: string, messageId: string, position: number,
  text: string, allowAcceptance = true, policyKey?: string): boolean {
  const withdraws = isTelegramContactOptOut(text);
  if (!withdraws && (!allowAcceptance || !accepts(text))) return false;
  const previous = recordedDmConsent(tx, connectorId, chatId, policyKey);
  if (previous && position <= previous.position) return false;
  if (!withdraws && (!previous?.noticeSeen || previous.status === 'accepted')) return false;
  const turn = source(tx, chatId, messageId);
  if (!turn || turn.position !== position || (!withdraws && turn.telegram === null)) return false;
  if (!withdraws && previous && (turn.second < previous.second ||
    (turn.telegram ?? 0) <= Math.max(previous.noticeTelegramId ?? 0, previous.withdrawalTelegramId ?? 0))) return false;
  write(tx, connectorId, chatId, {
    status: withdraws ? 'withdrawn' : 'accepted', position, second: Math.max(turn.second, previous?.second ?? 0),
    noticeSeen: previous?.noticeSeen ?? false, noticeTelegramId: previous?.noticeTelegramId ?? null,
    ...(previous?.noticePolicyKey && { noticePolicyKey: previous.noticePolicyKey }),
    ...(previous?.officerInvited && { officerInvited: true }),
    ...(!withdraws && turn.telegram !== null ? { acceptanceTelegramId: turn.telegram } : {}),
    ...(withdraws && { withdrawalTelegramId: Math.max(turn.telegram ?? 0, previous?.withdrawalTelegramId ?? 0) }),
  });
  return !withdraws;
}

/** Both recent history and longer-term offer memory must start strictly after the acceptance message. */
export function dmConsentForTurn(tx: Tx, connectorId: string, chatId: string, messageId: string, position: number,
  text: string, policyKey?: string, nativeIncoming = false): ConsentTurn {
  const consent = recordedDmConsent(tx, connectorId, chatId, policyKey);
  const result = { enrolledAfter: consent?.position ?? 0, enrolledSecond: consent?.second ?? 0 };
  if (consent?.status === 'accepted') {
    const telegram = source(tx, chatId, messageId)?.telegram;
    const afterTelegramId = consent.acceptanceTelegramId;
    const sameConnection = !isOfficerEnrolledConsent(tx, consent, chatId, connectorId, policyKey) || nativeIncoming || (!!policyKey &&
      provenConsentMessage(tx, connectorId, chatId, policyKey, telegram, false));
    const newer = sameConnection && position > consent.position && telegram != null && afterTelegramId !== undefined && telegram > afterTelegramId;
    return { ...result, ...(afterTelegramId === undefined ? {} : { afterTelegramId }), action: newer && !accepts(text) ? 'reply' : 'wait' };
  }
  if (!consent || (!consent.noticeSeen && position > consent.position && accepts(text))) return { ...result, action: 'notice' };
  return { ...result, action: 'wait' };
}
