/**
 * Website checks of Places listings: the import of a Places website checks report from Mirsad's website shield
 * (mirsad-gateway/scripts/check_places_websites.py, format `mirsad-places-website-checks/1`) and the reads the map
 * needs. The portal only reads the report file; it never visits the websites.
 */
import { z } from 'zod';
import {
  WebsiteFinding, type PlaceWebsiteCheck, type WebsiteFlag, type WebsiteFlagCounts,
} from '../contract/schemas.ts';
import type { Db, Tx } from '../storage/db.ts';

/** The one report format this portal reads; any other is refused rather than guessed at. */
export const WEBSITE_CHECKS_FORMAT = 'mirsad-places-website-checks/1';

const Reason = z.object({
  code: z.string().max(120).nullable().transform((code) => code ?? ''),
  en: z.string().max(500),
  ar: z.string().max(500),
});

const CheckedAt = z.string().max(64).refine((text) => !Number.isNaN(Date.parse(text)), { message: 'Expected a date-time.' });

/** One website's result, as the report keeps it under a record's `websites`. Unlisted fields are ignored. */
const ReportWebsite = z.object({
  website: z.string().min(1).max(2000),
  host: z.string().max(300).nullable(),
  decision: z.enum(['allow', 'warn', 'block']).nullable(),
  risk_score: z.number().min(0).max(100).nullable(),
  category: WebsiteFinding,
  finding_en: z.string().max(500),
  finding_ar: z.string().max(500),
  reasons: z.array(Reason).max(10),
  final_url: z.string().max(2000).nullable(),
  evidence_ref: z.string().max(64).nullable(),
  checked_at: CheckedAt.nullable(),
});
type ReportWebsite = z.infer<typeof ReportWebsite>;

/** One listing of the report. The headline fields are its most serious website; `websites` holds each of them. */
const ReportRecord = ReportWebsite.extend({
  place_id: z.string().min(1).max(200),
  website: z.string().min(1).max(2000).nullable(),
  websites: z.array(ReportWebsite).max(50).default([]),
});

export const WebsiteChecksReport = z.object({
  format: z.literal(WEBSITE_CHECKS_FORMAT),
  generator: z.string().max(200),
  generated_at: z.string().max(64),
  records: z.array(ReportRecord).max(100_000),
});
export type WebsiteChecksReport = z.infer<typeof WebsiteChecksReport>;

/**
 * Validates a parsed report. A missing or different `format` is `website_checks_format_unknown`; otherwise the error
 * names the first bad field (`records.12.decision`). Nothing of a report that fails is imported.
 */
export function parseWebsiteChecks(raw: unknown): WebsiteChecksReport {
  const format = typeof raw === 'object' && raw !== null ? (raw as { format?: unknown }).format : undefined;
  if (format !== WEBSITE_CHECKS_FORMAT) throw new Error('website_checks_format_unknown');
  const parsed = WebsiteChecksReport.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`website_checks_invalid:${issue?.path.join('.') ?? ''}`);
  }
  return parsed.data;
}

const FINDING_FLAGS: Record<WebsiteFinding, WebsiteFlag | null> = {
  harmful_redirect: 'harmful',
  data_theft: 'harmful',
  feed_listed: 'harmful',
  unrelated_redirect: 'suspicious',
  parked: 'parked',
  other_warning: 'unconfirmed',
  brand_mismatch: 'unconfirmed',
  none: null,
  not_checked: null,
};

/**
 * The map's flag for a website shield finding: a taken-over domain leading to gambling or other harmful content, a
 * data-theft script and a phishing feed listing are `harmful`; a re-registered name redirecting to an unrelated site is
 * `suspicious`; an expired or parked domain is `parked`. Other warnings and possible brand imitations are
 * `unconfirmed` (low confidence). No finding and a site that was not checked are no flag.
 */
export function websiteFlagFor(finding: WebsiteFinding): WebsiteFlag | null {
  return FINDING_FLAGS[finding];
}

const FLAG_RANK: Record<WebsiteFlag, number> = { harmful: 4, suspicious: 3, parked: 2, unconfirmed: 1 };
const DECISION_RANK: Record<string, number> = { block: 3, warn: 2, allow: 1 };

export interface WebsiteImportResult {
  /** Listings in the report. */
  records: number;
  /** Listings whose checks were stored (or would be, in a dry run). */
  places: number;
  /** Website checks stored. */
  checks: number;
  /** Listings per flag, by their most serious website. */
  flagged: WebsiteFlagCounts;
  /** Report place ids that are not in the directory; skipped. */
  unknownPlaceIds: string[];
  /** Listings that had checks from an earlier import, now replaced. */
  replaced: number;
}

interface CheckRow {
  place_id: string;
  website: string;
  host: string | null;
  decision: 'allow' | 'warn' | 'block' | null;
  risk_score: number | null;
  finding: WebsiteFinding;
  finding_en: string;
  finding_ar: string;
  flag: WebsiteFlag | null;
  reasons: string;
  final_url: string | null;
  evidence_ref: string | null;
  checked_at: string | null;
  imported_at: string;
}

