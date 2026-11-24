import { isIdentityCheck, type ReplyTurn } from './reply-generator.ts';

// Only complete, unqualified answers count. A mention of AI in a clarification or a guess is insufficient.
const BINARY_ANSWER = /^(?:yes|yeah|yep|yup|correct|no|nope|nah|نعم|اي|ايه|ايوه|ايوا|صحيح|لا)$/u;
const ENGLISH_ANSWER = /^(?:(?:(?:i am|i'm|im|it is|it's|its|this is|you're chatting with|you are chatting with) )?(?:an? )?(?:ai(?: assistant)?|bot|chatbot|robot|automated(?: reply| assistant)?)|(?:this chat|this account) uses ai|(?:these |my |the )?replies(?: here)? are (?:automated|ai generated)|(?:i am|i'm|im) (?:not human|not a (?:human|person)))$/u;
const ARABIC_ANSWER = /^(?:(?:انا |هذا )?(?:بوت|روبوت|ذكاء اصطناعي|مساعد (?:الي|ذكي)|نظام (?:الي|ذكاء اصطناعي))|(?:الرد|الردود|ردودي) (?:الي|الية)|(?:انا )?(?:مو|مش|لست) (?:انسان|انسانا|بشري|بشرا))$/u;

function answeredUnambiguously(answer: string, question: string, previous: ReplyTurn | undefined): boolean {
  if (/[?؟]/u.test(answer)) return false;
  const words = answer.normalize('NFKC').toLowerCase().replace(/[‘’]/gu, "'")
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '').replace(/[أإآ]/gu, 'ا')
    .replace(/[.!،,]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (BINARY_ANSWER.test(words)) {
    // A bare yes/no needs one polar question, without a choice or other topic it could refer to.
    const openOrAlternative = /^(?:who\b|(?:مين|من)\s)|\bor\b|\s(?:أو|او|ولا)\s/iu.test(question);
    return !openOrAlternative && (previous?.from !== 'contact' || previous.text.trim() === question);
  }
  const statement = words.replace(/^(?:yes|yeah|yep|no|نعم|اي|ايه|ايوه|ايوا|لا) /u, '');
  return ENGLISH_ANSWER.test(statement) || ARABIC_ANSWER.test(statement);
}

/** True only for a standalone repeat of the last answered identity question with no intervening topic. */
export function hasAnsweredIdentityRepeat(history: readonly ReplyTurn[], currentTurn: readonly string[]): boolean {
  const question = currentTurn[0]?.trim();
  if (currentTurn.length !== 1 || !question || !isIdentityCheck(question)) return false;
  const lastAnswer = history.findLastIndex(turn => turn.from === 'owner');
  const earlier = history[lastAnswer - 1];
  const answer = history[lastAnswer];
  if (earlier?.from !== 'contact' || earlier.text.trim() !== question || !answer) return false;
  const following = history.slice(lastAnswer + 1);
  return following.length > 0 && following.every(turn => turn.from === 'contact' && turn.text.trim() === question)
    && answeredUnambiguously(answer.text, question, history[lastAnswer - 2]);
}
