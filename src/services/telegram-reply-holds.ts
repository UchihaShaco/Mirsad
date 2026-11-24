/** Contact consent and officer review are independent, durable decisions. All writes share the intake transaction. */
import { createHash } from 'node:crypto';
import { extractUrlTokens, maskUrls, normalizeTelegramLink } from '../domain/links.ts';
import type { AliDecision, ModelPaymentLinkReview } from '../replies/ali-decision.ts';
import { paymentLinkKey, type PaymentLinkSource } from '../replies/payment-link-candidates.ts';
import { REPLY_FRESHNESS_MS, REPLY_QUIET_MS } from '../replies/reply-timing.ts';
import type { Tx } from '../storage/db.ts';
import { readChatTestBoundary } from './chat-test-session.ts';
import { record } from '../storage/repos/case-actions.ts';

type MaterialReason = 'document' | 'location' | 'link' | 'payment_link' | 'bank_details';
type ReviewReason = MaterialReason | 'conversation_review' | 'model_payment_link';
type ConsentDecision = 'telegram_contact_opted_out' | 'telegram_contact_opted_in';
type ReviewItem = { actionId: string; messageId: string; reason: ReviewReason };
type EvidenceItem = ReviewItem & { messageEventId: string | null };
export interface TelegramReplyHold {
  contactOptedOut: boolean;
  officerReview: ReviewItem | null;
  evidenceItems: EvidenceItem[];
}

export function isTelegramLinkWarning(reason: string): boolean {
  return reason === 'link' || reason === 'payment_link' || reason === 'model_payment_link';
}

// Earlier versions stored the indicator set in model order. Keep equivalent decisions comparable after restart.
function indicatorSetSql(alias: string): string {
  const value = `json_extract(${alias}.detail,'$.indicators')`;
  return `(SELECT group_concat(indicator.value,',' ORDER BY indicator.value)
    FROM json_each('['||replace(json_quote(${value}),',','","')||']') indicator)`;
}

/** The reason governs both old and new items. Only verified bank details require an officer before replying. */
export function blockingReviewRequestSql(alias: string): string {
  return `(${alias}.type='telegram_officer_review_requested' AND json_extract(${alias}.detail,'$.reason')='bank_details')`;
}

export function blockingReviewResolutionSql(alias: string): string {
  return `(${alias}.type='telegram_officer_review_resolved' AND EXISTS (
    SELECT 1 FROM case_actions flag WHERE flag.id=json_extract(${alias}.detail,'$.reviewActionId')
      AND flag.chat_id=${alias}.chat_id AND ${blockingReviewRequestSql('flag')}))`;
}

export function reviewedModelPaymentLinkKeys(tx: Tx, chatId: string, afterPosition = readChatTestBoundary(tx, chatId)): string[] {
  return tx.all<{ itemKey: string }>(
    `SELECT json_extract(detail,'$.itemKey') AS itemKey FROM case_actions
     WHERE chat_id=:chatId AND position>:afterPosition AND type='telegram_officer_review_requested' AND json_extract(detail,'$.reason')='model_payment_link'
     UNION SELECT s.item_key FROM telegram_evidence_sources s JOIN case_actions f ON f.id=s.action_id
       WHERE s.chat_id=:chatId AND s.reason IN ('link','payment_link','reviewed_link') AND f.position>:afterPosition AND EXISTS (
         SELECT 1 FROM case_actions done WHERE done.chat_id=s.chat_id AND done.type='telegram_officer_review_resolved'
           AND json_extract(done.detail,'$.reviewActionId')=f.id)`,
    { chatId, afterPosition },
  ).map(({ itemKey }) => itemKey);
}

/** Earlier clients could review the source message before it had a dedicated link warning.
 * Only an unambiguous URL in that exact, officer-reviewed source event inherits the acknowledgment.
 */
export function rememberReviewedTelegramLink(tx: Tx, chatId: string, actionId: string): void {
  const source = tx.get<{ messageId: string; reason: string; text: string }>(
    `SELECT m.id AS messageId,json_extract(f.detail,'$.reason') AS reason,e.text
     FROM case_actions f JOIN chats c ON c.id=f.chat_id JOIN messages m ON m.id=f.message_id AND m.chat_id=c.id
     JOIN message_events e ON e.id=json_extract(f.detail,'$.messageEventId') AND e.message_id=m.id AND e.chat_id=c.id
     WHERE f.id=:actionId AND f.chat_id=:chatId AND f.type='telegram_officer_review_requested'
       AND json_extract(f.detail,'$.reason') IN ('conversation_review','location')
       AND EXISTS (SELECT 1 FROM case_actions done JOIN principals p ON p.id=done.actor_id AND p.kind='officer'
         WHERE done.chat_id=c.id AND done.type='telegram_officer_review_resolved' AND json_extract(done.detail,'$.reviewActionId')=f.id)
       AND m.direction='incoming' AND m.origin='source' AND m.sender_external_id=c.external_chat_id
       AND m.original_captured=1 AND m.deleted_at_source=0 AND m.capture_method='telegram_business_live'
       AND e.type IN ('recorded','edited') AND e.text IS NOT NULL AND e.capture_method='telegram_business_live'
       AND NOT EXISTS (SELECT 1 FROM json_each(m.unsupported_content) WHERE value IN ('forwarded','blockquote'))
       AND NOT EXISTS (SELECT 1 FROM message_events conflict WHERE conflict.message_id=m.id AND conflict.type='conflicting_copy')`,
    { chatId, actionId });
  if (!source) return;
  const links = new Set(extractUrlTokens(source.text, normalizeTelegramLink).map(normalizeTelegramLink).filter((url): url is string => url !== null));
  const [link] = links;
  if (links.size !== 1 || !link || (source.reason === 'location' && !isMapPin(link))) return;
  tx.run(`INSERT OR IGNORE INTO telegram_evidence_sources(chat_id,message_id,reason,item_key,action_id)
    VALUES (?,?,'reviewed_link',?,?)`, [chatId, source.messageId, paymentLinkKey(chatId, link), actionId]);
}

