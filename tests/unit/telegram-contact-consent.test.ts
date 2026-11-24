import { describe, expect, it } from 'vitest';
import { isTelegramContactOptOut } from '../../src/services/telegram-reply-holds.ts';

describe('contact withdrawal, independent of test administration', () => {
  it.each([
    'Stop', 'Please stop.', 'UNSUBSCRIBE', 'Stop texting me, please.', 'Please stop replying to me.',
    'I don’t want you to contact me anymore.', "Don't send me any more messages.", 'Leave me alone.',
    'Hey, could you please stop messaging me?', "I'd prefer you didn't message me again", "No thanks, don't message me again",
    'Please stop messaging.', 'Stop. Thank you.', 'Can you please stop texting me?',
    'Actually please leave me alone.', 'Actually, please leave me alone.',
    'She said, “The shop is open”, actually please leave me alone.',
    'He wrote “Message me”, but please stop. Stop messaging me.',
    'خلاص اتركني بحالي ولا ترسل لي رسائل', 'خلاص، اتركني بحالي.',
    'لا تراسلني مرة ثانية', 'لو سمحت، لا ترسل لي رسائل', 'ما ترسل لي رسائل', 'وقف مراسلتي',
    'خلاص لا ترد علي مرة ثانية.', 'لو سمحت، لا تردّ عليّ.', 'لا تردون علي', 'لا تردين علي مره ثانيه.',
  ])('recognizes a contact preference: %s', text => expect(isTelegramContactOptOut(text)).toBe(true));

  it.each([
    'Stop the testing now', 'Stop asking these questions', 'Stop by the store.', 'Don’t stop messaging me.',
    'Do not message my colleague.', 'Please do not contact the courier.', 'توقف عن الاختبار', 'لا تتواصل مع الموظف',
    'They wrote, “Stop messaging me!” yesterday.', "The sample says, 'stop messaging me'.", 'They said to stop messaging me.',
    'She said, actually please leave me alone.', 'She wrote, “Actually please leave me alone.”',
    'قال لي، خلاص اتركني بحالي ولا ترسل لي رسائل', 'قالت «خلاص اتركني بحالي ولا ترسل لي رسائل».',
    'Actually please leave my parcel alone.', 'خلاص اترك الطرد عند الباب',
    'لا ترد على السؤال.', 'لا ترد علي بخصوص هالسؤال.', 'لا ترد عليه مرة ثانية.', 'ليش ما ترد علي؟',
    'قال لي، لا ترد علي مرة ثانية.', 'صاحبي قال لي، لا ترد علي مرة ثانية.',
    'كتب «لا تردون علي».', 'إذا قلت لا ترد علي، شو تقصد؟',
  ])('keeps unrelated instructions out of contact consent: %s', text => expect(isTelegramContactOptOut(text)).toBe(false));
});
