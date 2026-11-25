/**
 * Awareness campaigns: a synthetic population of the Abu Dhabi emirate and a simulated phishing-awareness campaign.
 * Pure functions and plain data, no DOM. Nothing here is real data and nothing is ever sent: the click model is an
 * illustrative guess so the page can show how a real campaign would be planned and read.
 */

/** Deterministic PRNG (mulberry32) so the same campaign always gives the same picture. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function pick(random, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

export const REGIONS = [
  { id: 'abu-dhabi', name: 'Abu Dhabi region', ar: 'منطقة أبوظبي' },
  { id: 'al-ain', name: 'Al Ain region', ar: 'منطقة العين' },
  { id: 'al-dhafra', name: 'Al Dhafra region', ar: 'منطقة الظفرة' },
];

export const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
export const GENDERS = { male: 'Male', female: 'Female' };
export const NATIONALITIES = {
  emirati: 'Emirati',
  arab: 'Arab expat',
  southAsian: 'South Asian',
  seAsian: 'Southeast Asian',
  western: 'Western and other',
};
export const RESIDENCES = { villa: 'Villa', apartment: 'Apartment', shared: 'Shared accommodation' };
export const LANGUAGES = { ar: 'Arabic', en: 'English', ur: 'Urdu', hi: 'Hindi', tl: 'Tagalog' };

const E = (emirati, arab, southAsian, seAsian, western) => ({ emirati, arab, southAsian, seAsian, western });
const R = (villa, apartment, shared) => ({ villa, apartment, shared });

/** Approximate community centres (lat, lon), relative population weight and spread in km. Illustrative only. */
export const COMMUNITIES = [
  ['abu-dhabi-island', 'Abu Dhabi Island', 'جزيرة أبوظبي', 'abu-dhabi', 24.468, 54.37, 18, 3.2, E(25, 25, 30, 12, 8), R(15, 75, 10)],
  ['al-reem', 'Al Reem Island', 'جزيرة الريم', 'abu-dhabi', 24.497, 54.404, 5, 1.2, E(15, 30, 20, 15, 20), R(5, 95, 0)],
  ['saadiyat', 'Saadiyat Island', 'جزيرة السعديات', 'abu-dhabi', 24.545, 54.44, 2, 2.0, E(30, 20, 10, 10, 30), R(60, 40, 0)],
  ['yas', 'Yas Island', 'جزيرة ياس', 'abu-dhabi', 24.49, 54.605, 2, 2.0, E(25, 25, 15, 15, 20), R(40, 60, 0)],
  ['khalifa-city', 'Khalifa City', 'مدينة خليفة', 'abu-dhabi', 24.42, 54.58, 7, 2.5, E(55, 25, 10, 5, 5), R(70, 30, 0)],
  ['mbz-city', 'Mohammed Bin Zayed City', 'مدينة محمد بن زايد', 'abu-dhabi', 24.34, 54.54, 7, 2.5, E(40, 30, 20, 5, 5), R(50, 50, 0)],
  ['mussafah', 'Mussafah and ICAD', 'المصفح', 'abu-dhabi', 24.35, 54.49, 9, 3.0, E(5, 10, 55, 22, 8), R(0, 30, 70)],
  ['shakhbout', 'Shakhbout City', 'مدينة شخبوط', 'abu-dhabi', 24.37, 54.64, 3, 2.0, E(70, 20, 5, 3, 2), R(90, 10, 0)],
  ['al-shamkha', 'Al Shamkha', 'الشامخة', 'abu-dhabi', 24.39, 54.705, 3, 3.0, E(75, 15, 6, 3, 1), R(90, 10, 0)],
  ['baniyas', 'Baniyas', 'بني ياس', 'abu-dhabi', 24.3, 54.64, 4, 2.5, E(45, 25, 20, 5, 5), R(60, 35, 5)],
  ['al-wathba', 'Al Wathba', 'الوثبة', 'abu-dhabi', 24.26, 54.61, 2, 3.0, E(50, 10, 30, 7, 3), R(55, 15, 30)],
  ['al-rahba', 'Al Rahba', 'الرحبة', 'abu-dhabi', 24.62, 54.7, 2, 3.0, E(70, 15, 10, 3, 2), R(80, 15, 5)],
  ['al-falah', 'Al Falah', 'الفلاح', 'abu-dhabi', 24.45, 54.72, 2, 2.0, E(85, 10, 3, 1, 1), R(95, 5, 0)],
  ['al-samha', 'Al Samha', 'السمحة', 'abu-dhabi', 24.68, 54.74, 1.5, 2.5, E(75, 15, 6, 2, 2), R(85, 15, 0)],
  ['al-ain-centre', 'Al Ain city centre', 'وسط مدينة العين', 'al-ain', 24.215, 55.745, 8, 3.0, E(40, 20, 25, 10, 5), R(40, 50, 10)],
  ['al-hili', 'Al Hili', 'الهيلي', 'al-ain', 24.27, 55.77, 3, 2.5, E(75, 15, 6, 2, 2), R(90, 10, 0)],
  ['al-jimi', 'Al Jimi', 'الجيمي', 'al-ain', 24.235, 55.72, 3, 2.0, E(65, 20, 10, 3, 2), R(80, 20, 0)],
  ['al-muwaiji', 'Al Muwaiji', 'المويجعي', 'al-ain', 24.2, 55.7, 2, 2.0, E(65, 20, 10, 3, 2), R(80, 20, 0)],
  ['zakher', 'Zakher', 'زاخر', 'al-ain', 24.15, 55.7, 2, 2.5, E(60, 20, 12, 5, 3), R(75, 25, 0)],
  ['al-yahar', 'Al Yahar', 'اليحر', 'al-ain', 24.2, 55.54, 1.5, 3.0, E(55, 10, 25, 7, 3), R(60, 10, 30)],
  ['sweihan', 'Sweihan', 'سويحان', 'al-ain', 24.47, 55.34, 1, 3.0, E(60, 10, 22, 6, 2), R(60, 10, 30)],
  ['al-khazna', 'Al Khazna', 'الخزنة', 'al-ain', 24.16, 55.11, 0.7, 3.0, E(55, 10, 25, 8, 2), R(55, 10, 35)],
  ['madinat-zayed', 'Madinat Zayed', 'مدينة زايد', 'al-dhafra', 23.69, 53.705, 2, 3.0, E(45, 10, 35, 8, 2), R(55, 15, 30)],
  ['ruwais', 'Al Ruwais', 'الرويس', 'al-dhafra', 24.11, 52.73, 2.5, 3.0, E(15, 20, 45, 10, 10), R(10, 40, 50)],
  ['ghayathi', 'Ghayathi', 'غياثي', 'al-dhafra', 23.835, 52.805, 1, 2.5, E(55, 10, 25, 8, 2), R(60, 15, 25)],
  ['liwa', 'Liwa', 'ليوا', 'al-dhafra', 23.14, 53.79, 1, 4.0, E(60, 5, 25, 8, 2), R(65, 5, 30)],
  ['al-mirfa', 'Al Mirfa', 'المرفأ', 'al-dhafra', 24.09, 53.47, 0.7, 2.5, E(55, 10, 25, 8, 2), R(60, 15, 25)],
  ['al-sila', 'Al Sila', 'السلع', 'al-dhafra', 24.03, 51.75, 0.5, 2.5, E(50, 10, 30, 8, 2), R(55, 10, 35)],
  ['delma', 'Delma Island', 'جزيرة دلما', 'al-dhafra', 24.5, 52.32, 0.3, 1.2, E(75, 10, 10, 3, 2), R(85, 10, 5)],
].map(([id, name, ar, region, lat, lon, weight, spreadKm, nationality, residence]) => ({
  id, name, ar, region, lat, lon, weight, spreadKm, nationality, residence,
}));