interface ReviewTrigger { chatId: string; workspaceId: string; messageId: string; requestId?: string }

/** Stores a model assessment linked to an exact visible source. The link itself stays in the incoming message. */
export function recordModelPaymentLinkReview(tx: Tx, trigger: ReviewTrigger,
  candidate: PaymentLinkSource, reason: ModelPaymentLinkReview['reason'], model: string): void {
  const { chatId, workspaceId } = trigger;
  const { messageId, messageEventId, itemKey } = candidate;
  const source = tx.get<{ text: string }>(
    `SELECT e.text FROM message_events e JOIN messages m ON m.id=e.message_id JOIN chats c ON c.id=m.chat_id
     WHERE e.id=:messageEventId AND e.chat_id=:chatId AND e.capture_method='telegram_business_live'
       AND m.id=:messageId AND m.chat_id=:chatId AND m.workspace_id=:workspaceId
       AND m.direction='incoming' AND m.origin='source' AND m.original_captured=1 AND m.deleted_at_source=0
       AND m.sender_external_id=c.external_chat_id AND m.capture_method='telegram_business_live'
       AND NOT EXISTS (SELECT 1 FROM json_each(m.unsupported_content) part WHERE part.value IN ('forwarded','blockquote'))
       AND e.id=(SELECT latest.id FROM message_events latest WHERE latest.message_id=m.id AND latest.text IS NOT NULL
         AND latest.type IN ('edited','recorded') ORDER BY (latest.type='edited') DESC, latest.position DESC LIMIT 1)`,
    { chatId, workspaceId, messageId, messageEventId },
  );
  const matches = source && extractUrlTokens(source.text, normalizeTelegramLink).some(url => {
    const normalized = normalizeTelegramLink(url);
    return normalized !== null && paymentLinkKey(chatId, normalized) === itemKey;
  });
  if (!matches || reviewedModelPaymentLinkKeys(tx, chatId).includes(itemKey)) return;
  record(tx, {
    chatId, workspaceId, messageId, actorId: null, type: 'telegram_officer_review_requested',
    detail: { reason: 'model_payment_link', indicators: reason, model, itemKey, messageEventId,
      triggerMessageId: trigger.messageId, holdsReplies: false, ...(trigger.requestId && { requestId: trigger.requestId }) },
  });
}

/** A conversation assessment can recur on successive messages. Keep its first source in the current test episode. */
export function recordConversationReview(
  tx: Tx, source: ReviewTrigger,
  decision: Extract<AliDecision, { kind: 'review' }>, model: string,
): void {
  const { chatId, workspaceId, messageId } = source;
  const event = tx.get<{ id: string }>(`SELECT e.id FROM message_events e JOIN messages m ON m.id=e.message_id AND m.chat_id=e.chat_id
    WHERE e.chat_id=:chatId AND e.message_id=:messageId AND m.workspace_id=:workspaceId
      AND m.direction='incoming' AND m.origin='source' AND m.original_captured=1 AND m.deleted_at_source=0
      AND e.capture_method='telegram_business_live' AND e.type IN ('edited','recorded') AND e.text IS NOT NULL
    ORDER BY (e.type='edited') DESC,e.position DESC LIMIT 1`, { chatId, messageId, workspaceId });
  if (!event) throw new Error('conversation_review_source_missing');
  // Equivalent decisions compare as sorted sets; the stored list keeps the model's order, which the officer reads.
  const indicators = decision.reasons.join(',');
  const indicatorKey = [...decision.reasons].sort().join(',');
  const prior = tx.get(`SELECT 1 FROM case_actions flag WHERE flag.chat_id=:chatId AND flag.type='telegram_officer_review_requested'
    AND flag.position>:boundary AND json_extract(flag.detail,'$.reason')='conversation_review'
    AND json_extract(flag.detail,'$.reviewStatus')=:status AND ${indicatorSetSql('flag')}=:indicatorKey LIMIT 1`,
    { chatId, boundary: readChatTestBoundary(tx, chatId), status: decision.status, indicatorKey });
  if (prior) return;
  record(tx, {
    chatId, workspaceId, messageId, actorId: null, type: 'telegram_officer_review_requested',
    detail: { reason: 'conversation_review', reviewStatus: decision.status, indicators,
      model, messageEventId: event.id, holdsReplies: false, ...(source.requestId && { requestId: source.requestId }) },
  });
}

function lastConsent(tx: Tx, chatId: string): ConsentDecision | undefined {
  return tx.get<{ type: ConsentDecision }>(
    `SELECT type FROM case_actions WHERE chat_id = :chatId AND type IN ('telegram_contact_opted_out','telegram_contact_opted_in')
     ORDER BY position DESC LIMIT 1`, { chatId },
  )?.type;
}

