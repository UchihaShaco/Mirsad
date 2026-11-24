/** Deterministic privacy and identity checks on outgoing drafts. Only the rule name is recorded on failure. */
import { asksAliName, isArabicReplyTurn, isIdentityCheck, offerGuardContext } from './reply-context.ts';
import { mentionsProjectName, withoutAssistantIntroduction, type ReplyOfferMemory, type ReplyTurn } from './reply-generator.ts';
import type { ReplyGuardRule } from './reply-guard-rules.ts';
export { REPLY_GUARD_RULES, type ReplyGuardRule } from './reply-guard-rules.ts';

type PaymentInstructionPolicy = 'guarded' | 'prompt';

/** The model wrote only blocked replies; `rule` names what the last one broke. */
export class ReplyBlockedError extends Error {
  readonly rule: ReplyGuardRule;

  constructor(rule: ReplyGuardRule) {
    super(`reply blocked by the reply guard: ${rule}`);
    this.name = 'ReplyBlockedError';
    this.rule = rule;
  }
}

/** Western, Arabic-Indic and Extended Arabic-Indic digits. */
const DIGIT = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]';
/**
 * Nine or more digits, with single spaces, dots, dashes, slashes or underscores between them: a phone (a UAE landline has
 * nine digits with its area code), card, account or ID number. Prices up to eight digits and dates pass.
 */
const LONG_NUMBER = new RegExp(`${DIGIT}(?:[\\s.\\-\\u2013\\u2014/_]?${DIGIT}){8,}`, 'u');
/**
 * A scheme, www., a bare host whose top-level domain is followed by a path, a port, punctuation or the end, or a short
 * link host (t.me, wa.me, bit.ly, goo.gl, t.co and the like) followed by a path. Endings such as .me or .co count only
 * with a path, so "ok.me later" is not a link.
 */