export const COMMUNITY_BY_ID = Object.fromEntries(COMMUNITIES.map((c) => [c.id, c]));

const AGE_MIX = {
  emirati: [17, 24, 20, 15, 12, 12],
  arab: [12, 28, 26, 18, 10, 6],
  southAsian: [16, 34, 26, 15, 7, 2],
  seAsian: [18, 38, 25, 13, 5, 1],
  western: [9, 26, 28, 20, 11, 6],
};
const MALE_SHARE = { emirati: 0.5, arab: 0.56, southAsian: 0.78, seAsian: 0.5, western: 0.55 };
const LANGUAGE_MIX = {
  emirati: { ar: 92, en: 8 },
  arab: { ar: 85, en: 15 },
  southAsian: { ur: 45, hi: 35, en: 20 },
  seAsian: { tl: 55, en: 45 },
  western: { en: 100 },
};

/** A synthetic population of `size` adults placed around the communities. Deterministic for a given seed. */
export function buildPopulation(size = 48000, seed = 20261125) {
  const random = rng(seed);
  const weights = Object.fromEntries(COMMUNITIES.map((c) => [c.id, c.weight]));
  const people = new Array(size);
  for (let i = 0; i < size; i += 1) {
    const community = COMMUNITY_BY_ID[pick(random, weights)];
    const nationality = pick(random, community.nationality);
    const residence = nationality === 'emirati' && community.residence.shared > 0
      ? pick(random, { villa: community.residence.villa, apartment: community.residence.apartment })
      : pick(random, community.residence);
    const ageIndex = Number(pick(random, Object.fromEntries(AGE_MIX[nationality].map((w, k) => [k, w]))));
    const male = random() < (residence === 'shared' ? 0.93 : MALE_SHARE[nationality]);
    const kmToLat = 1 / 110.6;
    const kmToLon = 1 / (111.3 * Math.cos((community.lat * Math.PI) / 180));
    people[i] = {
      id: i,
      community: community.id,
      region: community.region,
      lat: community.lat + gaussian(random) * community.spreadKm * 0.55 * kmToLat,
      lon: community.lon + gaussian(random) * community.spreadKm * 0.55 * kmToLon,
      age: AGE_BANDS[ageIndex],
      gender: male ? 'male' : 'female',
      nationality,
      residence,
      language: pick(random, LANGUAGE_MIX[nationality]),
    };
  }
  return people;
}

