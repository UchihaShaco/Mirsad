/**
 * Website checks on Places listings: the flag mapping, the report validation (format mirsad-places-website-checks/1), the idempotent import with its
 * counts and skipped place ids, the reads behind the map and panel, and the search filter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeImport, readWebsiteChecks, runImport } from '../../scripts/import-website-checks.ts';
import { WEBSITE_FLAG_LABELS } from '../../src/contract/labels.ts';
import { PlacesSearchResponse, WebsiteFinding } from '../../src/contract/schemas.ts';
import { PLACES_FILE, loadPlaces, searchPlaces } from '../../src/places/store.ts';
import {
  importWebsiteChecks, parseWebsiteChecks, readWebsiteCheck, readWebsiteFlags, websiteFlagFor,
} from '../../src/places/website-checks.ts';
import { DATABASE_FILE, openDatabase, type Db } from '../../src/storage/db.ts';
import {
  WEBSITE_FINDING_TEXT, WEBSITE_FLAG_LABELS as VIEW_FLAG_LABELS, defangUrl,
} from '../../src/dashboard/js/views/places-map.js';

const SAMPLE = fileURLToPath(new URL('../../fixtures/places/abu-dhabi-sample.json', import.meta.url));
const REPORT = fileURLToPath(new URL('../../fixtures/places/website-checks-sample.json', import.meta.url));
const places = loadPlaces(SAMPLE);
const placeIds = new Set(places.map((place) => place.id));
const AESOP = '2ca3aec0-e67f-4199-99f4-a98ef0cefb79';
const RENTOKIL = 'c2e77fb3-9236-46d0-9d0a-d14cacee4001';
const BURBERRY = '051caae6-ac27-4026-9575-80745afd0c18';
const HM = '7656c392-09ae-4f4d-ba3f-263c227eb638';
const HM_TWO = 'b04e2226-2589-474d-9dba-91e6d4358a63';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-website-checks-'));
  db = openDatabase(path.join(dir, DATABASE_FILE));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function sampleReport(): unknown {
  return JSON.parse(fs.readFileSync(REPORT, 'utf8')) as unknown;
}

describe('website flag for a finding', () => {
  it('flags harmful, redirecting and parked websites, marks weak warnings low-confidence and leaves the rest alone', () => {
    expect(Object.fromEntries(WebsiteFinding.options.map((finding) => [finding, websiteFlagFor(finding)]))).toEqual({
      harmful_redirect: 'harmful', data_theft: 'harmful', feed_listed: 'harmful',
      unrelated_redirect: 'suspicious', parked: 'parked',
      other_warning: 'unconfirmed', brand_mismatch: 'unconfirmed',
      none: null, not_checked: null,
    });
  });

  it('has the exact contract label for each flag on the dashboard, and plain words for each finding', () => {
    expect(VIEW_FLAG_LABELS).toEqual(WEBSITE_FLAG_LABELS);
    expect(Object.keys(WEBSITE_FINDING_TEXT).sort()).toEqual([...WebsiteFinding.options].sort());
    expect(WEBSITE_FINDING_TEXT.harmful_redirect).toContain("This listing's website now leads to an online gambling site");
    expect(WEBSITE_FINDING_TEXT.parked).toContain("The website's domain has expired and is parked for sale");
  });

  it('defangs an address so it can never be followed', () => {
    expect(defangUrl('https://win-big-casino.test/landing?ref=lapsed')).toBe('hxxps://win-big-casino[.]test/landing?ref=lapsed');
    expect(defangUrl('HTTP://a.example')).toBe('hxxp://a[.]example');
  });
});

describe('website checks report validation', () => {
  it('accepts the synthetic report from the website shield', () => {
    const { report, sha256 } = readWebsiteChecks(REPORT);
    expect(report.records).toHaveLength(6);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names the first bad field and imports nothing of a bad report', () => {
    const bad = sampleReport() as { records: Array<Record<string, unknown>> };
    bad.records[1]!.decision = 'quarantine';
    expect(() => parseWebsiteChecks(bad)).toThrow('website_checks_invalid:records.1.decision');
    const noGenerator = sampleReport() as Record<string, unknown>;
    delete noGenerator.generator;
    expect(() => parseWebsiteChecks(noGenerator)).toThrow('website_checks_invalid:generator');
  });

  it('refuses a report of an unknown format', () => {
    const other = sampleReport() as Record<string, unknown>;
    other.format = 'mirsad-places-website-checks/2';
    expect(() => parseWebsiteChecks(other)).toThrow('website_checks_format_unknown');
    expect(() => parseWebsiteChecks({ records: [] })).toThrow('website_checks_format_unknown');
    expect(() => parseWebsiteChecks([])).toThrow('website_checks_format_unknown');
  });

  it('refuses a record without the portal place id', () => {
    const bad = sampleReport() as { records: Array<Record<string, unknown>> };
    delete bad.records[0]!.place_id;
    expect(() => parseWebsiteChecks(bad)).toThrow('website_checks_invalid:records.0.place_id');
  });

  it('refuses an unreadable file', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ not json');
    expect(() => readWebsiteChecks(file)).toThrow('website_checks_unreadable');
  });
});

describe('website check import', () => {
  it('stores each website check, counts flags and skips unknown place ids', () => {
    const report = parseWebsiteChecks(sampleReport());
    const result = importWebsiteChecks(db, report, placeIds, { reportSha256: 'a'.repeat(64) });
    expect(result).toEqual({
      records: 6, places: 5, checks: 6, replaced: 0,
      flagged: { harmful: 1, suspicious: 1, parked: 1, unconfirmed: 1 },
      unknownPlaceIds: ['00000000-0000-4000-8000-00000000dead'],
    });
    expect(Object.fromEntries(readWebsiteFlags(db))).toEqual({
      [AESOP]: 'harmful', [RENTOKIL]: 'parked', [BURBERRY]: 'suspicious', [HM]: 'unconfirmed',
    });
  });

  it('replaces on re-import, so importing the same report twice changes nothing', () => {
    const report = parseWebsiteChecks(sampleReport());
    importWebsiteChecks(db, report, placeIds, { reportSha256: 'a'.repeat(64) });
    const again = importWebsiteChecks(db, report, placeIds, { reportSha256: 'a'.repeat(64) });
    expect(again.replaced).toBe(5);
    const count = db.transaction((tx) => tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM place_website_checks'));
    expect(count?.n).toBe(6);

    // A later report that finds the site fixed clears that listing's flag; listings it does not mention keep theirs.
    const fixed = parseWebsiteChecks({
      format: 'mirsad-places-website-checks/1', generator: 'test', generated_at: '2026-11-25T00:00:00Z',
      records: [{ ...report.records[0]!, decision: 'allow', category: 'none', websites: [] }],
    });
    importWebsiteChecks(db, fixed, placeIds, { reportSha256: 'b'.repeat(64) });
    expect(Object.fromEntries(readWebsiteFlags(db))).toEqual({ [RENTOKIL]: 'parked', [BURBERRY]: 'suspicious', [HM]: 'unconfirmed' });
  });

  it('writes nothing in a dry run but reports the same counts', () => {
    const report = parseWebsiteChecks(sampleReport());
    const result = importWebsiteChecks(db, report, placeIds, { reportSha256: 'a'.repeat(64), dryRun: true });
    expect(result.checks).toBe(6);
    expect(readWebsiteFlags(db).size).toBe(0);
  });

  it('reads the most serious website of a listing for the details panel', () => {
    importWebsiteChecks(db, parseWebsiteChecks(sampleReport()), placeIds, { reportSha256: 'a'.repeat(64) });
    const parked = readWebsiteCheck(db, RENTOKIL);
    expect(parked).toMatchObject({
      website: 'https://closed-service.example/', decision: 'warn', riskScore: 58, finding: 'parked', flag: 'parked',
      findingEn: "Domain expired or parked for sale: not the business's website any more",
      finalUrl: 'https://domain-market.test/buy/closed-service.example', evidenceRef: 'SS-1B2C3D4E',
      checkedAt: '2026-11-24T09:02:30Z',
    });
    expect(parked?.reasons[0]).toEqual({ code: 'page.parked', en: 'The domain is parked and offered for sale', ar: 'النطاق متوقف ومعروض للبيع' });
    expect(readWebsiteCheck(db, HM_TWO)).toMatchObject({ decision: 'allow', flag: null, finding: 'none' });
    expect(readWebsiteCheck(db, 'not-a-listing')).toBeNull();
  });

  it('runs as the operator command against a data directory and prints counts only', () => {
    fs.copyFileSync(SAMPLE, path.join(dir, PLACES_FILE));
    const result = runImport(dir, REPORT, false);
    const text = describeImport(result, false);
    expect(text).toContain('Stored 6 website checks for 5 listings (0 replaced an earlier import).');
    expect(text).toContain('Flagged listings: 1 harmful, 1 redirecting elsewhere, 1 expired or parked; 1 low-confidence warnings.');
    expect(text).toContain('Skipped 1 listings not in the Places directory: 00000000-0000-4000-8000-00000000dead.');
    expect(text).not.toContain('Synthetic listing');
    expect(text).not.toContain('.example');
    expect(describeImport(runImport(dir, REPORT, true), true)).toMatch(/^Dry run, nothing written\./);
    expect(() => runImport(path.join(dir, 'missing'), REPORT, false)).toThrow('live_database_missing');
  });
});

describe('places search by website flag', () => {
  const flags = new Map([[AESOP, 'harmful'], [RENTOKIL, 'parked'], [BURBERRY, 'suspicious'], [HM, 'unconfirmed']] as const);

  it('returns only flagged listings, of one kind or any but the low-confidence ones', () => {
    const any = searchPlaces(places, { websiteFlag: 'flagged', websiteFlags: flags });
    expect(any.items.map((place) => place.id).sort()).toEqual([AESOP, BURBERRY, RENTOKIL].sort());
    const parked = searchPlaces(places, { websiteFlag: 'parked', websiteFlags: flags });
    expect(parked.items.map((place) => place.id)).toEqual([RENTOKIL]);
    expect(parked.websiteFlags).toEqual({ [RENTOKIL]: 'parked' });
    expect(searchPlaces(places, { websiteFlag: 'unconfirmed', websiteFlags: flags }).items.map((place) => place.id)).toEqual([HM]);
  });

  it('counts flags over the search, not the viewport or the flag filter', () => {
    const page = searchPlaces(places, { websiteFlag: 'harmful', websiteFlags: flags, bbox: [0, 0, 1, 1] });
    expect(page.total).toBe(0);
    expect(page.websiteFlagCounts).toEqual({ harmful: 1, suspicious: 1, parked: 1, unconfirmed: 1 });
    expect(PlacesSearchResponse.safeParse({
      places: page.items, nextCursor: page.nextCursor, categories: page.categories,
      websiteFlags: page.websiteFlags, websiteFlagCounts: page.websiteFlagCounts,
    }).success).toBe(true);
  });

  it('puts flagged listings first, most serious first, so a capped page keeps them on the map', () => {
    const page = searchPlaces(places, { websiteFlags: flags, limit: 3 });
    expect(page.items.map((place) => place.id)).toEqual([AESOP, BURBERRY, RENTOKIL]);
    expect(page.total).toBe(5);
  });

  it('marks nothing without an imported report', () => {
    const page = searchPlaces(places, {});
    expect(page.items).toHaveLength(5);
    expect(page.websiteFlags).toEqual({});
    expect(page.websiteFlagCounts).toEqual({ harmful: 0, suspicious: 0, parked: 0, unconfirmed: 0 });
  });
});