const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|ru|ae|xyz|app|link|info|biz)(?=[/:?#]|[\s.,!)]|$)|\b[a-z0-9-]+\.(?:me|ly|co|gl|to|gg)\//i;
// Match positive directions at a clause boundary, so "don't open that link" stays available.
const SUPPLIED_LINK = String.raw`(?:the|that|this|their|your)\s+(?:provided |shared |sent )?(?:link|url)\b`;
const LINK_ADVICE_EN = [
  String.raw`(?:click(?:ing)?(?: on)?|open(?:ing)?|visit(?:ing)?|follow(?:ing)?|tap(?:ping)?(?: on)?)\s+` + SUPPLIED_LINK,
  String.raw`check(?:ing)?\s+` + SUPPLIED_LINK + String.raw`(?!\s+with (?:your bank|the company|the sender))`,
].join('|');
const LINK_ADVICE_AR = [
  String.raw`(?:افتح|إفتح|فتح|تفتح|اضغط على|الضغط على|انقر على|النقر على|ادخل على|الدخول (?:إلى|على)|تفقد|تفقّد)\s+(?:هذا |ذلك )?(?:الرابط|اللينك)(?!\p{L})`,
  String.raw`(?:تحقّ?ق|التحقق) من (?:هذا |ذلك )?(?:الرابط|اللينك) (?:مباشرة|في (?:متصفحك|المتصفح|التطبيق))`,
].join('|');
const LINK_ADVICE = new RegExp(String.raw`(?:^|[.!?؟;؛:,،]\s*)(?:` + [
  String.raw`(?:(?:so|but|instead)\s+)?(?:(?:you (?:can|could|should)|try|please|go ahead and)\s+)*(?:` + LINK_ADVICE_EN + ')',
  String.raw`(?:(?:يمكنك|بإمكانك|تقدر|يرجى|جرّ?ب|من فضلك)\s+)*(?:` + LINK_ADVICE_AR + ')',
].join('|') + ')', 'iu');
/** An Arabic word or phrase on its own: no letter right before or after it. */
const arabicWord = (phrase: string): string => String.raw`(?<!\p{L})(?:${phrase})(?!\p{L})`;
const HUMAN_CLAIM = new RegExp(
  [
    String.raw`\b(?:i am|i'm|im) (?:just |only )?(?:a |an )?(?:real |normal |ordinary |regular |actual )?(?:human|person|guy|girl|man|woman|lady)\b`,
    String.raw`\b(?:i am|i'm|im) not (?:a |an )?(?:bot|ai|robot|program|machine)\b`,
    String.raw`\bnot a bot\b`,
    // The possessive is allowed: "I'm the account holder's automated assistant."
    String.raw`\b(?:i am|i'm|im) (?:the )?(?:account[- ]?(?:holder|owner)|(?:owner|holder) of (?:this|the) (?:telegram |business )?account)\b(?!'s\b)`,
    String.raw`\bi own (?:the|this) (?:telegram |business )?account\b`,
    // "I am human", "I am a human being", "I am a real / ordinary / normal person", "I am not a machine / robot / bot".
    arabicWord('[أا]نا (?:إنسان|انسان|بشر)'),
    arabicWord('[أا]نا شخص'),
    arabicWord('[أا]نا (?:صاحب[ةه]?|مالك[ةه]?) (?:هذا )?الحساب'),
    arabicWord('هذا حسابي'),
    arabicWord('(?:[أا]نا )?لست (?:آلة|ألة|روبوت|بوت)'),
  ].join('|'),
  'iu',
);
// Mirsad can write chat text. These first-person claims assert actions outside its capabilities.
const EXTERNAL_ACTION = new RegExp([
  String.raw`\bi(?:'ll| will| am going to|'m going to) (?:just )?(?:sign up|book|reserve)\b`,
  arabicWord('(?:سأحجز|(?<!ما )راح [أا]حجز)'),
  String.raw`\b(?:can|could|may) i (?:book|reserve|sign up)\b`,
  String.raw`(?:^|[.!?,]\s*)(?:please )?(?:book me in|reserve (?:a |the )?(?:place|slot|spot) for me)\b`,
  arabicWord('(?:هل )?(?:يمكنني|ممكن|[أا]قدر|[أا]ستطيع) (?:الحجز|[أا]حجز|حجز(?: مكان| مقعد| موعد)?|تحجز لي)'),
  String.raw`\b(?:an?|the) officer (?:will|would(?: need to)?|is going to) review\b`,
  String.raw`\b(?:contact|reach out to|use) (?:our|mirsad's) (?:official )?(?:support(?: team)?|(?:website|support portal|dashboard))\b`,
  arabicWord('(?:تواصل|اتصل) (?:ب|مع )(?:فريق )?الدعم (?:لدينا|الخاص بنا)|سيراجع (?:الضابط|الموظف)'),
  String.raw`\bi(?:'ll| will) (?:let (?:them|him|her|the owner) know|pass (?:it|that|(?:the|your) message) (?:along|on)|(?:message|contact|call|notify) (?:them|him|her|the owner))\b`,
  arabicWord('(?:سأوصل|راح (?:أوصل|اوصل)) رسالتك|(?:س(?:أبلغ|ابلغ)|راح (?:أبلغ|ابلغ))(?:هم|ها|ه)'),
  String.raw`\bi(?:'ve| have)? (?:already |just )?(?:(?:opened|verified|downloaded|reviewed|checked) (?:the|your|that|this) (?:link|document|file|attachment)|(?:called|messaged|contacted|paid) (?:you|them|the owner))\b`,
  arabicWord('(?:لقد )?(?:فتحت|حمّلت|حملت|راجعت|فحصت) (?:الملف|المستند|الرابط|المرفق)'),
].join('|'), 'iu');
const SECRET = String.raw`(?:password|verification code|one[- ]time (?:code|password)|otp|pin|card number|bank (?:password|credentials))`;
const SECRET_REQUEST = new RegExp([
  String.raw`\b(?:i|we) (?:ask for|require|collect) (?:your )?${SECRET}s?\b`,
  arabicWord('(?<!لا )(?<!لن )(?:و|ف)?(?:[أا]طلب|نطلب) (?:كلم(?:ة|ات) (?:المرور|السر)|رمز التحقق|رقم البطاقة)'),
  String.raw`(?<!not )(?<!n't )(?<!never )(?<!not to )\b(?:send|give|tell|share)(?: (?:me|us))? (?:the |a |your )?${SECRET}\b`,
  String.raw`\bwhat(?:'s| is) your ${SECRET}\b`,
  arabicWord('(?:أرسل|ارسل|ابعث|أعطني|اعطني)(?: لي)? (?:رمز التحقق|كلمة المرور|رقم البطاقة)'),
].join('|'), 'iu');

const EVENT = /\b(?:pick[ -]?up|meeting|meetup|handover|collection|delivery)\b|(?:استلام|تسليم|اجتماع|لقاء|مقابلة|موعد)/iu;
// Requests for transaction logistics. Scope and price questions remain available.
const PAYMENT_INSTRUCTIONS = new RegExp(String.raw`(?:^|[.!?؟,،;؛]\s*)(?:` + [
  String.raw`(?:how|where) (?:do|can|should|would) (?:i|we) (?:pay|transfer|wire|send (?:it|the money))\b`,
  String.raw`(?:which|what) (?:account|wallet|payment method) (?:do|can|should|would)\b`,
  String.raw`(?:is|can) .{0,25}\b(?:paid|pay) (?:online|by (?:card|bank|transfer)|over the phone)\b`,
  String.raw`(?:is (?:it|that)|do you (?:take|accept|prefer)) (?:cash|card|bank transfer|wire transfer|crypto) (?:or|instead of)\b`,
  String.raw`(?:(?:can|could|would) you |please )?(?:send|share|give)(?: me| us)? (?:a |the |your )?(?:payment link|wallet address|payment instructions|bank details|bank account number|iban)\b`,
  String.raw`what(?:'s| is| are) your (?:iban|bank details|bank account number)\b|i (?:can|will) (?:do (?:bank|wire) transfers?\b|(?:wire|transfer) (?:it|the money|the amount)\b)`,
  String.raw`(?:كيف|وين|أين) (?:أ|ا)(?:دفع|حوّ?ل)(?!\p{L})|هل (?:الدفع|[أا]دفع) (?:يكون )?(?:عبر|بتحويل|بالتحويل|عن طريق|نقد|كاش|بالبطاقة|اونلاين|أونلاين)`,
  String.raw`(?:ممكن |تقدر )?(?:ترسل|[أا]رسل|ابعث)(?: لي)? (?:رابط الدفع|تفاصيل التحويل|رقم الحساب|(?:رقم )?ال[اآإأ]يبان)|[أا]قدر [أا]حوّ?ل لك (?:المبلغ|الفلوس)`,
].join('|') + ')', 'iu');
const PLACE = /\b(?:at|near|outside|inside|there|address|location|venue|on)\b|(?:في|عند|بجوار|بجانب|مكان|موقع|عنوان|هناك)(?:\s|[؟?]|$)/iu;
const MATERIAL = String.raw`(?:(?:registration |booking |checkout )?link|url|website|brochure|document|file|invoice|attachment|passport|id card|identity document)\b`;
const REQUEST_MATERIAL = new RegExp(String.raw`(?:^|[.!?؟,،;؛]\s*)(?:` + [
  String.raw`(?:(?:can|could|would) you |please )?(?:send|share|upload|attach)(?: me| us)? (?:a |an |the |your |that )?` + MATERIAL,
  String.raw`(?:do you have|got|can i (?:get|see)) (?:a |an |the |your )?` + MATERIAL,
  String.raw`(?:ممكن |تقدر |لو سمحت |هل (?:تودون |تريدون |يمكنكم |يمكنك )?(?:أن )?)?(?:ترسل(?:وا|ون)?|[أا]رسل|ابعث)(?: لي)? (?:ال)?(?:رابط|لينك|ملف|مستند|كتيب|بروشور|فاتورة)(?!\p{L})`,
].join('|') + ')', 'iu');
const LOCATION_REQUEST = /(?:^|[.!?؟,،;؛]\s*)(?:(?:what(?:'s| is) (?:your|the) (?:exact |full |home |street )?address|where (?:exactly (?:are you|is it)|(?:are you|is (?:it|the .{1,35})) located exactly))\b|و?(?:وين|أين|ما هو|ما) (?:موقعك|عنوانك)|و?(?:مكان|موقع|عنوان) .{1,40}(?:إيه|ايه|وين|فين|أين) بالضبط)/iu;
const VERIFY_EVENT = /^(?:is|was|will|did|does|do|can|could|has|have)\b|^(?:هل|تقدر|ممكن|تأكد)\s|(?:\b(?:right|correct)|صح)\s*[?؟]$/iu;
const RECALL_EVENT = /\b(?:did (?:i|you|we) (?:say|mention|tell)|you (?:said|mentioned))\b|(?:هل|وش|شو|ماذا).{0,25}(?:قلت|ذكرت)/iu;
const AFFIRM_PLACE = /^(?:yes|yeah|yep|correct|confirmed|exactly|absolutely|that's (?:right|correct))\b|^(?:نعم|صحيح|أكيد|بالتأكيد|مؤكد|أجل|إيه)(?:[ ،,.!]|$)/iu;
const CLAIM_PLACE = /^(?:(?:(?:the|your) (?:pick[ -]?up|meeting|venue|location|handover|collection|delivery)|it) (?:is|was|will be) (?:confirmed|scheduled|at|on|near|there|outside|inside)|i (?:can confirm|verified|confirmed))\b|^(?:كان (?:اللقاء|الاستلام|التسليم|الاجتماع|الموعد) (?:في|عند)|(?:الاستلام|اللقاء|التسليم|الاجتماع|الموعد) (?:كان |سيكون )?(?:في|عند)|تم تأكيد (?:مكان|موقع|اللقاء|الاستلام)|أؤكد أن)/iu;
const ATTRIBUTED_OR_UNCERTAIN = /^(?:you (?:said|mentioned|wrote|told me)|according to (?:you|your message)|i (?:can't|cannot|don't know|do not know|am unsure)|i'm (?:unsure|not sure)|(?:أنت )?(?:ذكرت|قلت|كتبت)|حسب (?:كلامك|رسالتك)|لا (?:أعرف|أعلم|أستطيع)|لست متأكد)/iu;

function claimsUnverifiedPlace(draft: string, contact: string): boolean {
  // All the cues must belong to one question. A statement and an unrelated question can share a turn.
  const verification = contact.match(/[^.!?؟\n]+[?؟]?/gu)?.some(part => {
    const question = part.trim();
    return VERIFY_EVENT.test(question) && EVENT.test(question) && PLACE.test(question) && !RECALL_EVENT.test(question);
  });
  if (!verification) return false;
  return draft.split(/[.!?؟;؛\n]+/u).some(sentence => {
    const claim = sentence.trim();
    const affirmative = claim.match(AFFIRM_PLACE);
    if (!affirmative) return CLAIM_PLACE.test(claim.replace(/^(?:no|لا)[,،]\s*/iu, ''));
    return !ATTRIBUTED_OR_UNCERTAIN.test(claim.slice(affirmative[0].length).replace(/^[\s,،:]+/u, ''));
  });
}

// Requests for a reference imply a lookup that this assistant cannot perform. Warnings and carrier guidance pass.
const LOOKUP_IDENTIFIER = /^(?:the |your |an? )?(?:order|tracking|shipment|booking) (?:number|id|reference|code)\b|^(?:رقم|معرّ?ف|مرجع) (?:الطلب|التتبع|الشحنة|الحجز)/iu;
const ASK_IDENTIFIER = /^(?:(?:(?:could|can|would) you (?:please )?|please )?(?:send|tell|give|share|provide)(?: (?:me with|us with|with me|me|us))? |what(?:'s| is) |do you have |(?:can|could) i (?:have|get) |i(?:'d| would|'ll| will)? need |(?:ممكن |هل يمكنك |من فضلك )?(?:أرسل|ارسل|أعطني|اعطني|تعطيني|ترسل|شارك|اذكر)(?: لي)? |ما (?:هو )?|(?:وش|شو|عندك|أحتاج|احتاج) )/iu;
function asksForLookupIdentifier(draft: string): boolean {
  return draft.split(/[.!?؟;؛,،:\n]+/u).some(sentence => {
    const claim = sentence.trim();
    const opening = claim.match(ASK_IDENTIFIER);
    return opening !== null && LOOKUP_IDENTIFIER.test(claim.slice(opening[0].length));
  });
}

/** Checked in this order; the first that matches is the one reported. */
const RULES: readonly (readonly [ReplyGuardRule, RegExp])[] = [
  ['link', LINK],
  ['unsafe_link_advice', LINK_ADVICE],
  ['long_number', LONG_NUMBER],
  ['human_claim', HUMAN_CLAIM],
  ['external_action', EXTERNAL_ACTION],
  ['secret_request', SECRET_REQUEST],
  ['payment_instructions', PAYMENT_INSTRUCTIONS],
  ['request_material', REQUEST_MATERIAL],
  ['location_request', LOCATION_REQUEST],
  ['location_request', /\b(?:do you have|can you (?:send|share|give)(?: me)?) (?:a |the |your )?(?:specific|exact|street|home) (?:location|address)\b/iu],
  ['code_block', /(?:`{3}|^\s*~{3,}[^\n]*\n)/m],
  ['shopping_claim', /\bi(?:'m| am) (?:no longer|still|not(?: currently)?) (?:looking|shopping) (?:for\b|to (?:buy|rent|apply)\b)|(?:لم أعد|ما زلت|لا) أبحث عن/iu],
];

/** Typographic apostrophes as plain ones, so "I’m" and "I'm" read alike. */
const normalise = (text: string): string => text.replace(/[‘’ʼ]/g, "'");

const sellerText = (text: string) => normalise(text).normalize('NFKC').toLowerCase()
  .replace(/[\u064B-\u065F\u0670\u0640]/gu, '').replace(/[أإآ]/gu, 'ا');
const sellerClauses = (text: string) => sellerText(text).split(/[.!?؟,،;؛\n]+|\s+(?:but|however|و?لكن|بس)\s+|\s+and\s+(?=(?:i|we|my|our|here)\b)|\s+و(?=(?:ما|انا|اقدر|عندي|عنواني|رقمي)\s)/u)
  .map(clause => clause.trim()).filter(Boolean);
const PHOTO_OR_DETAILS = /\b(?:photos?|pics?|pictures?|images?|screenshots?|details|specs|specifications|address|number|location|account|prices?|quotes?|catalog(?:ue)?|products?|items?|files?|documents?|links?|id)\b|صور|تفاصيل|مواصفات|بيانات|معلومات|رقمي|عنواني|موقعي|حسابي|سعر|كتالوج|ملف|هويتي|القطعة|المنتج/u;
const OFFER_TO_SHOW = [
  /^(?:(?:do|would) you (?:like|want)|want) (?:to (?:see|have a look)|(?:an? |the |some )?(?:pic(?:ture)?s?|photos?))\b/u,
  /\b(?:let me|i(?:'ll| can| could| will)|(?:like|want) me to) show (?:you\b|(?:it|them|that) to you\b)/u,
  /^(?:هل )?(?:تبا|تبي|تبغي|تبغى|تريد|تحب|ودك) (?:تشوف(?:ه|ها|هم|ين)?|تاخذ نظرة|صورة|صور)(?:\s|$)/u,
  /^(?:(?:تبا|تباني|تبي|تبيني|تحب|تبغي|اقدر|خلني) )?(?:ب?ا?راويك|ب?ا?وريك|اعرضه عليك)(?:\s|$)/u,
  /(?:^|\s)اقدر\s+(?:اني\s+)?اشوف(?:ه|ها|هم)?\s*ل(?:ك|ج)(?:\s|$)/u,
];
const OFFER_TO_SUPPLY = [
  /\b(?:(?:i|we)(?:'ll| will| can| could| can also| have| just)?|(?:could|can|shall|should) i|let me|(?:like|want|need) me to) (?:send|show|share|give|provide|forward|attach|offer|quote|sent|attached|shared)\b/u,
  /(?:^|\s)(?:(?:ب|س)?(?:اطرش|ارسل|ابعث|اشارك|اعطي|اعرض|اصور|اوري|اراوي)ك?(?:م|ن|ها|ه)?|اشوفك|بطرش|برسل|بصور|بوريك|براويك|بعطيك|طرشت لك|ارسلت لك)(?:\s|$)/u,
  /^(?:here(?:'s| is| are)|these are|this is) (?:my|our|a|the|some)\b/u,
  /^(?:هذي|هاي|هذا|هاذي|هذه|تفضل(?:ي|وا)?)\s+(?:ال)?(?:صور|بياناتي|تفاصيل|مواصفات|رقمي|عنواني|موقعي|حسابي)/u,
  /(?:^|\s)(?:ال)?صور(?:ة|ه|ته|تها|تك|ها|هم)?\s+(?:\p{L}+\s+){0,2}ل(?:ك|ج|كم)(?:\s|$)/u,
];
const SELLER_OR_PERSONAL_CLAIM = [
  /\b(?:i|we)(?:'m| am| are|'re| can| will|'ll)? (?:sell(?:ing)?|stock|supply|deliver|ship)\b|\b(?:i|we) have .{0,45}\bin stock/u,
  /\b(?:my|our) (?:asking price|price|shop|store|delivery address|email|phone number|address) is\b|\bi(?:'m| am) (?:your|the|a) (?:seller|vendor|supplier)\b/u,
  /^(?:i live (?:in|at)|i work (?:for|as)|i(?:'m| am) \d{1,3} years old)\b/u,
  /(?:^|\s)(?:متوفر[هة]?|موجود[هة]?) (?:عندي|عندنا)(?:\s|$)|^(?:ال\p{L}+ )+(?:عندي|عندنا)$|^(?:انا )?(?:عندي|عندنا) .{0,45}(?:للبيع|بالمخزون)/u,
  /(?:^|\s)(?:ابيع|نبيع|نوصل|نشحن) (?:لك(?:\s|$)|ال\p{L}+)|^انا (?:البايع|البياع|البائع|صاحب (?:المحل|البضاعة))(?:\s|$)/u,
  /^(?:محلنا|سعري|سعرنا) (?:في|هو|يبدا|\p{N})|^(?:انا )?(?:ساكن|اسكن|اشتغل) (?:في|عند)(?:\s|$)|^عمري \p{N}+/u,
];
const NAME_CLAIM = /^(?:my name is|(?:you can )?call me|اسمي|تقدر تناديني) (.+)$/u;
const ALI_NAME = /^(?:ali|علي)(?:$|\s+(?:and\b|the\b|و?انا(?:\s|$)))/u;
const DECLINES_ROLE_OR_DISCLOSURE = /^(?:(?:i|we)(?:'m not| am not| are not|'re not| can't| cannot| won't| will not| don't| do not| never)\b|(?:انا |نحن )?(?:لا |ما |مب |مو |مش |لست |ماني |ماشي عندي ))/u;
const PRIVATE_LABEL = /^(?:my|our) (?:address|email|phone number) is (?:private|personal|confidential|not shared)\b/u;

/** Explicit claims only. An unqualified agreement needs the separate turn-level check below. */
export function isSellerOrDisclosureClaim(text: string): boolean {
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu.test(text)) return true;
  const affirmative = sellerClauses(text).filter(clause => !DECLINES_ROLE_OR_DISCLOSURE.test(clause) && !PRIVATE_LABEL.test(clause));
  // Colloquial promises can omit the send verb: assent, a short wait, and a picture for the recipient.
  if (affirmative.some(clause => /^(?:هيه|ايه|نعم|اكيد|ابشر|تمام)(?:\s|$)/u.test(clause))
    && affirmative.some(clause => /صور/u.test(clause))
    && affirmative.some(clause => /(?:^|\s)(?:ل(?:ك|ج|كم)|عشانك)(?:\s|$)/u.test(clause))
    && affirmative.some(clause => /لحظ[هة]|دقيق[هة]|شوي|انطر|انتظر|عقب/u.test(clause))) return true;
  return affirmative.some(clause => {
    const name = NAME_CLAIM.exec(clause);
    if (name && !ALI_NAME.test(name[1]!)) return true;
    if (SELLER_OR_PERSONAL_CLAIM.some(pattern => pattern.test(clause))) return true;
    if (OFFER_TO_SHOW.some(pattern => pattern.test(clause))) return true;
    return PHOTO_OR_DETAILS.test(clause) && OFFER_TO_SUPPLY.some(pattern => pattern.test(clause));
  });
}

// A short price, specification, or "sure" can convey seller terms without a first-person claim.
const PRICE_QUOTE = /^(?:(?:the |my |our )?(?:price|asking price) (?:is )?|(?:السعر|السعر النهائي|سعري|سعرنا) (?:هو )?)?(?:[$€£]\s*\p{N}|\p{N}+(?:[.,]\p{N}+)?\s*(?:dirhams?|dollars?|aed|usd|euros?|درهم|دراهم|دولار|ريال))|^(?:the price is|السعر|سعري|سعرنا)\s+[٠-٩۰-۹0-9]/u;
const ASK_SELLER = [
  /\b(?:you(?:'re| are) (?:now )?(?:the|my) (?:seller|vendor)|(?:buy|buying) (?:it |this )?from you|your (?:price|stock|inventory|asking price|payment details|delivery address|phone number|email address))\b/u,
  /^(?:what|which|how much)\b.*\b(?:price|your product|your listing|asking for|selling for)\b/u,
  /(?:^|\s)(?:(?:انت|انته|انتي) (?:اللي تبيع|البايع|البائع|البياع)|بكم تبيع(?:ها|ه)?|كم سعرك|(?:شو|كم|بكم) (?:هو )?(?:السعر|سعر))(?:\s|$)/u,
  /^(?:(?:so|then) )?where(?:'s| is| are| can i see) .{0,45}\b(?:photo|picture|pic|image)s?\b/u,
  /^(?:(?:عيل|زين|طيب) )?(?:وين|اين) (?:ال)?صور\p{L}*/u,
];
const REQUEST_TO_SUPPLY = /^(?:(?:please |can you |could you |would you )*(?:send|show|give|share|provide|quote)(?: me| us)?\b|(?:ممكن |لو سمحت |تقدر )*(?:طرش|تطرش|ارسل|ترسل|اعرض|ورني|توريني|تراويني|راوني|عطني|تعطيني|عطنا)(?:لي|نا)?(?:\s|$))/u;
const DIRECT_MEDIA_REQUEST = /(?:^|\s)[وف]?(?:(?:طرش|ارسل|رسل|ابعث|صور)(?:\s*لي|ي)|وريني|ورني|راويني|راوني)\s+(?:\p{L}+\s+){0,3}(?:ال|هال)?صور\p{L}*/u;
const ACCEPTS_PRIOR_OFFER = /^(?:yes|sure|okay|go ahead|send it|show me|هيه|ايه|اكيد|تمام|طرشها|ارسلها)(?:\s|$)/u;
// In direct seller requests, permit refusals, identity and questions about the other party's offer.
const SAFE_CONSUMER_ANSWER = [
  /^(?:no$|(?:i(?:'m| am) )?(?:(?:just|only) )?(?:the |a )?(?:buyer|consumer|recipient)\b|not the seller\b|you(?:'re| are) (?:the|a) (?:seller|one offering)\b)/u,
  /^(?:i keep (?:that|those details|that information) private|i(?:'d| would) rather keep (?:that|those details) private)$/u,
  /^(?:i(?:'m| am) ali$|(?:i(?:'m| am) |the |an? )?(?:automated|ai assistant)\b|(?:my name is|call me) ali$)/u,
  /^(?:what are you offering|what(?:'s| is) (?:your|the) .{1,35} like|i(?:'m| am| was) asking about your offer)\b/u,
  /^(?:لا$|(?:انا )?(?:المشتري|مشتري|المتلقي|مستفسر|مساعد الي|اسال عن عرضك)|انت (?:اللي تبيع|البايع)|اسمي علي$)/u,
];
const DETAIL_LIST = /^(?:or )?(?:address|phone number|bank details|personal details)$/u;

// Account and identity data can be handed over privately. Never solicit or relay it in public drafts.
const PRIVATE_TRANSFER_DATA = /\b(?:iban|swift(?: code)?|bic code|routing number|sort code|beneficiar(?:y|ies)|registered (?:account |legal )?name|full (?:legal )?name|account (?:holder|number|details)|(?:bank|banking|transfer|payment) (?:account|details|instructions)|name (?:is )?(?:on|of) (?:the|your) account|wallet address|passport (?:number|details)|national id|identity number)\b|(?:ايبان|المستفيد|اسم (?:صاحب|مالك) الحساب|اسمك (?:الكامل|الثلاثي)|اسم (?:البنك|المصرف)|رقم (?:حساب|الحساب|الهوي[ةه]|الجواز)|بيانات (?:الحساب|التحويل)|عنوان المحفظ[ةه])/iu;
const ASKS_BANK = /\b(?:which|what) bank\b|\bwho(?:se name)? (?:do|should|can) (?:i|we) (?:send|transfer|pay|wire)\b|(?:اي (?:بنك|مصرف)|[بف]اي (?:بنك|مصرف)|لم[ين]+ احول|باسم م(?:ن|نو))/iu;
const IBAN_VALUE = /\b[a-z]{2}[0-9]{2}(?:[ -]?[a-z0-9]){10,30}\b/iu;
function includesPrivateTransferData(draft: string): boolean {
  const text = sellerText(draft);
  if (IBAN_VALUE.test(text) || ASKS_BANK.test(text)) return true;
  const remaining = text.replace(/\bnot the account holder(?=[.!]|$)|\bthe account holder's automated assistant\b/gu, '');
  if (!PRIVATE_TRANSFER_DATA.test(remaining)) return false;
  // A complete refusal can mention what was withheld. An added question or request still fails.
  return !/^(?:i(?: am automated and)? (?:cannot|can't|don't|will not) (?:provide|share|give) [\p{L}\s,]+|(?:please )?keep (?:your|those) [\p{L}\s]+ private|(?:افضل|احب) اخلي [\p{L}\s]+ خاص[ةه]?)\.?$/u.test(text)
    || /\b(?:but|except|tell me|send me|what|which)\b|(?:لكن|طرشلي|عطني)/u.test(text);
}
function answersAsSeller(draft: string, history: readonly ReplyTurn[], active: readonly string[]): boolean {
  const requested = active.some(text => sellerClauses(text.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, '')).some(clause => {
    if (/^(?:قال|قالت|قالوا|يقول|يقولون|كتبت)\s/u.test(clause)) return false;
    return ASK_SELLER.some(pattern => pattern.test(clause)) || (REQUEST_TO_SUPPLY.test(clause) && PHOTO_OR_DETAILS.test(clause))
      || (DIRECT_MEDIA_REQUEST.test(clause) && !/(?:^|\s)(?:لا|ما)\s+[وف]?(?:ت?طرش|ترسل|تراوي|توريني)/u.test(clause));
  }));
  if (!requested) {
    const previousReply = history.findLast(turn => turn.from === 'owner');
    if (!previousReply || !active.some(text => sellerClauses(text).some(clause => ACCEPTS_PRIOR_OFFER.test(clause)))
      || !isSellerOrDisclosureClaim(previousReply.text)) return false;
  }
  const clauses = sellerClauses(draft);
  return !clauses.every(clause => DECLINES_ROLE_OR_DISCLOSURE.test(clause) || PRIVATE_LABEL.test(clause)
    || SAFE_CONSUMER_ANSWER.some(pattern => pattern.test(clause))
    || (DETAIL_LIST.test(clause) && clauses.some(other => /\b(?:cannot|can't|don't|will not) (?:provide|share|give)\b/u.test(other))));
}

/** The words of a reply in lower case, without punctuation, for spotting a repeat. */
const wordsOf = (text: string): string =>
  normalise(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Carry only the failed guard code into the next attempt. */
export function correctionFor(rule: ReplyGuardRule): ReplyGuardRule {
  return rule;
}

/** Short acknowledgments can recur in ordinary conversation. Identity questions also check the last short reply. */
const MIN_REPEAT_WORDS = 3;

/**
 * Pure: the first rule the reply breaks, or null if it may be sent. `earlierReplies` are the account's messages already
 * in the chat. Long replies are compared with all available earlier replies. Short replies to an identity question
 * are compared with the most recent reply.
 */
export function blockedRule(
  reply: string, earlierReplies: readonly string[] = [], latestContactText = '', expectedArabic?: boolean,
  skipWordingChecks = false, paymentInstructions: PaymentInstructionPolicy = 'guarded',
): ReplyGuardRule | null {
  const text = normalise(reply);
  for (const [rule, pattern] of RULES) {
    if (rule === 'payment_instructions' && paymentInstructions === 'prompt') continue;
    if (pattern.test(text)) return rule;
  }
  if (paymentInstructions === 'guarded' && includesPrivateTransferData(text)) return 'payment_instructions';
  if (isSellerOrDisclosureClaim(text) || PRICE_QUOTE.test(sellerText(text).trim())) return 'seller_disclosure';
  if (mentionsProjectName(text)) return 'unsolicited_brand';
  if (claimsUnverifiedPlace(text, latestContactText)) return 'unverified_location';
  if (asksForLookupIdentifier(text)) return 'lookup_request';
  if (skipWordingChecks) return null;
  if (withoutAssistantIntroduction(text).trim().split(/\s+/u).length > 55) return 'too_verbose';
  const identityQuestion = isIdentityCheck(latestContactText);
  if (identityQuestion) {
    const arabic = /\p{Script=Arabic}/u;
    const latin = /\p{Script=Latin}/u;
    const expected = (expectedArabic ?? arabic.test(latestContactText)) ? arabic : latin;
    if (/\p{L}/u.test(text) && !expected.test(text)) return 'identity_language';
  }
  const words = wordsOf(withoutAssistantIntroduction(reply));
  if (words.split(' ').length < MIN_REPEAT_WORDS) {
    const lastReply = earlierReplies.at(-1);
    return lastReply !== undefined && identityQuestion && wordsOf(withoutAssistantIntroduction(lastReply)) === words
      ? 'repeat' : null;
  }
  return earlierReplies.some((earlier) => wordsOf(withoutAssistantIntroduction(earlier)) === words) ? 'repeat' : null;
}

// Common currency names and their written symbols in English and Arabic.
const CURRENCIES = [
  /\$|\b(?:USD|dollars?)\b|دولار/iu, /€|\b(?:EUR|euros?)\b|يورو/iu,
  /£|\b(?:GBP|pounds? sterling)\b|إسترليني|استرليني/iu,
  /\b(?:AED|dirhams?)\b|دراهم|درهم|د\.إ/iu, /\b(?:SAR|riyals?)\b|ريال/iu,
];

/** A clarification can be a casual fragment with no question mark. */
function asksFeePurpose(text: string): boolean {
  if (/\byou (?:have|need) to pay\b|(?:لازم|يجب ان|يجب أن) تدفع/iu.test(text)) return false;
  return /\b(?:why|what.{0,55}(?:for|cover|include|fee|charge|purpose|towards?)|(?:explain|clarify|break down).{0,40}(?:fee|charge|cost))\b|(?:ليش|ليه|لماذا|وش|شنو|شو|[إا]يش|ايه|إيه|مقابل (?:اي|أي|إيه|ايش|ماذا)|(?:سبب|غرض|هدف|فايدة) (?:هذي |هذه )?(?:الرسوم|المبلغ)|ممكن توضح)/iu.test(text);
}

/** Apply the same send-time checks to a generated worker reply and to an offline replay. */
export function blockedRuleForTurn(
  reply: string, history: readonly ReplyTurn[], currentTurn: readonly string[], memory?: ReplyOfferMemory,
  skipWordingChecks = false, paymentInstructions: PaymentInstructionPolicy = 'guarded',
): ReplyGuardRule | null {
  const earlierReplies = history.filter(turn => turn.from === 'owner').map(turn => turn.text);
  const rule = blockedRule(reply, earlierReplies, currentTurn.at(-1) ?? '', isArabicReplyTurn(history, currentTurn), skipWordingChecks, paymentInstructions);
  if (rule) return rule;
  if (currentTurn.some(asksAliName) && !/(?<!\p{L})(?:ali|علي)(?!\p{L})/u.test(sellerText(reply))) return 'seller_disclosure';
  if (answersAsSeller(reply, history, currentTurn)) return 'seller_disclosure';
  const offer = offerGuardContext(history, currentTurn);
  if (!skipWordingChecks && offer === 'work_fee' && !asksFeePurpose(reply)) return 'fee_purpose_question';
  if (offer !== 'acknowledgment') return null;
  if (/(?:^|[,.!،]\s*)(?:i (?:agree to that|accept(?: the offer)?)|(?:it’s |it's )?a deal|موافق[ةه]?|اتفقنا)(?=[\s.!،,]|$)/iu.test(reply)) return 'external_action';
  if (!skipWordingChecks && /[?؟]/u.test(reply)) return 'unneeded_offer_question';
  for (const currency of CURRENCIES) {
    if (currency.test(reply) && !history.some(turn => turn.from === 'contact' && currency.test(turn.text))) return 'unstated_currency';
  }
  return null;
}