/** The scam patterns a campaign can imitate, with the message each recipient would see. */
export const LURES = {
  parcel: {
    name: 'Parcel held for a small fee',
    ar: 'طرد محتجز مقابل رسوم صغيرة',
    base: 0.1,
    text: 'Emirates Post: your parcel is on hold. Pay AED 3.50 within 24 hours to release it: {link}',
    textAr: 'بريد الإمارات: طردك محتجز. ادفع 3.50 درهم خلال 24 ساعة لاستلامه: {link}',
    age: { '18-24': 1.1, '55-64': 1.3, '65+': 1.6 },
    nationality: { southAsian: 1.2, seAsian: 1.25 },
  },
  fine: {
    name: 'Unpaid traffic fine',
    ar: 'مخالفة مرورية غير مدفوعة',
    base: 0.085,
    text: 'You have an unpaid traffic fine of AED 400. Pay today to avoid a black point: {link}',
    textAr: 'لديك مخالفة مرورية غير مدفوعة بقيمة 400 درهم. ادفعها اليوم لتجنّب النقاط السوداء: {link}',
    age: { '25-34': 1.2, '35-44': 1.2 },
    nationality: { emirati: 1.15, arab: 1.1 },
  },
  bank: {
    name: 'Bank card blocked',
    ar: 'تجميد البطاقة البنكية',
    base: 0.075,
    text: 'Your bank card has been blocked for security reasons. Update your details now: {link}',
    textAr: 'تم إيقاف بطاقتك البنكية لأسباب أمنية. حدّث بياناتك الآن: {link}',
    age: { '55-64': 1.45, '65+': 1.9 },
    nationality: {},
  },
  uaepass: {
    name: 'UAE Pass or Emirates ID update',
    ar: 'تحديث الهوية الرقمية أو الهوية الإماراتية',
    base: 0.09,
    text: 'Your Emirates ID is linked to an expiring UAE Pass. Verify within 48 hours: {link}',
    textAr: 'هويتك الإماراتية مرتبطة بحساب هوية رقمية على وشك الانتهاء. تحقّق خلال 48 ساعة: {link}',
    age: { '55-64': 1.35, '65+': 1.7 },
    nationality: { emirati: 1.2 },
  },
  prize: {
    name: 'You won a prize',
    ar: 'ربحت جائزة',
    base: 0.06,
    text: 'Congratulations! Your number won AED 10,000 in the National Day draw. Claim it: {link}',
    textAr: 'مبروك! رقمك ربح 10,000 درهم في سحب اليوم الوطني. استلم جائزتك: {link}',
    age: { '18-24': 1.35, '65+': 1.3 },
    nationality: { southAsian: 1.2, seAsian: 1.2 },
    residence: { shared: 1.5 },
  },
  job: {
    name: 'Daily-pay job offer',
    ar: 'وظيفة بأجر يومي',
    base: 0.05,
    text: 'Part-time job: earn AED 600 a day from your phone. Apply in 2 minutes: {link}',
    textAr: 'وظيفة بدوام جزئي: اربح 600 درهم يومياً من هاتفك. قدّم خلال دقيقتين: {link}',
    age: { '18-24': 1.4, '25-34': 1.25 },
    nationality: { southAsian: 1.5, seAsian: 1.6 },
    residence: { shared: 2.2 },
  },
};

export const CHANNELS = { sms: 'SMS', whatsapp: 'WhatsApp' };

