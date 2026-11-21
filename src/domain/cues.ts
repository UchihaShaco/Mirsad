/**
 * The deterministic cues of design section 10, shared by the deterministic reviewer and the code-side payment link
 * check. English cues match whole words (a plural s allowed), case-insensitively, and payment cues their -ed and -ing
 * forms too; Arabic cues match anywhere, because Arabic words carry attached prefixes and suffixes.
 */

const ENGLISH_PAYMENT_CUES = ['pay', 'payment', 'transfer', 'invoice', 'fee', 'deposit', 'checkout', 'settle', 'remit'];
/**
 * The -ed and -ing forms of the English payment cues, as English spells them. fee, payment and checkout are nouns and
 * have none, so feed and feel never count.
 */
const ENGLISH_PAYMENT_INFLECTIONS = [
  'paid', 'paying', 'transferred', 'transferring', 'invoiced', 'invoicing',
  'deposited', 'depositing', 'settled', 'settling', 'remitted', 'remitting',
];
/** حول is not a cue: besides "transfer!" it is the everyday word for "about". */
const ARABIC_PAYMENT_CUES = ['ادفع', 'الدفع', 'دفع', 'تحويل', 'رسوم', 'فاتورة', 'سداد', 'المبلغ'];
const ENGLISH_CALLBACK_CUES = ['call', 'ring', 'whatsapp', 'contact me'];
const ARABIC_CALLBACK_CUES = ['اتصل', 'كلمني', 'راسلني', 'تواصل'];
const ENGLISH_RECIPIENT_MARKERS = ['recipient', 'beneficiary', 'account name'];
const ARABIC_RECIPIENT_MARKERS = ['المستفيد', 'اسم الحساب'];

/** Separators and closing punctuation left between a recipient marker and the name that follows it. */
const MARKER_SEPARATOR = /^[\s:：=\-–—]+/;
const TRAILING_PUNCTUATION = /[\s.,;!?،؛؟]+$/;

function wholeWords(words: readonly string[]): RegExp {
  const alternatives = words.map((word) => word.split(' ').join('\\s+')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})s?(?![\\p{L}\\p{N}_])`, 'iu');
}

const ENGLISH_PAYMENT = wholeWords([...ENGLISH_PAYMENT_CUES, ...ENGLISH_PAYMENT_INFLECTIONS]);
const ENGLISH_CALLBACK = wholeWords(ENGLISH_CALLBACK_CUES);
const ENGLISH_RECIPIENT = wholeWords(ENGLISH_RECIPIENT_MARKERS);

const containsAny = (text: string, cues: readonly string[]): boolean => cues.some((cue) => text.includes(cue));

/** Whether message prose (links already masked out) asks for a payment. */
export function hasPaymentCue(prose: string): boolean {
  return ENGLISH_PAYMENT.test(prose) || containsAny(prose, ARABIC_PAYMENT_CUES);
}

/** Whether message prose asks to be called or messaged back. */
export function hasCallbackCue(prose: string): boolean {
  return ENGLISH_CALLBACK.test(prose) || containsAny(prose, ARABIC_CALLBACK_CUES);
}

/** The end offset of the first recipient marker in a line, or -1. */
function recipientMarkerEnd(line: string): number {
  const english = ENGLISH_RECIPIENT.exec(line);
  const ends = english ? [{ start: english.index, end: english.index + english[0].length }] : [];
  for (const marker of ARABIC_RECIPIENT_MARKERS) {
    const start = line.indexOf(marker);
    if (start >= 0) ends.push({ start, end: start + marker.length });
  }
  const first = ends.reduce<{ start: number; end: number } | null>((best, m) => (best === null || m.start < best.start ? m : best), null);
  return first === null ? -1 : first.end;
}

/** The name written after the first recipient marker of a line, up to its end; null when there is none. */
export function textAfterRecipientMarker(line: string): string | null {
  const end = recipientMarkerEnd(line);
  if (end < 0) return null;
  const name = line.slice(end).replace(MARKER_SEPARATOR, '').replace(TRAILING_PUNCTUATION, '');
  return name === '' ? null : name;
}