export function getTelegramReplyHold(tx: Tx, chatId: string): TelegramReplyHold {
  // Collapse local and model warnings by normalized URL. A resolution wins over any legacy
  // duplicate, then the more specific model assessment wins over an open local warning.
  const open = tx.all<EvidenceItem & { blocking: number }>(
    `WITH flags AS (
       SELECT flag.id AS actionId, flag.message_id AS messageId, flag.position, flag.detail,
         json_extract(flag.detail,'$.messageEventId') AS messageEventId, json_extract(flag.detail,'$.reason') AS reason,
         ${blockingReviewRequestSql('flag')} AS blocking,
         EXISTS (SELECT 1 FROM case_actions done WHERE done.chat_id=flag.chat_id AND done.type='telegram_officer_review_resolved'
           AND json_extract(done.detail,'$.reviewActionId')=flag.id) AS resolved,
         coalesce((SELECT max(t.position) FROM case_actions t WHERE t.chat_id=flag.chat_id AND t.type='chat_test_started'
           AND t.position<flag.position),0) AS episode
       FROM case_actions flag WHERE flag.chat_id=:chatId AND flag.type='telegram_officer_review_requested'
     ), identities AS (
       SELECT f.actionId, s.item_key AS itemKey FROM flags f JOIN telegram_evidence_sources s ON s.action_id=f.actionId
         WHERE s.chat_id=:chatId AND s.reason IN ('link','payment_link','reviewed_link')
       UNION SELECT f.actionId,json_extract(f.detail,'$.itemKey') FROM flags f
         WHERE f.reason='model_payment_link' AND json_extract(f.detail,'$.itemKey') IS NOT NULL
       UNION SELECT f.actionId,json_array('conversation_review',json_extract(f.detail,'$.reviewStatus'),${indicatorSetSql('f')})
         FROM flags f WHERE f.reason='conversation_review' AND json_extract(f.detail,'$.reviewStatus') IS NOT NULL
     ), ranked AS (
       SELECT i.actionId, row_number() OVER (PARTITION BY f.episode,i.itemKey
         ORDER BY f.resolved DESC,(f.reason='model_payment_link') DESC,f.position) AS priority
       FROM identities i JOIN flags f ON f.actionId=i.actionId
     )
     SELECT f.actionId,f.messageId,f.messageEventId,f.reason,f.blocking FROM flags f WHERE f.resolved=0 AND (
       NOT EXISTS (SELECT 1 FROM ranked r WHERE r.actionId=f.actionId)
       OR EXISTS (SELECT 1 FROM ranked r WHERE r.actionId=f.actionId AND r.priority=1))
     ORDER BY f.position`, { chatId });
  const held = open.find(item => item.blocking);
  return {
    contactOptedOut: lastConsent(tx, chatId) === 'telegram_contact_opted_out',
    officerReview: held ? { actionId: held.actionId, messageId: held.messageId, reason: held.reason } : null,
    evidenceItems: open.map(({ blocking: _blocking, ...item }) => item),
  };
}

const BEFORE_OPT_IN = `a.type = 'telegram_contact_opted_in' AND NOT EXISTS (
  SELECT 1 FROM messages m WHERE m.id = a.message_id AND m.position = :messagePosition
    AND json_extract(a.detail, '$.contactReopened') = 1)`;

/** A manual retry may reopen an officer's decision, but must respect the contact's later opt-in boundary. */
export function predatesTelegramOptIn(tx: Tx, chatId: string, messagePosition: number): boolean {
  return tx.get(`SELECT 1 FROM case_actions a WHERE a.chat_id=:chatId AND a.position>=:messagePosition
    AND ${BEFORE_OPT_IN} LIMIT 1`, { chatId, messagePosition }) !== undefined;
}

