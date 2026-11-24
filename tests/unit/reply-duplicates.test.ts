import { describe, expect, it } from 'vitest';
import { hasAnsweredIdentityRepeat } from '../../src/replies/reply-duplicates.ts';
import type { ReplyTurn } from '../../src/replies/reply-generator.ts';

const contact = (text: string): ReplyTurn => ({ from: 'contact', text });
const owner = (text: string): ReplyTurn => ({ from: 'owner', text });
const question = 'Are you AI?';

describe('repeating the same identity check', () => {
  it.each([
    [question, 'Yes.'], [question, 'These replies are automated.'], [question, 'I’m not human.'],
    ['هل أنت روبوت؟', 'نعم، أنا بوت.'], ['هل أنت روبوت؟', 'نعم.'],
    ['Are you human or AI?', 'I’m AI.'], ['هل أنت إنسان ولا بوت؟', 'أنا بوت.'],
  ])('recognizes a clear prior answer to %s: %s', (q, answer) => {
    expect(hasAnsweredIdentityRepeat([contact(q), owner(answer), contact(q)], [q])).toBe(true);
  });

  it.each([
    [question, 'Are you asking who replies?'], [question, 'I don’t know.'], [question, 'Maybe a bot.'],
    [question, 'Yes, but I’m not sure.'], ['هل أنت روبوت؟', 'تقصد مين يرد؟'], ['هل أنت روبوت؟', 'يمكن بوت'],
    ['Who are you?', 'Yes.'], ['Are you human or AI?', 'Yes.'], ['هل أنت إنسان ولا بوت؟', 'نعم.'],
  ])('keeps the question eligible after an unclear response: %s / %s', (q, answer) => {
    expect(hasAnsweredIdentityRepeat([contact(q), owner(answer), contact(q)], [q])).toBe(false);
  });

  it('keeps new questions, unaddressed topics and mixed bursts eligible', () => {
    const fee = 'Can you confirm the delivery fee?';
    const answer = owner('I’m a bot.');
    expect(hasAnsweredIdentityRepeat([contact('AI?'), answer, contact(question)], [question])).toBe(false);
    expect(hasAnsweredIdentityRepeat([contact(question), answer, contact(fee), contact(question)], [question])).toBe(false);
    expect(hasAnsweredIdentityRepeat([contact(question), answer, contact(question), contact(fee)], [question, fee])).toBe(false);
    expect(hasAnsweredIdentityRepeat([contact(fee), contact(question), owner('Yes.'), contact(question)], [question])).toBe(false);
  });
});
