/** Transcript classification used by offer memory, local language routing and the outgoing guard. */
import type { ReplyTurn } from './reply-generator.ts';

const IDENTITY_EN = /^(?:are (?:you|u)|r u|u|is this|you(?:'re| are)?|am i (?:talking|speaking|chatting) (?:to|with))\s+(?:(?:a|an)\s+)?(?:(?:real|actual)\s+)?(?:ai(?: assistant)?|automated(?: assistant)?|bot|chatbot|robot|human|person|artificial intelligence)(?:\s+or\s+(?:(?:a|an)\s+)?(?:real\s+)?(?:human|person|bot|robot|ai|not))?(?:\s+(?:right|aren'?t you))?$/u;
const IDENTITY_KIND_AR = '(?:بوت|روبوت|انسان|بشري?|الي|شخص حقيقي|ذكاء (?:ا?صطناعي|صناعي)|مساعد الي|ترد (?:علي )?(?:بشكل )?الي(?:ا)?)';
const IDENTITY_AR = new RegExp(`^(?:هل )?انتي?(?: (?:فعلا|صدق))? ${IDENTITY_KIND_AR}(?: (?:او|ولا) ${IDENTITY_KIND_AR})?(?: صح)?$`, 'u');
const SHORT_IDENTITY_QUESTION = /^(?:ai|bot|chatbot|robot|human|بوت|روبوت|بشري|انسان)$/u;
const WHO_IS_REPLYING = /^(?:who(?: is|'s) this|who are you|who am i (?:messaging|(?:talking|speaking|chatting) (?:to|with))|(?:مين|من) (?:معي|معاي|انت))$/u;

function shortWords(message: string): string {
  return message.normalize('NFKC').toLowerCase().replace(/[‘’]/gu, "'")
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '').replace(/[أإآ]/gu, 'ا')
    .trim().replace(/[\s!?؟.,،…👋🏻🏼🏽🏾🏿]+$/u, '').replace(/[,،]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function isIdentityCheck(message: string): boolean {
  const words = shortWords(message);
  return WHO_IS_REPLYING.test(words) || IDENTITY_EN.test(words) || IDENTITY_AR.test(words)
    || (/[?؟]/u.test(message) && SHORT_IDENTITY_QUESTION.test(words));
}

function consumerClauses(text: string): string[] {
  const unquoted = text.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|(?<!\p{L})['‘][^'’\n]*['’](?!\p{L})/gu, '');
  return unquoted.split(/[.?!؟،,;؛\n]|\s+and\s+|\s+و(?=شو|وش|شنو|[اأإ]يش|اسمك|كم |بكم |وين |هل |كيف|عطني|متى|ليش|منو|من |[اأإ]نت (?:بوت|روبوت|[ااإ]نسان|مساعد|بشر))/iu)
    .map(clause => shortWords(clause).replace(/^(?:(?:and|so|okay|ok|now|please|الحين|لو سمحت|ممكن|اوكي|زين|انزين|هيه|نعم|ايه|اي|ايوه|تمام|طيب|عيل|يلا) )+/u, '')).filter(Boolean);
}

function isNameClause(words: string): boolean {
  return /^(?:what(?:'s| is) your (?:(?:first|real|full|actual) )?name|what (?:should|can) i call you|(?:tell|give) me your name|your name)(?: (?:please|again))?$/u.test(words)
    || /^(?:(?:شو|وش|شنو|ايش|ما) (?:هو )?اسمك|اسمك(?: (?:شو|ايه))?|(?:قول لي|قولي|عطني) اسمك|(?:شو|كيف) اناديك)(?: (?:بالضبط|الكامل|لو سمحت))?$/u.test(words);
}

/** Identify a direct question about this assistant's name, even beside another question. */
export function asksAliName(text: string): boolean {
  return consumerClauses(text).some(isNameClause);
}

function clauses(text: string): string[] {
  return text.match(/[^.!?؟\n]+[.!?؟]*/gu)?.map(part => part.trim()).filter(Boolean) ?? [];
}

function predominantlyArabic(text: string): boolean {
  if (!/\p{Script=Arabic}/u.test(text)) return false;
  const words = text.match(/\p{L}[\p{L}\p{M}]*/gu) ?? [];
  const arabicWords = words.filter(word => /\p{Script=Arabic}/u.test(word)).length;
  if (!arabicWords) return false;
  if (arabicWords === words.length) return true;
  // English questions can quote long Arabic names; Arabic questions can start with a Latin brand.
  if (/^(?:what|where|when|which|why|how|does|did|do|is|are|can|could|would|should)\b/i.test(words[0]!)) return false;
  if (text.trimEnd().endsWith('؟') && /\p{Script=Arabic}/u.test(words.at(-1)!)) return true;
  const otherWords = words.length - arabicWords;
  return arabicWords > otherWords || (arabicWords === otherWords && (/\p{Script=Arabic}/u.test(words[0]!) || text.includes('؟')));
}

const REPLY_LANGUAGE_EN = /^(?:(?:(?:can|could|would) you (?:please )?|please )?(?:reply|respond|answer)(?: to me)? in (?:english|arabic)(?: please)?|(?:english|arabic) please)$/u;
const REPLY_LANGUAGE_AR = /^(?:(?:لو سمحت |من فضلك |ممكن |الرجاء )?(?:رد|ترد|جاوب|تجاوب|الرد)(?: علي)? )?(?:بالعربي[ةه]?|بالانجليزي[ةه]?|باللغ[ةه] (?:العربي[ةه]|الانجليزي[ةه]))(?: لو سمحت| من فضلك)?$/u;

function requestedReplyLanguage(text: string): 'ar' | 'en' | undefined {
  for (const clause of clauses(text).reverse()) {
    const words = shortWords(clause).replace(/^(?:هلا|مرحبا|السلام عليكم|hi|hello|hey) /u, '');
    if (REPLY_LANGUAGE_EN.test(words) || REPLY_LANGUAGE_AR.test(words)) {
      return /arabic|عرب/u.test(words) ? 'ar' : 'en';
    }
  }
}

function latestBurst(history: readonly ReplyTurn[]): string[] {
  return history.slice(history.findLastIndex(turn => turn.from === 'owner') + 1).map(turn => turn.text);
}

/** Follow a direct language request in this burst. Digits and emoji inherit the contact's latest language. */
function replyLanguage(history: readonly ReplyTurn[], active: readonly string[]): 'ar' | 'en' | undefined {
  for (let i = active.length - 1; i >= 0; i--) {
    const requested = requestedReplyLanguage(active[i]!);
    if (requested) return requested;
  }
  const hasWords = (text: string) => /\p{L}/u.test(text);
  const latest = active.findLast(hasWords);
  if (latest) return predominantlyArabic(latest) ? 'ar' : undefined;
  const previous = history.findLast(turn => turn.from === 'contact' && hasWords(turn.text))?.text ?? '';
  return requestedReplyLanguage(previous) ?? (predominantlyArabic(previous) ? 'ar' : undefined);
}

export function isArabicReplyTurn(history: readonly ReplyTurn[], currentTurn?: readonly string[]): boolean {
  return replyLanguage(history, currentTurn ?? latestBurst(history)) === 'ar';
}
const REPORT_OR_NEGATION = /(?:^| )(?:قال(?:ت|وا| لي)?|سال(?:ت|ني|ته)?|لا تقول|ما (?:تبا|تبغي|قلت)|said|asked|wrote)(?: |$)/u;
const DIRECT_OFFER = /^(?:(?:hi|hey|anyway|by the way)[\s!,]+)?(?:selling (?!(?:is|was|can|could|seems?|has|takes?)\b)|i(?:'m| am) selling\b|i listed\b|i sell\b|i(?:'m| am) offering (?!to |my condolences|my help)|i offer (?!to |my condolences|my help)|(?:would you like|do you want) to (?:buy|rent|hire|order)\b|(?:would you be interested in|are you interested in|i(?:'ve| have) got|i have) .{1,100}\b(?:for (?:sale|rent)|to sell|if you(?:'re| are) interested|service|lessons?|sessions?)\b|(?:ابيع|اقدم|نقدم|اعرض) (?!لك الشكر|شكري|التعازي|المساعدة)|(?:عندي|عندنا) عرض(?: |$)|(?:عندي|عندنا) .{1,80}(?:للبيع|للايجار|حاب (?:تعرف|تسمع) عن(?:ه|ها)))/iu;
const WORK_OFFER = /^(?:(?:would you be interested in|are you interested in|would you like|do you want) (?:a |an |some )?(?:(?:weekend|paid|part[- ]time|full[- ]time|evening|extra|temporary) )*(?:job|work|shift|position|role)\b|(?:i|we) (?:have|can offer you) (?:a |an |some )?(?:(?:weekend|paid|part[- ]time|full[- ]time|evening|extra|temporary) )*(?:work|shifts?|jobs?|job opportunit(?:y|ies)|openings?|positions?) (?:available|for you|if you)\b|(?:i(?:'m| am)|we(?:'re| are)) (?:offering (?:you )?(?:a |an )?(?:job|shift|position|role)|hiring (?:for|a))\b|(?:عندي|عندنا|لدي|لدينا) (?:(?:لك |لكم )(?:فرصة عمل|وظيفة|شغل|عمل)|(?:فرصة (?:عمل|شغل)|عرض (?:عمل|شغل)|وظيفة|شغل|وردية|شفت)(?: متاح| شاغر| لك|.{0,48}(?:مهتم|اذا يناسبك|اذا تبي)))|هل (?:انت )?مهتم (?:بوظيفة|بشغل)|(?:تبي|تبغي|تبغى|تحب) (?:شغل|وظيفة|تشتغل))/iu;
const INTEREST_CHECK = /^(?:are you interested|interested|would you be interested|مهتم|هل انت مهتم|يناسبك)$/iu;
const WORK_QUESTION = /\b(?:duties|tasks?|hours?|involve|what kind of (?:work|job)|what (?:is|'s) the (?:work|job))\b|طبيعة|مهام|ساعات|نوع (?:الشغل|العمل|الوظيفة)|وش (?:الشغل|العمل)/iu;
const WORK_ANSWER = /\b(?:the (?:job|shift|work)|your (?:job|shift|duties)|tasks? include|(?:from|between) \d|you(?:'d|'ll| will| would) (?:be |need to |help )|\d+\s*(?:hours?|am|pm))\b|^(?:[a-z]+ing|you(?:'d|'ll| will| would))\s|المطلوب|الشغل|المهام|من الساعة|من \p{N}|الدوام/iu;
const WITHDRAWN_OFFER = /\b(?:never ?mind|no longer|already sold|it sold|sold it|not available|stop|forget (?:it|that)|withdrawn)\b|خلاص|انباع|انبع|الغيت|وقف المراسلة|لا تراسلني/iu;
const FEE_REQUEST = /\b(?:fees?|deposit|surcharge|(?:extra|another|additional|separate) (?:amount|charge|payment))\b|\byou (?:need to|have to|must) pay\b|\b(?:pay|send|transfer)\s+(?:me |us )?(?:[£$€]|\d|an? extra\b|another\b)|رسوم|عربون|(?:لازم|مطلوب) (?:تدفع|تحول)|ادفع|حول (?:لي|لنا)|مبلغ (?:ا?ضافي|منفصل|زيادة)/iu;
const EXTRA_AMOUNT = /\b(?:extra|another)\s+\d+(?:\.\d+)?(?=\s*(?:$|[.,;!?]|to (?:the )?total|on top|before\b|first\b|more\b))|\p{N}+\s*(?:زيادة|ا?ضافي)|(?:زيادة|ا?ضافي)\s*\p{N}+/iu;
const PRICE_CONTEXT = /\b(?:price|quote[ds]?|total|costs?|charge[ds]?|deposit|budget|payment|fees?)\b|سعر|تكلفة|مبلغ|رسوم|المجموع/iu;
const NEW_CONDITION = /\b(?:another|extra|additional|separate|new|before|first|must|need to|have to)\b|جديد|زيادة|اضافي|منفصل|قبل|لازم|مطلوب/iu;
const DIRECT_DEMAND = /\byou (?:need to|have to|must) (?:pay|send)|\b(?:please )?add (?:another|an extra)\b|(?:لازم|مطلوب) (?:تدفع|تحول)|ادفع|حول (?:لي|لنا)/iu;
const REPORTED_CHARGE = /\b(?:i|we) (?:paid|was charged|were charged|had to pay)|\b(?:they|someone|she|he|the seller|the shop|the company|the courier) (?:asked|charged|wants?|told)|\b(?:asked|asks|told) me to pay\b|طلب(?:وا)? مني|خصموا مني|انا دفعت/iu;
const OFFER_TERMS = /\b(?:costs?|priced at|minutes?|hours?|cm|inches|wide|long|tall)\b|سعر|ساعة|دقيق[ةه]|دقائق|سم|سنتيمتر|درهم/iu;
const WANT_AR = '(?:ب?تب(?:ا+|ى|ي|ين|ون|غي|غى|غا)|تريد(?:ين|ون)?|تود|ودك|ودج|تحب|حاب)';
const BUY_INVITATION = new RegExp("^(?:(?:want to|wanna) (?:buy|rent)\\b|" + WANT_AR + " (?:تشتري(?:ن|ه|ها)?|تشترون|تاجر)(?: |$))", 'u');
function isDirectOffer(words: string, raw = ''): boolean {
  return DIRECT_OFFER.test(words.replace(/^(?:انا|نحن) /u, '')) || BUY_INVITATION.test(words)
    || (/^ب?تشتري(?:ه|ها|ن)?(?: |$)/u.test(words)
      && (/[?؟]/u.test(raw) || !/(?:^| )(?:من|عشان|عبر|لازم|اول|ثم|بعد|كل|بالعادة|عادة|دوم)(?: |$)/u.test(words)));
}

/** Recognize source statements worth recovering when the corresponding messages leave recent history.
 * Only direct offers and explicit corrections qualify. A withdrawal ends the remembered offer.
 */
export function* contactOfferEvents(text: string): Iterable<{ kind: 'offer' | 'correction' | 'withdrawal'; excerpt: string }> {
  const unquoted = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»|(?<!\p{L})['‘][^'’]*['’](?!\p{L})/gu, ' ');
  const sentences = unquoted.match(/[^.?!؟;؛\n]+[.?!؟]?/gu) ?? [];
  for (const sentence of sentences.reverse()) {
    const excerpt = sentence.trim();
    const words = shortWords(excerpt);
    if (/^(?:(?:actually|sorry|update|خلاص|ترى)[,، ]+)?(?:i(?:'ve| have)? (?:already )?sold (?:it|the \p{L}+)|(?:it(?:'s| is)? |the .{1,45} (?:is|has been) )?(?:already sold|sold(?: out)?|no longer (?:available|for sale))|never ?mind(?: about)? (?:the|my) offer|i withdraw (?:the|my) offer|انباع(?:ت)?|انبا?عت|بعت(?:ه(?:ا)?| ال\p{L}+)|الغيت (?:البيع|العرض)|(?:مب|مش|ما عاد) للبيع)(?:\s|$)/u.test(words)) {
      yield { kind: 'withdrawal', excerpt };
      continue;
    }
    const roleChange = /\b(?:pretend|ignore|instructions?|you(?:'re| are) (?:now )?(?:selling|(?:the |my )?(?:seller|owner))|buy(?:ing)? .{0,18}from you)\b|(?:تجاهل|تعليمات|تظاهر|انت (?:تبيع|اللي تبيع|(?:ال)?(?:بايع|بائع|بياع))|(?:ا?شتري|بشتري)(?:ه|ها)? منك)/u;
    if (roleChange.test(words) || REPORT_OR_NEGATION.test(words) || /[«»“”"]/u.test(excerpt)) continue;
    const kind = isDirectOffer(words, excerpt) || WORK_OFFER.test(words) ? 'offer'
      : /^(?:correction\b|(?:sorry |actually )?i meant\b|my mistake\b|actually (?:it(?:'s| is)|the)\b|(?:تصحيح|اقصد|قصدي|غلطت)(?:[ :،]|$))/u.test(words) ? 'correction' : undefined;
    // A saved correction concerns the sender’s offer. A second-person instruction or a change to
    // either speaker’s identity must never displace a correction that came from the seller.
    if (kind === 'correction' && /\b(?:you|your|yours|my name|i(?:'m| am) (?:the |a )?(?:buyer|customer|buying))\b|(?:^|[\s:])(?:انت|انته|انتي|اسمك|اسمي|عندك|بضاعتك|سلعتك|محلك|سعرك|شغلك|انا (?:المشتري|الزبون|بشتري))(?:\s|$)/u.test(words)) continue;
    if (kind) yield { kind, excerpt: excerpt.slice(0, 300).replace(/[\uD800-\uDBFF]$/u, '') };
  }
}

const TOPIC_CHANGE = /^(?:different (?:thing|topic)|on another note|by the way|btw|بالمناسبة|موضوع (?:ثاني|جديد))[\s,:!]+/iu;
const WHOLE_OFFER = /\b(?:the (?:whole|entire|complete) offer|that(?:'s| is) (?:all|everything)|nothing else to add)\b|هذا كل (?:شي|التفاصيل)|هذي كل التفاصيل/iu;
const PRICE_DETAIL = /\b(?:total|priced at|new in (?:the|its) box)\b|التكلفة|المجموع|بالكامل/iu;
const OFFER_INVITATION = /\b(?:if you(?:'re| are) interested|want to hear (?:more|about it)|would you like (?:a|an|some) free sample)\b|(?:حاب|تحب) (?:تعرف|تسمع) عن(?:ه|ها)|متاح للطلب/iu;
const CORRECTION = /\b(?:mixed .{0,14}up|got .{0,16}mixed up|my mistake|i meant|correction|correct(?:ing)? myself)\b|اقصد|تصحيح|غلطت|لخبطت/iu;
const FACT_ANSWER = /^(?:yes|yep|yeah|correct|no[, ]|it (?:is|has|does|comes)|it'?s |they (?:are|have|come)|just (?:the|a)|only (?:the|a)|مدته|فيه|فيها|ايه|نعم|لا |هو |هي )/iu;
const WORK_CONTEXT = /\b(?:freelance|hiring|assignment|onboarding|first shift|paid work|job opportunity)\b|توظيف|وظيفة|اول وردية|فرصة عمل/iu;
const EMPLOYMENT_LANGUAGE = /\b(?:shifts?|assignments?|hiring|employ(?:ment|er|ee)|hourly|salary|wages?|first pay|before (?:you|we) (?:can )?start|paid per|pays? per|per (?:hour|page)|we (?:need|want|are looking for) (?:an? |someone))\b|(?:^| )(?:(?:ندور|نحتاج|نبي|محتاجين) (?:احد|حد|شخص)|(?:عندنا|نبغي|عندي) شغل|بالساعة|راتب|اجر|اول يوم|دوام|وردي[ةه])/iu;
const WORK_CHARGE = /\b(?:fee|charge|deposit|deduction)\b|\b(?:send|pay|transfer)\s+(?:(?:us|me)\s+)?(?:[$€£]?\d|an? |the |first)|رسوم|عربون|(?:عليك|مطلوب منك) مبلغ|ادفع/iu;
const EMPLOYER_COVERS = /\b(?:we (?:pay|cover|reimburse)|(?:no|without) (?:charge|cost|payment) (?:to|from|for) you|you (?:get|are) paid|\d+\s+(?:an|per) hour|(?:dropped|waived|removed|withdrawn) (?:that|the|this) (?:condition|requirement))\b|(?:علينا|نغطي|نتكفل|ندفع لك|ما عليك (?:رسوم|مبلغ)|ما تحتاج تدفع|بالساعة)/iu;
const REQUIRED_PURCHASE = /\byou (?:must |have to |need to )?(?:buy|purchase) (?:an?|the|your|our) \p{L}|(?:تشتري|تاخذ) (?:منا )?(?:ال)?\p{L}{2,}/iu;
const REPAYMENT = /\b(?:refund(?:able|ed)?|reimburs\w*|(?:money|deposit|fee) back)\b|(?:قابلة? للاسترداد|بنرجع|نرجع لك|ترجع لك)/iu;
const THIRD_PARTY_WORK = /\b(?:my|our) (?:friend|colleague|roommate|neighbor|neighbour|relative|partner|sister|brother)\b|(?:زميلي|صديقي|اختي|اخوي|رفيقي)/iu;
const NAMED_ADDON = /\b(?:[a-z][\w -]{0,20}) (?:costs?|is priced at) \p{N}|\b(?:the )?\p{N}+(?:\.\p{N}+)? (?:is |was )?(?:only )?for\b|\b(?:extra|another) \p{N}+(?:\.\p{N}+)? for\b|\b(?:fee|charge|deposit) (?:covers|includes|is for)\b|(?:نضيف|تدفع|مبلغ|رسوم|الـ?)?\s*\p{N}+\s*(?:(?:درهم|ريال|دينار|جنيه)\s+)?(?:لخدمة|مقابل|للفحص|للتغليف|للتنظيف)/iu;
const OPTIONAL_FEE = /\b(?:only if (?:you want|you choose)|just a reminder|only for the (?:printed|premium|extra|optional))\b|فقط (?:اذا|لو)|للتذكير|اختياري/iu;
const FEE_PURPOSE_QUESTION = /\b(?:why|what (?:is|'s)|what (?:does|would|will)|what.{0,45}(?:for|cover))\b|ليش|لماذا|لشو|وش.{0,22}(?:سبب|يشمل|الرسوم)/iu;
const PURPOSE_EXPLANATION = /^(?:(?:that|it)(?:'s| is) )?for (?:a |an |the |your |our )?\p{L}|(?:^|[.!][\s]*)(?:it|that|this|the (?:charge|fee)) (?:is for|covers?|pays for)\b|(?:fee|charge|payment) (?:is |goes )?for (?!you\b|them\b|us\b|me\b|starting\b|now\b)|(?:هذي |هاذي |هذه |هذا |هو |هي )?(?:عشان|علشان|مقابل|لتغطية|بسبب|^لل\p{L}{2,})|(?:الرسوم|المبلغ|الدفعة) (?:عشان|مقابل|لـ?|يشمل|تغطي)/iu;
const CONCRETE_WORK_EXPENSE = /\b(?:badge|uniform|travel|transport|postage|materials?) (?:fee|charge|cost)\b|(?:رسوم|تكلفة) (?:البطاقة|الزي|المواصلات|النقل|المواد)/iu;
const CANCELLED_CHARGE = /\b(?:waived|removed|cancelled|canceled|no extra (?:fee|charge))\b|الغينا|الغيت|بدون رسوم|ما فيه مبلغ اضافي/iu;

/** These labels only validate an outgoing draft. They never select or add model instructions. */
export function offerGuardContext(history: readonly ReplyTurn[], active: readonly string[]): 'acknowledgment' | 'work_fee' | undefined {
  const text = active.at(-1)?.trim();
  if (!text || history.at(-1)?.from !== 'contact') return;
  const offer = shortWords(text).replace(TOPIC_CHANGE, '');
  const prior = history.slice(0, -1);
  const recentContacts = prior.slice(-8).filter(turn => turn.from === 'contact').map(turn => shortWords(turn.text));
  const pivot = recentContacts.findLastIndex(words => TOPIC_CHANGE.test(words) || WITHDRAWN_OFFER.test(words) || REPORTED_CHARGE.test(words));
  const earlierContacts = recentContacts.slice(Math.max(0, pivot)).map(words => words.replace(TOPIC_CHANGE, ''));
  const previousContact = earlierContacts.at(-1) ?? '';
  const previousWork = WORK_OFFER.test(previousContact);
  const previousQuestion = prior.at(-1);
  const asked = previousQuestion?.from === 'owner' && /[?؟]/u.test(previousQuestion.text);
  const priorOffer = isDirectOffer(previousContact) || OFFER_INVITATION.test(previousContact) || previousWork;
  if (REPORTED_CHARGE.test(offer) || THIRD_PARTY_WORK.test(offer)) return;
  const mixed = active.some(part => /[?؟]|\b(?:please (?:tell|explain|confirm)|can you|could you|would you)\b|ممكن توضح|اشرح لي/iu.test(part));
  const acknowledgment = mixed ? undefined : 'acknowledgment';

  const latestContext = earlierContacts.findLast(words =>
    isDirectOffer(words) || OFFER_INVITATION.test(words) || WORK_OFFER.test(words) || WORK_CONTEXT.test(words)
    || EMPLOYMENT_LANGUAGE.test(words) || WITHDRAWN_OFFER.test(words) || THIRD_PARTY_WORK.test(words));
  const priorEmployment = latestContext && !WITHDRAWN_OFFER.test(latestContext) && !THIRD_PARTY_WORK.test(latestContext)
    && (WORK_OFFER.test(latestContext) || WORK_CONTEXT.test(latestContext) || EMPLOYMENT_LANGUAGE.test(latestContext));
  const currentEmployment = WORK_OFFER.test(offer) || WORK_CONTEXT.test(offer)
    || !FEE_REQUEST.test(offer) && EMPLOYMENT_LANGUAGE.test(offer);
  const expensesAnswered = EMPLOYER_COVERS.test(offer) && (asked && /\b(?:expenses?|costs?|charges?|hours?|duties)\b|رسوم|ساعات|المصاريف/iu.test(previousQuestion.text)
    || /\b(?:your (?:hours?|work|travel|expenses?)|per hour|an hour)\b|ندفع لك|بالساعة/iu.test(offer));
  const employment = priorEmployment || currentEmployment || expensesAnswered;
  const chargesWorker = employment && WORK_CHARGE.test(offer) && !/\b(?:no|without) (?:charge|fee|deposit)|ما (?:في|فيه|عليك) رسوم/iu.test(offer);
  const fee = FEE_REQUEST.test(offer) || chargesWorker;
  const recipientPays = DIRECT_DEMAND.test(offer) || /\b(?:you (?:buy|pay)|send (?:us|me)|charge for you)|عليك رسوم|لازم (?:تشتري|تدفع)/iu.test(offer);
  const answeringFeeQuestion = asked && FEE_PURPOSE_QUESTION.test(previousQuestion.text)
    && earlierContacts.slice(-2).some(words => FEE_REQUEST.test(words) || EXTRA_AMOUNT.test(words));
  const pressure = /(?:pay|send|transfer)\b.{0,65}\b(?:explain|tell you|give you the reason)|(?:ادفع|حول|تدفع).{0,40}(?:اشرح|اوضح|اقول)/iu.test(offer);
  const explained = NAMED_ADDON.test(offer) || OPTIONAL_FEE.test(offer) && /\p{N}/u.test(offer)
    || PURPOSE_EXPLANATION.test(offer) && (fee || answeringFeeQuestion || FEE_REQUEST.test(previousContact) || WORK_CHARGE.test(previousContact))
    || fee && CONCRETE_WORK_EXPENSE.test(offer)
    || employment && (REQUIRED_PURCHASE.test(offer) || REPAYMENT.test(offer));

  if (answeringFeeQuestion && !explained && (pressure || chargesWorker)) return acknowledgment;
  const priorPrice = prior.slice(-6).some(turn => PRICE_CONTEXT.test(shortWords(turn.text))) || priorOffer;
  if (employment && EMPLOYER_COVERS.test(offer) && !recipientPays && !explained) return acknowledgment;
  if (CANCELLED_CHARGE.test(offer) && (fee || priorPrice)) return acknowledgment;
  if (WITHDRAWN_OFFER.test(offer)) return;
  if (explained || ((fee || EXTRA_AMOUNT.test(offer)) && (priorPrice || chargesWorker || fee && NEW_CONDITION.test(offer) || PRICE_CONTEXT.test(offer) && EXTRA_AMOUNT.test(offer)))) {
    if (explained) return acknowledgment;
    if (employment) {
      return 'work_fee';
    }
    return;
  }
  if (WHOLE_OFFER.test(offer) && (priorOffer || asked || PRICE_DETAIL.test(offer) || OFFER_TERMS.test(offer))) {
    return acknowledgment;
  }
  const workInvitation = currentEmployment && /\b(?:interested|want to hear|would you like)\b|حاب (?:تسمع|تعرف)|مهتم|يناسبك/iu.test(offer);
  const adjacentWork = previousWork || WORK_CONTEXT.test(previousContact) || EMPLOYMENT_LANGUAGE.test(previousContact);
  const work = WORK_OFFER.test(offer) || workInvitation || adjacentWork && INTEREST_CHECK.test(offer);
  const direct = isDirectOffer(offer, text) || OFFER_INVITATION.test(offer) && !/["“«]/u.test(offer);
  if (work || direct) return;
  if (priorEmployment && asked && !mixed && /\b(?:per|an) hour|من.{1,28}(?:لين|الى)|الساعة ب|ساعات?/.test(offer)) {
    return acknowledgment;
  }
  if (asked && (priorOffer || WORK_CONTEXT.test(previousContact)) && !/[?؟]/u.test(text)) {
    if (CORRECTION.test(offer) || FACT_ANSWER.test(offer)
      || previousWork && WORK_QUESTION.test(previousQuestion.text) && WORK_ANSWER.test(offer)) return acknowledgment;
  }
}

export function isOfferAcknowledgmentTurn(history: readonly ReplyTurn[], active: readonly string[] = latestBurst(history)): boolean {
  return offerGuardContext(history, active) === 'acknowledgment';
}

export function isUnexplainedWorkFeeTurn(history: readonly ReplyTurn[], active: readonly string[] = latestBurst(history)): boolean {
  return offerGuardContext(history, active) === 'work_fee';
}