export function isTelegramReplyHeld(tx: Tx, chatId: string, messagePosition?: number): boolean {
  const hold = getTelegramReplyHold(tx, chatId);
  if (hold.contactOptedOut || hold.officerReview) return true;
  if (messagePosition === undefined) return false;
  return tx.get(
    `SELECT 1 FROM case_actions a WHERE a.chat_id = :chatId AND a.position >= :messagePosition
     AND (${blockingReviewResolutionSql('a')} OR (${BEFORE_OPT_IN})) LIMIT 1`, { chatId, messagePosition },
  ) !== undefined;
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[’']/gu, '').replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[آأإ]/gu, 'ا').replace(/\s+/gu, ' ').trim();
}

const STOP_ONLY = /^(?:(?:please|pls|من فضلك|لو سمحت)[\s,،]+)?(?:stop|unsubscribe|leave me alone|no more messages|توقف|توقفوا|وقف|الغاء الاشتراك)(?:[\s,،]+(?:now|please|pls|الان|رجاء))?[.!?،؛؟…]*$/u;
const CONTACT_REQUESTS = [
  /^(?:stop|quit) (?:messaging|texting|contacting|writing to|replying to) me\b/u,
  /^(?:stop|quit) (?:messaging|texting|sending messages|replying)(?: (?:now|please))?$/u,
  /^(?:stop sending|(?:do not|dont|never) send) (?:me )?(?:any (?:more )?|more )?messages\b/u,
  /^(?:do not|dont|never|i (?:do not|dont) want you to) (?:message|text|contact|write to|reply to) me\b/u,
  /^(?:id|i would) (?:prefer|rather) (?:it )?(?:if )?you (?:didnt|did not) (?:message|text|contact|write to|reply to) me\b/u,
  /^leave me alone\b/u,
  /^(?:لا|ما) (?:تراسل(?:ني|وني)|ترسل(?:وا)? (?:لي|الي)|تكلمني|تتواصل معي)(?:\s|$)/u,
  /^لا ترد(?:ون|ين|وا)? علي(?: (?:مر[ةه] ثاني[ةه]|ابدا|مجددا|نهائيا|بعد اليوم))?(?: (?:رجاء|لو سمحت|من فضلك))?$/u,
  /^(?:(?:توقف|كف) عن |وقف )(?:مراسلتي|ارسال الرسا[يئ]ل)(?:\s|$)/u,
  /^(?:خلني|اتركني) بحالي(?:\s|$)/u,
];
const REPORTED_CLAUSE = /^(?:(?:he|she|they|someone|(?:the|my) (?:sender|customer|courier|friend)) (?:said|says|wrote|writes|asked|told me)|(?:(?:هو|هي|صاحبي|صاحبتي|صديقي|صديقتي|المرسل|العميل) )?(?:قال|قالت|قالوا|يقول|تقول|كتب|كتبت)(?: لي| لنا)?)\s*[,،:]\s*(?:(?:actually|please|خلاص)\s*[,،]\s*)*[^,،]+/u;
export function isTelegramContactOptOut(text: string): boolean {
  // Mask the quotation while preserving the speaker's own words on either side. Keep apostrophes in contractions.
  const unquoted = text.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|(?<![\p{L}\p{N}])['‘][^'’\n]*['’](?![\p{L}\p{N}])/gu, '""');
  return unquoted.split(/[.!?;؛؟\n]+/u).some(part => {
    const sentence = normalized(part).replace(REPORTED_CLAUSE, '');
    if (STOP_ONLY.test(sentence)) return true;
    return sentence.split(/[,،]/u).some(clause => {
      const request = clause.trim().replace(/^(?:(?:hey|hi|actually|please|pls|kindly|can you|could you|would you|خلاص|لو سمحت|من فضلك)\s+)+/u, '');
      return CONTACT_REQUESTS.some(pattern => pattern.test(request));
    });
  });
}

function isExplicitOptIn(text: string): boolean {
  const words = normalized(text).replace(/[.!؟]+$/u, '');
  return words === 'i agree to receive automated replies from mirsad' || words === 'اوافق على تلقي ردود الية من مرصاد';
}

// A new conversation has to be started by the contact. An acknowledgment, quotation, or a complaint about continued contact cannot start it.
const GREETING = /^(?:(?:hi|hey|hello)(?: there)?|good (?:morning|afternoon|evening)|مرحبا|اهلا|هلا(?: والله)?|السلام عليكم(?: ورحمة الله(?: وبركاته)?)?)(?: again| من جديد)?$/u;
const NEW_OFFER = /^(?:i have (?:an?|another|a new) offer for you\b|im (?:selling|offering) .{1,90}\bif (?:youre|you are) interested\b|عندي عرض (?:جديد )?لك(?:\s|$))/u;
const TALK_AGAIN = /^(?:(?:id|i would|i want to|lets|let us) (?:like to )?(?:talk|chat)(?: again| now)?|(?:please )?(?:reply|respond|text me|message me)(?: again| now)?|(?:hey,? )?(?:you|anyone) there|(?:تقدر ترد|ممكن ترد|رد علي|خلنا نتكلم)(?: (?:الان|الحين|مرة ثانية))?)$/u;
const QUESTION = /^(?:what|whats|which|who|when|where|why|how|is|are|am|was|were|do|does|did|can|could|will|would|should|shall|have|has)\s+\S/u;
const DIRECT_QUESTION = /^(?:(?:are|do|did|can|could|would|will|have) you|(?:can|could|shall) we|(?:when|where|how|what|why) (?:do|does|are|is|should|can|did))\s+\S|^(?:ممكن|هل|كيف|وش|شو|كم|وين|متى|ليش|لماذا|ما هو|تقدر)\s+\S/u;
const UNWANTED_CONTACT = /\b(?:messaging|texting|contacting|replying to) me\b|\bsending me (?:these |more |any )?messages\b|\b(?:stop|leave me alone|leave it|go away|unsubscribe)\b|(?:تراسلني|ترسل لي|تكلمني|تخليني|توقف|اتركني)|(?:ليش|لماذا) (?:للحين )?ترد(?:ون|ين|وا)? علي(?:\s|$)/u;
const EMPHATIC_STOP = /\b(?:never|again|anymore|any more|unsubscribe|no more messages)\b|(?:ابدا|مر[ةه] ثاني[ةه]|مجددا|نهائيا|بعد اليوم|الغاء الاشتراك)/u;

function invitationKind(text: string): 'opening' | 'invitation' | null {
  const words = normalized(text).replace(/[.!?،؛؟…👋\s]+$/u, '');
  if (GREETING.test(words) || NEW_OFFER.test(words)) return 'opening';
  if (TALK_AGAIN.test(words)) return 'invitation';
  if (UNWANTED_CONTACT.test(words)) return null;
  return DIRECT_QUESTION.test(words) || (QUESTION.test(words) && /[?؟]\s*$/u.test(text))
    ? 'invitation' : null;
}

interface PriorStop {
  type: ConsentDecision;
  position: number;
  received: string;
  sent: string;
  text: string | null;
  emphatic: number | null;
}

function latestPreference(tx: Tx, chatId: string): PriorStop | undefined {
  // Older installations recorded the source event but did not mark emphatic stops. Its text stays in the source event.
  return tx.get<PriorStop>(`SELECT a.type, a.position, coalesce(e.received_at, a.occurred_at) AS received,
    coalesce(e.source_occurred_at, e.received_at, a.occurred_at) AS sent, e.text,
    json_extract(a.detail, '$.emphatic') AS emphatic FROM case_actions a LEFT JOIN message_events e
    ON e.id = json_extract(a.detail, '$.messageEventId') WHERE a.chat_id = :chatId
    AND a.type IN ('telegram_contact_opted_out','telegram_contact_opted_in') ORDER BY a.position DESC LIMIT 1`, { chatId });
}

function emphaticStop(preference: PriorStop | undefined): boolean {
  return preference?.type === 'telegram_contact_opted_out'
    && (preference.emphatic === 1 || EMPHATIC_STOP.test(normalized(preference.text ?? '')));
}

function newExchange(tx: Tx, previous: PriorStop, kind: 'opening' | 'invitation', input: HoldInput): boolean {
  if (!input.receivedAt || !input.sentAt || (kind === 'opening' && emphaticStop(previous))) return false;
  const received = Date.parse(input.receivedAt);
  const sent = Date.parse(input.sentAt);
  if (received - Date.parse(previous.received) < REPLY_QUIET_MS || received - sent > REPLY_FRESHNESS_MS
    || sent - Math.floor(Date.parse(previous.sent) / 1_000) * 1_000 < REPLY_QUIET_MS) return false;
  // A run of messages a second apart is still the burst that contained Stop, even several seconds into the run.
  return tx.get(`SELECT 1 FROM (
    SELECT e.received_at, lag(e.received_at, 1, :stoppedAt) OVER (ORDER BY e.position) AS prior
    FROM message_events e JOIN messages m ON m.id=e.message_id WHERE e.chat_id=:chatId AND m.direction='incoming'
      AND e.position > :after AND e.capture_method='telegram_business_live' AND e.type IN ('recorded','edited','conflicting_copy')
  ) WHERE received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', prior, :quiet) LIMIT 1`,
    { chatId: input.chatId, after: previous.position, stoppedAt: previous.received, quiet: '+' + REPLY_QUIET_MS / 1_000 + ' seconds' }) !== undefined;
}

const STREET_ADDRESS = /\b\d{1,6}[a-z]?\s+(?:[\p{L}.'-]+\s+){0,5}(?:street|road|avenue|lane|drive|boulevard|court|st|rd|ave|ln|blvd)\b/iu;
const UNIT_ADDRESS = /\b(?:building|warehouse|villa|apartment|unit|suite|plot|shop|office|gate|tower)\s+(?:no\.?\s*|number\s+|#\s*)?[a-z]?\d{1,6}\b/iu;
const NAMED_VENUE = /\b[A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3}\s+(?:Mall|Station|Hotel|Tower|Plaza|Marina|Hospital|Airport)\b/u;
const PICKUP_POINT = /^(?:(?:the|our|your|my) )?pick[ -]?up point(?: for (?:the|this|that|our|your|my) (?:parcel|package|shipment|order))? (?:is|was) (?:at |near )?(.+)$/iu;
const ADDRESS_CONTEXT = /\b(?:(?:address|location|venue|pin) (?:is|was)|(?:office|incident|handover|pickup|meeting|delivery) (?:was |is )?(?:at|near)|(?:meet|happened|occurred) (?:me )?at|(?:im|i am|we are|were) at)\b|\b(?:address|location|venue|pin)\s*:/u;
const ARABIC_ADDRESS = /(?:(?:شارع|مول|فندق|محطة|برج|مطار)\s+[\p{L}\d]+|(?:مبنى|بناية|فيلا|مستودع|محل|شقة)\s+(?:رقم\s*)?[0-9٠-٩۰-۹]+)/u;
const ARABIC_CONTEXT = /(?:عنوان(?:ي|نا|ه|ها|\s+ال)|العنوان|موقع(?:ي|نا)|الموقع|مكان\s+(?:اللقاء|التسليم|الحادث)|قابلني\s+في|الواقعة\s+في|الحادث\s+في)/u;
const COORDINATES = /(?:^|[^\d.-])(-?\d{1,2}\.\d{3,})\s*[,،]\s*(-?\d{1,3}\.\d{3,})(?![\d.])/u;

function isMapPin(link: string): boolean {
  return /^(?:maps\.app\.goo\.gl\/|goo\.gl\/maps\/)\w/u.test(link)
      || /^(?:maps\.google\.com\/|google\.com\/maps\/)(?:place\/[^/?#]+|@-?\d|\?[^#]*\b(?:q|query|ll)=[^&#]+|search\/\?[^#]*\bquery=[^&#]+)/u.test(link)
      || /^maps\.apple\.com\/\?[^#]*\b(?:ll|address|coordinate)=[^&#]+/u.test(link);
}

function locationInStatement(text: string): string | null {
  const words = normalized(text);
  if (/[?؟]/u.test(words)) return null;
  const pair = words.match(COORDINATES);
  if (pair && Math.abs(Number(pair[1])) <= 90 && Math.abs(Number(pair[2])) <= 180 &&
      (words === pair[0].trim() || /(?:\b(?:pin|coordinates?|location)\b|موقع|احداثيات)/u.test(words))) return pair.slice(1).join(',');
  const street = words.match(STREET_ADDRESS);
  if (street && words.replace(/[.!]+$/u, '') === street[0]) return street[0];
  const pickup = text.trim().match(PICKUP_POINT)?.[1];
  if (pickup && [STREET_ADDRESS, UNIT_ADDRESS, NAMED_VENUE].some(place => pickup.search(place) === 0)) return normalized(pickup).replace(/[.!]+$/u, '');
  if (ADDRESS_CONTEXT.test(words)) return (street?.[0] ?? normalized(text.match(NAMED_VENUE)?.[0] ?? words.match(UNIT_ADDRESS)?.[0] ?? '')) || null;
  return ARABIC_CONTEXT.test(words) ? words.match(ARABIC_ADDRESS)?.[0] ?? null : null;
}

const QUOTED_WORDS = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|(?<![\p{L}\p{N}])['‘][^'’\n]*['’](?![\p{L}\p{N}])/gu;
const REPORTED_MATERIAL = /\b(?:they|he|she|someone|(?:the|a|my) (?:sender|customer|courier|recruiter|friend|email|message))\s+(?:sent|gave|said|wrote|asked|says|told|shared)\b|\bi (?:received|was sent|got sent)\b|\b(?:for example|example sentence|sample sentence|hypothetical|(?:do not|dont|never) (?:pay|open|transfer)|not (?:a |the )?payment link|avoid this link|is this safe|privacy policy)\b|(?:قال لي|قالت لي|ارسلوا لي|وصلني رابط|مثال على|لا تدفع|سياسة الخصوصية)/iu;
const PAYMENT_HANDOFF = /\b(?:payment|checkout|invoice|billing) (?:link|page|portal)|\b(?:pay|checkout) (?:me |us )?(?:here|at|using|via|through|by clicking)|\b(?:link|page) (?:is )?(?:for|to) (?:pay|payment|checkout)|(?:رابط|صفحة) (?:ال)?(?:دفع|سداد|فاتورة)|(?:ادفع|سدد) (?:هنا|عبر|عن طريق)/iu;
const PAYMENT_TARGET = /(?:^(?:pay|checkout|payments|billing)\.|^(?:buy\.stripe\.com|paypal\.me)\/[^/]|\/(?:pay|checkout|payments?|invoice|billing)(?:\/|[?#]|$))/iu;
const INFORMATION_PAGE = /\b(?:support|example|policy|faq|guide|documentation|tutorial|about|scam|safety)\b/iu;
type EvidenceKey = { reason: MaterialReason; value: string };

const PAYEE_CONTEXT = /\b(?:(?:bank transfer|payment|deposit|transfer|wire|remit) (?:to|into|here|instructions|details)|(?:pay|send|wire|transfer) (?:the |your )?(?:money|funds|fee|payment|deposit|amount) to|(?:for|to make) (?:the |your |a )?(?:bank )?(?:payment|transfer)|beneficiary (?:account|bank)|payee (?:account|bank))\b|(?:للتحويل|للدفع|حساب المستفيد|بيانات (?:التحويل|المستفيد)|حول (?:لي|المبلغ|الرسوم|على|الى)|التحويل (?:على|الى))/iu;
const BANK_EXCLUSION = /\b(?:never|dont|do not|not (?:my|our|the payees?)|beware|warning|masked|ending in|password|passcode|verification code|otp|credit card|debit card|card number|cvv)\b|(?:لا تحول|لا تستخدم|ليس(?:ت)? (?:رقم |هذه )?حساب|مو (?:رقم )?حساب|تحذير|احذر|ينتهي ب|كلمة (?:السر|المرور)|رمز التحقق|رقم البطاقة)/iu;
const IBAN_NUMBER = /(?<![a-z\d])([a-z]{2}\d{2}(?:[a-z\d]{11,30}|(?:[ -][a-z\d]{4}){2,7}[ -][a-z\d]{1,4}))(?![a-z\d*•])/iu;
const LABELED_ACCOUNT = /(?:\b(?:bank account|account number|account no\.?|acct\.? (?:no\.?|number))\b(?: (?:number|no\.?))?(?: is)?|رقم (?:الحساب|حساب(?:نا|ي)?)(?: (?:البنكي|المصرفي))?(?: هو)?)\s*[:#=-]?\s*(\d(?:[ -]?\d){5,19})(?![ -]?[\d*x•])/iu;
const BANK_LABEL = /\b(?:iban|payee account|beneficiary account|bank account)\b|(?:ايبان|حساب المستفيد|رقم حساب|رقم الحساب)/iu;

/** Route a clearly supplied recipient account to the officer. Do not copy its value into a review item. */
function paymentRecipient(part: string): string | null {
  const words = normalized(maskUrls(part, normalizeTelegramLink)).replace(/[٠-٩۰-۹]/gu, c => String(c.charCodeAt(0) % 16));
  if (!PAYEE_CONTEXT.test(words) || BANK_EXCLUSION.test(words) || /[*•]|x{3,}/iu.test(words)) return null;
  const iban = words.match(IBAN_NUMBER)?.[1]?.replace(/[ -]/gu, '').toUpperCase();
  if (iban && iban.length >= 15 && iban.length <= 34) {
    // A reference with two country-like letters can resemble an IBAN. For an unlabelled value require its IBAN check digits.
    const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/gu, letter => String(letter.charCodeAt(0) - 55));
    if (BANK_LABEL.test(words) || BigInt(digits) % 97n === 1n) return iban;
  }
  return words.match(LABELED_ACCOUNT)?.[1]?.replace(/[ -]/gu, '') ?? null;
}

/** Values used transiently to deduplicate directly supplied material. Persist only their chat-scoped digests. */
export function sharedTelegramMaterial(text: string, media: readonly string[], messageId: string): EvidenceKey[] {
  if (media.includes('forwarded') || media.includes('blockquote')) return [];
  const items: EvidenceKey[] = [];
  const links = new Map<string, 'link' | 'payment_link'>();
  for (const token of extractUrlTokens(text, normalizeTelegramLink)) {
    const link = normalizeTelegramLink(token);
    if (link) links.set(link, 'link');
  }
  if (media.includes('document')) items.push({ reason: 'document', value: messageId });
  let location: string | undefined;
  const plain = text.replace(QUOTED_WORDS, ' ');
  let reported = false;
  let precedingPaymentLabel = false;
  for (const part of plain.split(/(?<=[.!?؟])\s+|[;؛\n]+/u)) {
    const prose = normalized(maskUrls(part, normalizeTelegramLink));
    if (prose) reported = REPORTED_MATERIAL.test(prose) || /[?؟]/u.test(prose) || prose.startsWith('>');
    if (reported) continue;
    const bank = paymentRecipient(part);
    if (bank) items.push({ reason: 'bank_details', value: bank });
    const urls = extractUrlTokens(part, normalizeTelegramLink);
    let end = 0;
    let previousLinkWasPayment = false;
    for (const url of urls) {
      const offset = part.indexOf(url, end);
      const label = normalized(part.slice(end, offset));
      end = offset + url.length;
      const link = normalizeTelegramLink(url);
      if (!link) continue;
      const paymentLabel = PAYMENT_HANDOFF.test(label) || (urls.length === 1 && PAYMENT_HANDOFF.test(prose))
        || (precedingPaymentLabel && !label) || (previousLinkWasPayment && /^(?:[,،]?\s*(?:and|or|و)?\s*)$/u.test(label));
      if (!isMapPin(link) && !INFORMATION_PAGE.test(link.slice(link.indexOf('/') + 1)) && (paymentLabel || PAYMENT_TARGET.test(link))) {
        links.set(link, 'payment_link');
        previousLinkWasPayment = true;
        continue;
      }
      previousLinkWasPayment = false;
    }
    precedingPaymentLabel = !urls.length && PAYMENT_HANDOFF.test(prose) && /[:：]\s*$/u.test(prose);
    location ??= locationInStatement(maskUrls(part, normalizeTelegramLink)) ?? undefined;
  }
  for (const [value, reason] of links) items.push({ reason, value });
  if (location || media.includes('location') || media.includes('venue')) items.push({ reason: 'location', value: location ?? messageId });
  return items;
}

interface HoldInput {
  workspaceId: string;
  chatId: string;
  messageId: string;
  messageEventId: string;
  text: string;
  media: readonly string[];
  /** Opting back in requires a fresh, original message attributed to the contact. */
  allowOptIn: boolean;
  confirmedDmConsent?: boolean;
  /** Supplied only by live intake. Historical replay cannot create a new exchange from old chatter. */
  receivedAt?: string;
  sentAt?: string | null;
}

export function recordTelegramReplyHolds(tx: Tx, input: HoldInput, reviewEvidence = true, recordConsent = true): void {
  const { workspaceId, chatId, messageId, messageEventId, text } = input;
  const reference = { workspaceId, chatId, messageId, actorId: null, detail: { messageEventId } };
  if (recordConsent && !input.media.includes('forwarded') && !input.media.includes('blockquote')) {
    if (isTelegramContactOptOut(text)) {
      tx.run('DELETE FROM telegram_dispatch_permissions WHERE chat_id=?', [chatId]);
      const emphatic = EMPHATIC_STOP.test(normalized(text)) || emphaticStop(latestPreference(tx, chatId));
      record(tx, { ...reference, type: 'telegram_contact_opted_out', detail: { messageEventId, emphatic } });
    } else if (input.allowOptIn) {
      const explicit = input.confirmedDmConsent === true || isExplicitOptIn(text);
      const kind = invitationKind(text);
      const previous = (explicit || kind) ? latestPreference(tx, chatId) : undefined;
      if (previous?.type === 'telegram_contact_opted_out') {
        if (explicit) {
          record(tx, { ...reference, type: 'telegram_contact_opted_in' });
        } else if (kind && newExchange(tx, previous, kind, input)) {
          record(tx, { ...reference, type: 'telegram_contact_opted_in', detail: { messageEventId, contactReopened: true } });
        }
      }
    }
  }
  if (!reviewEvidence) return;
  const items = sharedTelegramMaterial(text, input.media, messageId);
  if (items.length) recordEvidenceItems(tx, input, items);
}

function recordEvidenceItems(tx: Tx, input: HoldInput, items: EvidenceKey[]): void {
  const { chatId, messageId, messageEventId, workspaceId } = input;
  // A reviewed source stays reviewed across edits and restarts. A genuinely new message starts fresh after a completed handoff.
  const cycleStart = tx.get<{ n: number }>(`SELECT coalesce(max(position),0) AS n FROM case_actions WHERE chat_id=:chatId
    AND type='telegram_officer_review_resolved' AND json_extract(detail,'$.cycleComplete')=1`, { chatId })!.n;
  const prior = tx.all<{ actionId: string; reason: ReviewReason }>(`SELECT id AS actionId, json_extract(detail,'$.reason') AS reason
    FROM case_actions WHERE message_id=:messageId AND type='telegram_officer_review_requested'
    UNION SELECT action_id, reason FROM telegram_evidence_sources WHERE message_id=:messageId`, { messageId });
  const distinct = new Map<string, { itemKey: string; reason: ReviewReason; actionId?: string }>();
  const testBoundary = readChatTestBoundary(tx, chatId);
  for (const { reason, value } of items) {
    const link = isTelegramLinkWarning(reason);
    const itemKey = link ? paymentLinkKey(chatId, value) : createHash('sha256').update(JSON.stringify([chatId, reason, value])).digest('hex');
    if (distinct.has(itemKey)) continue;
    const match = link ? tx.get<{ actionId: string }>(`SELECT s.action_id AS actionId FROM telegram_evidence_sources s
      JOIN case_actions a ON a.id=s.action_id WHERE s.chat_id=:chatId AND a.position>:testBoundary AND
        ((s.reason IN ('link','payment_link','reviewed_link') AND s.item_key=:itemKey) OR (s.reason='location' AND s.item_key=:mapKey))
      UNION ALL SELECT id FROM case_actions WHERE chat_id=:chatId AND position>:testBoundary AND type='telegram_officer_review_requested'
        AND json_extract(detail,'$.reason')='model_payment_link' AND json_extract(detail,'$.itemKey')=:itemKey LIMIT 1`,
      { chatId, testBoundary, itemKey,
        mapKey: isMapPin(value) ? createHash('sha256').update(JSON.stringify([chatId, 'location', value])).digest('hex') : null })
      : tx.get<{ actionId: string }>(`SELECT s.action_id AS actionId FROM telegram_evidence_sources s
      JOIN case_actions a ON a.id=s.action_id WHERE s.chat_id=:chatId AND s.reason=:reason AND s.item_key=:itemKey
      AND (s.message_id=:messageId OR a.position>:cycleStart) ORDER BY (s.message_id=:messageId) DESC, a.position LIMIT 1`,
      { chatId, reason, itemKey, messageId, cycleStart });
    distinct.set(itemKey, { reason, itemKey, actionId: match?.actionId });
  }
  const used = new Set([...distinct.values()].map(item => item.actionId));
  for (const { reason, itemKey, actionId: matched } of distinct.values()) {
    // Documents and locations keep their slots across edits. Different URLs and bank accounts require their own items.
    const reuseSourceSlot = reason === 'document' || reason === 'location';
    let actionId = matched ?? (reuseSourceSlot ? prior.find(slot => slot.reason === reason && !used.has(slot.actionId))?.actionId : undefined);
    if (!actionId) {
      const holdsReplies = reason === 'bank_details';
      actionId = record(tx, { workspaceId, chatId, messageId, actorId: null, type: 'telegram_officer_review_requested',
        detail: { messageEventId, reason, holdsReplies } }).id;
    }
    used.add(actionId);
    tx.run(`INSERT INTO telegram_evidence_sources(chat_id,message_id,reason,item_key,action_id)
      VALUES(:chatId,:messageId,:reason,:itemKey,:actionId) ON CONFLICT DO NOTHING`, { chatId, messageId, reason, itemKey, actionId });
  }
}

const INTAKE_START_KEY = 'telegram_reply_hold_intake_start';

/** Every event from this position onward already had its consent and approval scope checked at receipt. */
export function markTelegramHoldIntakeStart(tx: Tx, connectorId: string, position: number): void {
  tx.run(`INSERT OR IGNORE INTO connector_state(connector_id, key, value, updated_at) VALUES (:connectorId,:key,:position,:at)`,
    { connectorId, key: INTAKE_START_KEY, position: String(position), at: tx.now() });
}

/** Replay live contact preferences once per enrolled chat. Only fresh pending legacy evidence can open a historical review. */
export function backfillTelegramReplyHolds(tx: Tx, accountId: string, approvedChatIds: readonly string[], freshnessWindowMs: number, connectorId: string): void {
  const now = tx.now();
  if (tx.run(`INSERT OR IGNORE INTO connector_state(connector_id,key,value,updated_at) VALUES (?,?,'done',?)`,
    [connectorId, 'reviewed_source_links_v2:' + accountId, now]).changes) {
    const reviewed = tx.all<{ chatId: string; actionId: string }>(`SELECT DISTINCT done.chat_id AS chatId,f.id AS actionId
      FROM chats c JOIN case_actions done ON done.chat_id=c.id AND done.type='telegram_officer_review_resolved'
      JOIN case_actions f ON f.id=json_extract(done.detail,'$.reviewActionId') AND f.chat_id=c.id
      WHERE c.channel_account_id=? AND json_extract(f.detail,'$.reason') IN ('conversation_review','location')`, [accountId]);
    for (const item of reviewed) rememberReviewedTelegramLink(tx, item.chatId, item.actionId);
  }
  const threshold = new Date(Date.parse(now) - freshnessWindowMs).toISOString();
  const intakeStart = tx.get<{ value: string }>('SELECT value FROM connector_state WHERE connector_id = :connectorId AND key = :key',
    { connectorId, key: INTAKE_START_KEY });
  const beforePosition = intakeStart ? Number(intakeStart.value) : Number.MAX_SAFE_INTEGER;
  for (const externalChatId of new Set(approvedChatIds)) {
    const chat = tx.get<{ id: string; workspace_id: string }>(
      'SELECT id, workspace_id FROM chats WHERE channel_account_id = :accountId AND external_chat_id = :externalChatId', { accountId, externalChatId });
    if (!chat) continue;
    const key = 'telegram_reply_holds_v1:' + chat.id;
    if (!tx.run(`INSERT INTO connector_state (connector_id, key, value, updated_at) VALUES (:connectorId, :key, 'done', :now)
      ON CONFLICT DO NOTHING`, { connectorId, key, now }).changes) continue;
    const previousConsent = lastConsent(tx, chat.id);
    const answeredThrough = tx.get<{ n: number }>(
      "SELECT coalesce(max(position),0) AS n FROM messages WHERE chat_id = :chatId AND origin = 'source' AND direction = 'outgoing'", { chatId: chat.id })!.n;
    let cursor = 0;
    while (true) {
      // Message events are append-only. Read in insertion order and bound memory even on an established account.
      const rows = tx.all<{ cursor: number; eventId: string; messageId: string; text: string; type: string; media: string; sender: string | null; fresh: number }>(
        `SELECT e.rowid AS cursor, e.id AS eventId, m.id AS messageId, e.text, e.type, m.unsupported_content AS media, m.sender_external_id AS sender,
         CASE WHEN e.position > :answeredThrough AND m.deleted_at_source = 0 AND e.received_at >= :threshold AND (m.sent_at IS NULL OR m.sent_at >= :threshold)
         THEN NOT EXISTS (SELECT 1 FROM message_events later WHERE later.message_id = e.message_id AND later.position > e.position AND later.type IN ('recorded','edited'))
         ELSE 0 END AS fresh
         FROM message_events e JOIN messages m ON e.message_id = m.id WHERE e.rowid > :cursor AND e.chat_id = :chatId AND e.capture_method = 'telegram_business_live'
         AND e.position < :beforePosition AND e.connector_id = :connectorId AND m.direction = 'incoming' AND e.type IN ('recorded','edited') ORDER BY e.rowid LIMIT 64`,
        { cursor, answeredThrough, beforePosition, threshold, connectorId, chatId: chat.id });
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.cursor;
        if (!row.fresh && previousConsent) continue;
        recordTelegramReplyHolds(tx, {
          workspaceId: chat.workspace_id, chatId: chat.id, messageId: row.messageId, messageEventId: row.eventId,
          text: row.text ?? '', media: row.fresh && row.type === 'recorded' ? JSON.parse(row.media) as string[] : [],
          allowOptIn: row.type === 'recorded' && row.sender === externalChatId
            && !(JSON.parse(row.media) as string[]).some(kind => kind === 'forwarded' || kind === 'blockquote'),
        }, row.fresh === 1 && row.sender === externalChatId
          && !(JSON.parse(row.media) as string[]).some(kind => kind === 'forwarded' || kind === 'blockquote'), !previousConsent);
      }
    }
  }
}
