import type { InvestigationOpenerRequest } from '../contract/schemas.ts';

const openers = [
  {
    matches: /\b(?:up[ -]?front|fees?|advance payment|deposits?)\b|رسوم|دفعة مقدمة|عربون/iu,
    english: 'Hi, could you share what the offer includes and whether there are any upfront costs?',
    arabic: 'هلا، ممكن توضح لي شو يشمل العرض وإذا فيه أي رسوم من البداية؟',
  },
  {
    matches: /\b(?:jobs?|hiring|recruitment|vacanc(?:y|ies))\b|وظيف[ةه]|توظيف|فرصة عمل/iu,
    english: 'Hi, could you share what the job involves and how the hiring process works?',
    arabic: 'هلا، ممكن تخبرني شو طبيعة الشغل وكيف يكون التقديم؟',
  },
  {
    matches: /\b(?:deliver(?:y|ies)|shipping|shipments?|pickup|pick up)\b|توصيل|شحن|استلام/iu,
    english: 'Hi, could you share the offer details and how delivery or pickup works?',
    arabic: 'هلا، ممكن تخبرني تفاصيل العرض وكيف يكون التوصيل أو الاستلام؟',
  },
];

const generalOpener = {
  english: 'Hi, could you share the basic details of the offer and how it works?',
  arabic: 'هلا، ممكن تعطيني التفاصيل الأساسية عن العرض وكيف يمشي؟',
};

/** Use the briefing only to select a neutral, locally written question for the officer to review. */
export function draftInvestigationOpener({ officerContext, language }: InvestigationOpenerRequest): string {
  const context = officerContext.normalize('NFKC');
  const opener = openers.find(({ matches }) => matches.test(context)) ?? generalOpener;
  return opener[language];
}
