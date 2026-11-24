import { describe, expect, it } from 'vitest';
import { matchMeeting, isRepeatedMeetingQuestion, type MeetingTurn } from '../../src/services/meeting-evidence.ts';

type Pair = ['outgoing' | 'incoming', string];
const conversation = (...pairs: Pair[]): MeetingTurn[] => pairs.map(([direction, text], i) => ({
  messageId: 'm' + i, messageEventId: 'e' + i, direction, text, at: 1_800_000_000 + i * 15,
}));
const plan: Pair[] = [
  ['outgoing', 'Can I pick it up in person?'], ['incoming', 'Yes'],
  ['outgoing', 'Where exactly in that area?'], ['incoming', 'Outside the west station entrance'],
  ['outgoing', 'What time works?'], ['incoming', '6pm'], ['outgoing', 'Thanks.'],
];
describe('source-grounded meeting assessment', () => {
  it('cites the contact acceptance, time, and place from a single exchange; no day is invented', () => {
    expect(matchMeeting(conversation(...plan))).toEqual({
      agreement: { messageId: 'm1', messageEventId: 'e1' }, place: { messageId: 'm3', messageEventId: 'e3' },
      time: { messageId: 'm5', messageEventId: 'e5' },
    });
  });
  it('accepts a direct schedule answer and isolates Arabic evidence and explicit day', () => {
    const proof = matchMeeting(conversation(['outgoing','وين نقدر نتلاقى؟'],
      ['incoming','نتلاقى باجر الساعة ٥ العصر عند مدخل المحطة']));
    expect(proof?.agreement.messageId).toBe('m1');
    expect(proof?.time.messageId).toBe('m1');
    expect(proof?.date?.messageId).toBe('m1');
    expect(proof?.place.messageId).toBe('m1');
  });
  it('requires seller acceptance of a buyer-proposed specific appointment', () => {
    const proposed: Pair = ['outgoing', 'Shall we meet at the east station entrance on Friday at 4pm?'];
    expect(matchMeeting(conversation(proposed))).toBeNull();
    const confirmation = matchMeeting(conversation(proposed, ['incoming', 'Sure, that works.']));
    expect(confirmation?.agreement.messageId).toBe('m1');
    expect(confirmation?.time.messageId).toBe('m0');
    expect(confirmation?.place.messageId).toBe('m0');
    expect(confirmation?.date?.messageId).toBe('m0');
  });
  it.each(['Actually I cannot meet.', 'Pay a deposit first.', 'Send me your OTP first.', 'Can we do a different time?', 'No, not 6pm.', 'Send your full address first.', 'Send me money first.', 'I will not meet at the station.', 'Sure, but only if you book online first.'])(
    'withdraws the tentative assessment after %s', (text) => {
      expect(matchMeeting(conversation(...plan, ['incoming', text]))).toBeNull();
    });
  it('does not merge schedules from another contact episode or generic acceptance', () => {
    expect(matchMeeting(conversation(['incoming', 'Friday at 8pm at the station'], ['outgoing', 'Shall we meet in person?'], ['incoming','Yes']))).toBeNull();
    expect(matchMeeting(conversation(['outgoing','Can you sell it for less?'], ['incoming','Sure'], ['outgoing','What time?'], ['incoming','3pm']))).toBeNull();
    expect(matchMeeting(conversation(...plan, ['incoming','Hello, different item today.'], ['outgoing','Can we meet in person?'], ['incoming','Yes']))).toBeNull();
  });
  it('retains a payment condition across a longer exchange in the same episode', () => {
    const conversationAboutItem: Pair[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 ? ['incoming', 'It has that feature.'] : ['outgoing', 'Does the item include its accessories?']);
    expect(matchMeeting(conversation(['incoming', 'A deposit is required first.'], ...conversationAboutItem, ...plan))).toBeNull();
  });
  it('requires actual place evidence and rejects evasive or quoted replies', () => {
    for (const text of ['I do not know','ask me later','where are you?','the seller said "yes"','whatever you want',
      'I only do shipping','you must book online','in a few hours','there is no pickup','order online','cash on delivery']) {
      const turns = conversation(...plan); turns[3]!.text = text;
      expect(matchMeeting(turns)).toBeNull();
    }
  });
  it.each(['Could I come see it?', 'Can I come and inspect it?', 'Can I come to look at it?', 'أقدر أمر أشوفه؟'])(
    'supports a physical inspection proposal: %s', (proposal) => {
      const turns = conversation(...plan); turns[0]!.text = proposal;
      expect(matchMeeting(turns)?.agreement.messageId).toBe('m1');
    });
  it('does not interpret a request to see a product photo as an in-person inspection', () => {
    const turns = conversation(...plan); turns[0]!.text = 'Can I see a photo of it?';
    expect(matchMeeting(turns)).toBeNull();
  });
  it('detects repeated requests for arrangements and permits an ordinary acknowledgement', () => {
    expect(isRepeatedMeetingQuestion('Where exactly should we meet?')).toBe(true);
    expect(isRepeatedMeetingQuestion('أي ساعة نتلاقى؟')).toBe(true);
    expect(isRepeatedMeetingQuestion('Sounds good, thanks.')).toBe(false);
    expect(isRepeatedMeetingQuestion('Which day should we meet?', false)).toBe(false);
    expect(isRepeatedMeetingQuestion('What day should we meet?', true)).toBe(true);
    expect(isRepeatedMeetingQuestion('When does the warranty start?')).toBe(false);
    expect(isRepeatedMeetingQuestion('Where was it manufactured?')).toBe(false);
    expect(isRepeatedMeetingQuestion('Is the meeting time changing?')).toBe(false);
  });
  it.each(['I had a meeting at the station at 5pm.', 'Are pickup fees at the shop higher after 4pm?',
    'Can we meet at the station at 4pm or 6pm?', 'Can we meet at the station if you finish work at 6pm?'])(
    'does not read an incidental or ambiguous time as an agreed appointment: %s', (text) => {
      expect(matchMeeting(conversation(['outgoing', text], ['incoming', 'Yes.']))).toBeNull();
    });
});