/** Default campaign filters: everyone. Empty arrays mean "all". */
export function emptyFilters() {
  return { communities: [], regions: [], ages: [], genders: [], nationalities: [], residences: [], languages: [] };
}

export function matches(person, filters) {
  const inArea = filters.communities.length === 0 && filters.regions.length === 0
    ? true
    : filters.communities.includes(person.community) || filters.regions.includes(person.region);
  return inArea
    && (filters.ages.length === 0 || filters.ages.includes(person.age))
    && (filters.genders.length === 0 || filters.genders.includes(person.gender))
    && (filters.nationalities.length === 0 || filters.nationalities.includes(person.nationality))
    && (filters.residences.length === 0 || filters.residences.includes(person.residence))
    && (filters.languages.length === 0 || filters.languages.includes(person.language));
}

export function eligible(people, filters) {
  return people.filter((p) => matches(p, filters));
}

/** Probability that this person taps the link, under the illustrative model. */
export function clickProbability(person, lure, { channel, messageLanguage }) {
  const l = LURES[lure];
  let p = l.base;
  p *= l.age?.[person.age] ?? 1;
  p *= l.nationality?.[person.nationality] ?? 1;
  p *= l.residence?.[person.residence] ?? 1;
  if (channel === 'whatsapp') p *= 1.15;
  const language = messageLanguage === 'auto' ? person.language : messageLanguage;
  p *= language === person.language ? 1.2 : 0.65;
  return Math.min(0.6, p);
}

/**
 * Runs one simulated campaign. Returns one record per recipient:
 * { person, delivered, clicked, at (seconds after send for the click), installed, reported }.
 */
export function simulateCampaign(people, config, seed) {
  const random = rng(seed);
  const pool = eligible(people, config.filters);
  const size = Math.min(config.size, pool.length);
  // Partial Fisher-Yates: a random sample of `size` recipients.
  const sample = pool.slice();
  for (let i = 0; i < size; i += 1) {
    const j = i + Math.floor(random() * (sample.length - i));
    [sample[i], sample[j]] = [sample[j], sample[i]];
  }
  const outcomes = [];
  for (let i = 0; i < size; i += 1) {
    const person = sample[i];
    const delivered = random() < 0.972;
    const clicked = delivered && random() < clickProbability(person, config.lure, config);
    outcomes.push({
      person,
      delivered,
      clicked,
      // Most clicks come in the first minutes; the time is scaled to the page's 12-second playback.
      at: clicked ? Math.min(11.5, -Math.log(Math.max(random(), 1e-6)) * 2.6) : null,
      installed: clicked && random() < 0.41,
      reported: delivered && !clicked && random() < 0.035,
    });
  }
  return outcomes;
}

/** Click rate by a person attribute: [{ key, sent, clicked, rate }] sorted by the attribute's natural order. */
export function rateBy(outcomes, attribute, order) {
  const groups = new Map(order.map((k) => [k, { key: k, sent: 0, clicked: 0 }]));
  for (const o of outcomes) {
    if (!o.delivered) continue;
    const key = o.person[attribute];
    if (!groups.has(key)) groups.set(key, { key, sent: 0, clicked: 0 });
    const g = groups.get(key);
    g.sent += 1;
    if (o.clicked) g.clicked += 1;
  }
  return [...groups.values()].map((g) => ({ ...g, rate: g.sent ? g.clicked / g.sent : 0 }));
}

/** The most exposed combinations of age band and nationality, with at least `minSent` delivered messages. */
export function riskiestSegments(outcomes, minSent = 60, limit = 4) {
  const groups = new Map();
  for (const o of outcomes) {
    if (!o.delivered) continue;
    const key = `${o.person.age}|${o.person.nationality}|${o.person.residence}`;
    const g = groups.get(key) ?? { age: o.person.age, nationality: o.person.nationality, residence: o.person.residence, sent: 0, clicked: 0 };
    g.sent += 1;
    if (o.clicked) g.clicked += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.sent >= minSent)
    .map((g) => ({ ...g, rate: g.clicked / g.sent }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, limit);
}

export function totals(outcomes) {
  let sent = 0, delivered = 0, clicked = 0, installed = 0, reported = 0;
  for (const o of outcomes) {
    sent += 1;
    if (o.delivered) delivered += 1;
    if (o.clicked) clicked += 1;
    if (o.installed) installed += 1;
    if (o.reported) reported += 1;
  }
  return { sent, delivered, clicked, installed, reported, rate: delivered ? clicked / delivered : 0 };
}
