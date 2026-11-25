/**
 * Website checks on the Places endpoints: after an import of the synthetic website checks report, the search marks
 * flagged listings, filters by flag with counts per kind, and the place detail carries the check for the panel.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlacesDetailResponse, PlacesSearchResponse } from '../../src/contract/schemas.ts';
import { loadPlaces } from '../../src/places/store.ts';
import { importWebsiteChecks } from '../../src/places/website-checks.ts';
import { DATABASE_FILE, openDatabase } from '../../src/storage/db.ts';
import { readWebsiteChecks } from '../../scripts/import-website-checks.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const SAMPLE_FILE = fileURLToPath(new URL('../../fixtures/places/abu-dhabi-sample.json', import.meta.url));
const REPORT_FILE = fileURLToPath(new URL('../../fixtures/places/website-checks-sample.json', import.meta.url));
const AESOP = '2ca3aec0-e67f-4199-99f4-a98ef0cefb79';
const RENTOKIL = 'c2e77fb3-9236-46d0-9d0a-d14cacee4001';
const BURBERRY = '051caae6-ac27-4026-9575-80745afd0c18';
const HM = '7656c392-09ae-4f4d-ba3f-263c227eb638';
const HM_TWO = 'b04e2226-2589-474d-9dba-91e6d4358a63';

let h: TestHarness;

beforeAll(async () => {
  const places = loadPlaces(SAMPLE_FILE);
  h = await startHarness({ places });
  // The operator command's own path: a second connection to the running instance's database.
  const db = openDatabase(path.join(h.dataDir, DATABASE_FILE));
  try {
    const { report, sha256 } = readWebsiteChecks(REPORT_FILE);
    importWebsiteChecks(db, report, new Set(places.map((place) => place.id)), { reportSha256: sha256 });
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await h.close();
});

describe('places website checks', () => {
  it('marks flagged listings in the search and counts each kind', async () => {
    const res = await h.http(h.tokens.officerA).get('/v1/places/search');
    expect(res.status).toBe(200);
    expect(PlacesSearchResponse.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.places).toHaveLength(5);
    expect(res.body.data.websiteFlags).toEqual({
      [AESOP]: 'harmful', [RENTOKIL]: 'parked', [BURBERRY]: 'suspicious', [HM]: 'unconfirmed',
    });
    expect(res.body.data.websiteFlagCounts).toEqual({ harmful: 1, suspicious: 1, parked: 1, unconfirmed: 1 });
  });

  it('filters to flagged websites, leaving low-confidence warnings to their own filter', async () => {
    const flagged = await h.http(h.tokens.officerA).get('/v1/places/search?websiteFlag=flagged');
    expect(flagged.status).toBe(200);
    expect(flagged.body.data.places.map((p: { id: string }) => p.id).sort()).toEqual([AESOP, BURBERRY, RENTOKIL].sort());
    expect(flagged.body.meta.total).toBe(3);

    const harmful = await h.http(h.tokens.officerA).get('/v1/places/search?websiteFlag=harmful');
    expect(harmful.body.data.places.map((p: { id: string }) => p.id)).toEqual([AESOP]);
    // The counts follow the text and category search, not the flag filter, so the filter shows every kind.
    expect(harmful.body.data.websiteFlagCounts).toEqual({ harmful: 1, suspicious: 1, parked: 1, unconfirmed: 1 });

    const unconfirmed = await h.http(h.tokens.officerA).get('/v1/places/search?websiteFlag=unconfirmed');
    expect(unconfirmed.body.data.places.map((p: { id: string }) => p.id)).toEqual([HM]);
  });

  it('combines the flag filter with the viewport', async () => {
    const bbox = encodeURIComponent('54.38,24.49,54.40,24.51');
    const res = await h.http(h.tokens.officerA).get(`/v1/places/search?websiteFlag=flagged&bbox=${bbox}`);
    expect(res.status).toBe(200);
    expect(res.body.data.places.map((p: { id: string }) => p.id)).toEqual([BURBERRY]);
  });

  it('rejects an unknown flag with validation_failed', async () => {
    const res = await h.http(h.tokens.officerA).get('/v1/places/search?websiteFlag=gambling');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('carries the most serious website check on the place detail', async () => {
    const res = await h.http(h.tokens.officerA).get(`/v1/places/${AESOP}`);
    expect(res.status).toBe(200);
    expect(PlacesDetailResponse.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.websiteCheck).toMatchObject({
      website: 'https://lapsed-shop.example/', decision: 'block', riskScore: 94, finding: 'harmful_redirect', flag: 'harmful',
      finalUrl: 'https://win-big-casino.test/landing?ref=lapsed', evidenceRef: 'SS-0A1B2C3D',
      checkedAt: '2026-11-24T09:01:12.120000Z',
    });
    expect(res.body.data.websiteCheck.reasons).toHaveLength(3);
    expect(res.body.data.websiteCheck.reasons[0]).toEqual({
      code: 'page.harmful_redirect', en: 'Redirects to an online gambling site', ar: 'يحوّل إلى موقع قمار على الإنترنت',
    });

    const parked = await h.http(h.tokens.officerA).get(`/v1/places/${RENTOKIL}`);
    expect(parked.body.data.websiteCheck).toMatchObject({ flag: 'parked', website: 'https://closed-service.example/' });

    const clean = await h.http(h.tokens.officerA).get(`/v1/places/${HM_TWO}`);
    expect(clean.body.data.websiteCheck).toMatchObject({ flag: null, finding: 'none', decision: 'allow' });
  });
});

describe('places without an imported report', () => {
  it('flags nothing and returns a null website check', async () => {
    const plain = await startHarness({ places: loadPlaces(SAMPLE_FILE) });
    try {
      const res = await plain.http(plain.tokens.officerA).get('/v1/places/search?websiteFlag=flagged');
      expect(res.status).toBe(200);
      expect(res.body.data.places).toHaveLength(0);
      expect(res.body.data.websiteFlagCounts).toEqual({ harmful: 0, suspicious: 0, parked: 0, unconfirmed: 0 });
      const one = await plain.http(plain.tokens.officerA).get(`/v1/places/${AESOP}`);
      expect(one.body.data.websiteCheck).toBeNull();
    } finally {
      await plain.close();
    }
  });
});
