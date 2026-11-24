/** Recognize a supported pickup arrangement without treating a contact's tone as evidence. The return
 * value contains only the original source identifiers. It is never a finding about a person. */
export interface MeetingSource { messageId: string; messageEventId: string }
export interface MeetingTurn extends MeetingSource { direction: 'incoming' | 'outgoing'; text: string; at: number }
export interface MeetingEvidence { agreement: MeetingSource; time: MeetingSource; place: MeetingSource; date?: MeetingSource }

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[’']/gu, '').replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[إأآ]/gu, 'ا').replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x660))
    .replace(/\s+/gu, ' ').trim();
}

const MEET = /\b(?:meet(?:up|ing)?|in person|face[- ]to[- ]face|pick(?:ing)? (?:it |them |this |that )?up|pick[- ]?up|collect (?:it|them|in person))\b|نتلاق[ىي]|نلتقي|نتقابل|اقابلك|استلم(?:ه|ها)? بنفسي|استلام (?:شخصي|يد بيد)|و?يه[ا ] لويه/u;
const VISIT = /\b(?:come(?: (?:by|over|there|down|round|around|in))?|stop by|drop (?:in|by)|visit)(?: (?:to|and))? (?:see|inspect|view|check(?: out)?|(?:take |have )?a look at|look at|try) (?:it|them|this|that|the (?:item|product))\b|(?:امر|امرك|اييك|ايي|اجي|ازورك)(?: عليك| عندك| لك)? (?:و?اشوف(?:ه|ها|هم)|و?اعاين(?:ه|ها)|و?اجرب(?:ه|ها))/u;
function proposesMeeting(words: string): boolean {
  return (MEET.test(words) || VISIT.test(words)) && !/\b(?:had|have|has|attend|attended|scheduled for) (?:a|another|his|her|my|their) meeting\b|\bpick[- ]?up (?:fees?|costs?|charges?|policy|rates?)\b/u.test(words);
}
const ACCEPT = /^(?:yes|ye[ap]h?|yup|sure|ok(?:ay)?|sounds good|agreed|absolutely|perfect|fine|no problem|of course|that works|works for me|ill be there|i can (?:meet|come)|see you|اي(?:ه|وا|وه)?|هيه|نعم|اكيد|تمام|موافق|زين|ممتاز|يناسبني|ما عندي مانع|ان شاء الله)(?=$|[\s,.!،])/u;
const WHERE = /\b(?:where|which (?:location|place|area|entrance|branch)|what(?:s| is)? (?:the |your )?(?:location|address|meeting point)|what place)\b|وين|اين|اي (?:مكان|منطقة|مدخل)|شو (?:المكان|العنوان)/u;
const WHEN = /\b(?:what time|which time|when|what hour)\b|اي ساع[هة]|متى|الساع[هة] كم|كم الساع[هة]/u;
const CLOCK = /(?:^|[^\p{L}\p{N}])(?:(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:[ap]\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midnight)(?![\p{L}\p{N}])|(?:الساع[هة]\s*(?:[01]?\d|2[0-3]|وحد[هة]|ثنتين|ثلاث|اربع|خمس|ست|سبع|ثمان|تسع|عشر)(?:[هة])?)(?![\p{L}\p{N}])/u;
const DAY = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{4}-\d\d-\d\d\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|(?:^|\s)(?:باجر|باكر|بكرة|بكرا|غدا|اليوم|الليلة|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|السبت)(?=$|[\s،,.])/u;
const VENUE = /\b(?:station|entrance|mall|plaza|gate|street|road|avenue|car park|parking lot|library|market|cafe|lobby|office|store|shop|restaurant|building|tower|park|museum|metro|supermarket|hotel|mosque|square|reception)\b|محط[هة]|بواب[هة]|مدخل|شارع|موقف|السوق|المول|مقه[ىي]|مكتب|مسجد|مطعم|مبن[ىي]|حديق[هة]|دوار/u;
const NONANSWER = /\b(?:maybe|perhaps|somewhere|anywhere|whatever|later|not sure|unsure|dont know|do not know|ask me|wherever|tell you|your (?:place|address)|ill (?:send|share)|to be decided|tbd|location|some place)\b|بعدين|ما ادري|مادري|اي مكان|ما اعرف|بخبرك|بارسل|برسل/u;
const CANCEL = /\b(?:cant|cannot|wont|unable|cancel\w*|instead|reschedul\w*|postpon\w*|changed|different (?:time|place|day)|not (?:at|on|there|available|today|tomorrow|\d)|no longer|not meeting|refus\w*|maybe|not sure)\b|^(?:no|nope)\b|ما (?:اقدر|بقدر|ينفع|ابا|باجي)|مش ممكن|نغير|الغ(?:ي|اء)|مب (?:هناك|اليوم)|يمكن بعدين/u;
const CONDITION = /\b(?:only if|unless|if you|not (?:meet|come|possible)|but|either|or|shipping only|only (?:do |offer )?(?:shipping|delivery)|no (?:pickup|collection)|book online|order online|send (?:me |us )?(?:the |some )?money|wire (?:me |us )?funds)\b|(?:^|\s)(?:بس بشرط|اذا|او|لكن|توصيل فقط|فقط توصيل)(?:\s|$)/u;
const RISK = /\b(?:deposit|upfront|advance (?:payment|fee)|pay(?:ment)? (?:first|now|before|in advance|link)|transfer|wire money|gift card|crypto|verification code|one[- ]time (?:password|code)|otp|pass(?:word|code)|card (?:details|numbers?)|cvv|iban|bank (?:details|account)|(?:send|share|provide|give).{0,30}(?:id card|passport|emirates id|home address|full address|your address)|threaten|blackmail)\b|عربون|رسوم (?:مسبق|تسجيل)|ادفع|حول (?:لي|المبلغ)|رابط (?:الدفع|تحويل)|بطاقتك|رقم البطاقة|الرمز السري|رمز التحقق|كلمة (?:السر|المرور)|هويتك|جوازك|عنوان بيتك/u;
const QUOTED = /\b(?:he|she|they|someone|seller|buyer) (?:says?|said|asked|wrote)\b|["“«]|(?:قال|قالت) (?:لي|انه|انها)/u;
const RESTART = /^(?:hi|hello|hey|good (?:morning|evening)|مرحبا|هلا|السلام عليكم)(?=$|[,.!،\s])|\b(?:different (?:offer|item|order|product)|new (?:offer|listing|item)|another (?:item|offer))\b/u;
const ACK = /^(?:thanks?(?: you)?|thank you|great|cheers|got it|noted|see you|sounds good|understood|شكرا|مشكور|تسلم)(?=$|[\s,.!،])/u;
const normalizedQuestion = (text: string) => /[?؟]/u.test(text) || /^(?:where|what|when|which|shall|can|could|would|do you|is it|وين|متى|هل|شو|اي ساع)/u.test(text);
const ref = ({ messageId, messageEventId }: MeetingTurn): MeetingSource => ({ messageId, messageEventId });

const ASK_DAY = /\b(?:what|which) (?:day|date)|\bwhen (?:is|was) the date|اي يوم|شو التاريخ|متى التاريخ/u;
const OTHER_TOPIC = /\b(?:warranty|manufactur\w*|policy|payment|receipt|condition|price|serial|documents?|model|original|refund|chang\w*|instead|other|different|reschedul\w*)\b|تغيير|تبديل|نغير|ضمان|فاتورة|سعر/u;
export function isRepeatedMeetingQuestion(text: string, dayConfirmed = false): boolean {
  const words = normalize(text);
  if (!normalizedQuestion(words) || OTHER_TOPIC.test(words) || RISK.test(words) ||
    /\band (?:does|do|is|has|can|how)|[?؟]\s*[^?؟\s]/u.test(words)) return false;
  const planning = proposesMeeting(words);
  if (ASK_DAY.test(words) || (planning && DAY.test(words))) return dayConfirmed;
  if (planning) return true;
  // Short logistics questions can omit the meeting noun. Longer questions need a concrete scheduling cue.
  return /^(?:where (?:exactly|specifically|at)|what time(?: (?:exactly|works(?: for you)?|is good|suits you))?|when exactly|اي ساعة|وين بالضبط)[?؟.! ]*$/u.test(words) ||
    ((WHERE.test(words) || WHEN.test(words)) && /meeting (?:place|time|location)|pickup (?:point|time)|مكان اللقاء|وقت اللقاء/u.test(words));
}

function directPlace(text: string): boolean {
  if (normalizedQuestion(text) || NONANSWER.test(text) || ACCEPT.test(text) || CLOCK.test(text) || DAY.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length >= 2 && words.length <= 12 && /[\p{L}]/u.test(text)
    && !/\b(?:i|we|you|could|would|want|think|like|have|it is fine|meet up|agree|cant tell|dont|ask|sure|sorry|delivery|shipping|cash|online|hours?|minutes?|sometime|no|send|order|book)\b/u.test(text);
}

/** With no supported handover or archived context, search only one recent, contiguous planning exchange.
 * A fresh proposal starts a new candidate. Conditions, ambiguous changes and unanswered proposals do not qualify. */
export function matchMeeting(turns: readonly MeetingTurn[]): MeetingEvidence | null {
  const words = turns.map(turn => normalize(turn.text));
  const last = turns.length - 1;
  let start = last;
  for (; start >= 0; start--) {
    if (!words[start] || (start < last && (turns[start + 1]!.at - turns[start]!.at > 3600 || RESTART.test(words[start + 1]!)))) return null;
    if (proposesMeeting(words[start]!)) {
      // "Where/when should we meet?" can clarify a previous yes. Prefer the earlier proposal when adjacent.
      if ((WHERE.test(words[start]!) || WHEN.test(words[start]!)) && start >= 2 && ACCEPT.test(words[start - 1]!)
        && proposesMeeting(words[start - 2]!) && turns[start - 1]!.direction === 'incoming') { start -= 2; }
      // An affirmative seller answer can repeat the buyer's invitation in the same exchange.
      else if (turns[start]!.direction === 'incoming' && start >= 1 && turns[start - 1]!.direction === 'outgoing' && proposesMeeting(words[start - 1]!)) start--;
      break;
    }
  }
  if (start < 0 || last - start > 16) return null;
  // Scan the entire bounded episode, since an earlier fee is relevant even after many ordinary turns.
  for (let i = start - 1; i >= 0; i--) {
    if (!words[i] || turns[i + 1]!.at - turns[i]!.at > 3600 || RESTART.test(words[i + 1]!)) break;
    if (turns[i]!.direction === 'incoming' && (RISK.test(words[i]!) || /\b(?:send (?:me |us )?(?:the |some )?money|wire (?:me |us )?funds)\b/u.test(words[i]!))) return null;
  }
  const first = turns[start]!;
  const proof: Partial<MeetingEvidence> = {};
  let previous = '';
  for (let i = start; i <= last; i++) {
    const turn = turns[i]!, text = words[i]!;
    if (!text || QUOTED.test(text) || CANCEL.test(text) || CONDITION.test(text) || (turn.direction === 'incoming' && RISK.test(text))) return null;
    const referencingProposal = i > start && turns[i - 1]!.direction !== turn.direction;
    const question = normalizedQuestion(text);
    const place = VENUE.test(text) && !NONANSWER.test(text) && !(question && WHERE.test(text)) ||
      (referencingProposal && WHERE.test(previous) && directPlace(text));
    const time = CLOCK.test(text) || (referencingProposal && WHEN.test(previous) && /^(?:at\s+)?(?:[1-9]|1[0-2])[.!]?$/u.test(text));
    const date = DAY.test(text);
    if (turn.direction === 'incoming' || i === start) {
      if (place) proof.place = ref(turn);
      if (time) proof.time = ref(turn);
      if (date) proof.date = ref(turn);
    }
    if (referencingProposal && !question && !proof.agreement && turn.direction !== first.direction) {
      if (ACCEPT.test(text) || (turn.direction === 'incoming' && (place || time) && (proposesMeeting(previous) || WHERE.test(previous) || WHEN.test(previous)))) {
        proof.agreement = ref(turn);
      }
    }
    if (i > start && turn.direction === 'incoming' && !(place || time || date || ACCEPT.test(text) || ACK.test(text))) return null;
    if (i > start && turn.direction === 'outgoing' && !(WHERE.test(text) || WHEN.test(text) || proposesMeeting(text) || ACCEPT.test(text) || ACK.test(text))) return null;
    previous = text;
  }
  return proof.agreement && proof.time && proof.place ? { agreement: proof.agreement, time: proof.time, place: proof.place,
    ...(proof.date && { date: proof.date }) } : null;
}