/** The website checks of one record: each of its websites, or the headline alone for a record without `websites`. */
function websitesOf(record: z.infer<typeof ReportRecord>): ReportWebsite[] {
  if (record.websites.length > 0) return record.websites;
  return record.website === null ? [] : [{ ...record, website: record.website }];
}

function mostSerious(flags: readonly (WebsiteFlag | null)[]): WebsiteFlag | null {
  let worst: WebsiteFlag | null = null;
  for (const flag of flags) if (flag !== null && (worst === null || FLAG_RANK[flag] > FLAG_RANK[worst])) worst = flag;
  return worst;
}

/**
 * Stores the report's checks, replacing every earlier check of each listing it covers (a re-import of the same report
 * changes nothing). Listings the report does not mention keep their checks. Unknown place ids are skipped and named.
 * `dryRun` validates and counts without writing.
 */
export function importWebsiteChecks(
  db: Db,
  report: WebsiteChecksReport,
  placeIds: ReadonlySet<string>,
  options: { reportSha256: string; dryRun?: boolean },
): WebsiteImportResult {
  const unknown = new Set<string>();
  const known = new Map<string, ReportWebsite[]>();
  for (const record of report.records) {
    if (!placeIds.has(record.place_id)) unknown.add(record.place_id);
    else known.set(record.place_id, [...(known.get(record.place_id) ?? []), ...websitesOf(record)]);
  }
  const flagged: WebsiteFlagCounts = { harmful: 0, suspicious: 0, parked: 0, unconfirmed: 0 };
  let checks = 0;
  for (const websites of known.values()) {
    const worst = mostSerious(websites.map((site) => websiteFlagFor(site.category)));
    if (worst !== null) flagged[worst] += 1;
    checks += new Set(websites.map((site) => site.website)).size;
  }
  const result = { records: report.records.length, places: known.size, checks, flagged, unknownPlaceIds: [...unknown].sort() };
  return db.transaction((tx) => {
    let replaced = 0;
    for (const [placeId, websites] of known) {
      if (tx.get('SELECT 1 AS found FROM place_website_checks WHERE place_id = ? LIMIT 1', [placeId])) replaced += 1;
      if (options.dryRun) continue;
      tx.run('DELETE FROM place_website_checks WHERE place_id = ?', [placeId]);
      for (const site of websites) {
        tx.run(
          `INSERT OR REPLACE INTO place_website_checks (place_id, website, host, decision, risk_score, finding, finding_en,
             finding_ar, flag, reasons, final_url, evidence_ref, checked_at, report_sha256, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [placeId, site.website, site.host, site.decision, site.risk_score, site.category, site.finding_en,
            site.finding_ar, websiteFlagFor(site.category), JSON.stringify(site.reasons), site.final_url,
            site.evidence_ref, site.checked_at, options.reportSha256, tx.now()],
        );
      }
    }
    return { ...result, replaced };
  });
}

/** Each flagged listing's most serious flag; the map marks its dot from this. */
export function readWebsiteFlags(db: Db): Map<string, WebsiteFlag> {
  const rows = db.transaction((tx: Tx) =>
    tx.all<{ place_id: string; flag: WebsiteFlag }>('SELECT place_id, flag FROM place_website_checks WHERE flag IS NOT NULL'));
  const byPlace = new Map<string, WebsiteFlag>();
  for (const row of rows) {
    const current = byPlace.get(row.place_id);
    if (current === undefined || FLAG_RANK[row.flag] > FLAG_RANK[current]) byPlace.set(row.place_id, row.flag);
  }
  return byPlace;
}

/** Orders a listing's checks: flag, then decision, then risk, most serious first. */
function severity(row: CheckRow): number {
  return (row.flag === null ? 0 : FLAG_RANK[row.flag]) * 10_000 + (DECISION_RANK[row.decision ?? ''] ?? 0) * 1_000 + (row.risk_score ?? 0);
}

/** The listing's most serious website check, or null when no report covered it. */
export function readWebsiteCheck(db: Db, placeId: string): PlaceWebsiteCheck | null {
  const rows = db.transaction((tx: Tx) =>
    tx.all<CheckRow>('SELECT * FROM place_website_checks WHERE place_id = ? ORDER BY website', [placeId]));
  const worst = rows.reduce<CheckRow | null>((best, row) => (best === null || severity(row) > severity(best) ? row : best), null);
  if (worst === null) return null;
  return {
    website: worst.website,
    host: worst.host,
    decision: worst.decision,
    riskScore: worst.risk_score,
    finding: worst.finding,
    findingEn: worst.finding_en,
    findingAr: worst.finding_ar,
    flag: worst.flag,
    reasons: JSON.parse(worst.reasons) as PlaceWebsiteCheck['reasons'],
    finalUrl: worst.final_url,
    evidenceRef: worst.evidence_ref,
    checkedAt: worst.checked_at,
    importedAt: worst.imported_at,
  };
}
