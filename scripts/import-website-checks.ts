/**
 * Local operator command: imports a Places website checks report from Mirsad's website shield
 * (mirsad-gateway/scripts/check_places_websites.py, format mirsad-places-website-checks/1) into the portal database, so the Places map flags the listings
 * whose website was found harmful, parked or suspicious. Reads the report file only; nothing here visits a website.
 * Prints counts, never business names or websites.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { PLACES_FILE, loadPlaces } from '../src/places/store.ts';
import { importWebsiteChecks, parseWebsiteChecks, type WebsiteImportResult } from '../src/places/website-checks.ts';
import { DATABASE_FILE, openDatabase } from '../src/storage/db.ts';
import { isEntryPoint, loadDotEnvIfPresent } from './entry-point.ts';

export const USAGE = 'Usage: npm run places:import-checks -- [--dry-run] <website-checks.json>\n';

/**
 * Reads, hashes and validates the report file; throws `website_checks_unreadable`, `website_checks_format_unknown` or
 * `website_checks_invalid:<path>`.
 */
export function readWebsiteChecks(file: string): { report: ReturnType<typeof parseWebsiteChecks>; sha256: string } {
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = fs.readFileSync(file);
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('website_checks_unreadable');
  }
  return { report: parseWebsiteChecks(raw), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** The printed summary: counts only. */
export function describeImport(result: WebsiteImportResult, dryRun: boolean): string {
  const lines = [
    `${dryRun ? 'Dry run, nothing written. ' : ''}Listings in the report: ${result.records}.`,
    `${dryRun ? 'Would store' : 'Stored'} ${result.checks} website checks for ${result.places} listings` +
      ` (${result.replaced} replaced an earlier import).`,
    `Flagged listings: ${result.flagged.harmful} harmful, ${result.flagged.suspicious} redirecting elsewhere,` +
      ` ${result.flagged.parked} expired or parked; ${result.flagged.unconfirmed} low-confidence warnings.`,
  ];
  if (result.unknownPlaceIds.length > 0) {
    const shown = result.unknownPlaceIds.slice(0, 10).join(', ');
    const more = result.unknownPlaceIds.length > 10 ? ` and ${result.unknownPlaceIds.length - 10} more` : '';
    lines.push(`Skipped ${result.unknownPlaceIds.length} listings not in the Places directory: ${shown}${more}.`);
  }
  return `${lines.join('\n')}\n`;
}

/** Imports `reportFile` into the portal under `dataDir` (its database and places file must exist). */
export function runImport(dataDir: string, reportFile: string, dryRun: boolean): WebsiteImportResult {
  const dbFile = path.join(dataDir, DATABASE_FILE);
  const placesFile = path.join(dataDir, PLACES_FILE);
  if (!fs.existsSync(dbFile)) throw new Error('live_database_missing');
  if (!fs.existsSync(placesFile)) throw new Error('places_file_missing');
  const { report, sha256 } = readWebsiteChecks(reportFile);
  const placeIds = new Set(loadPlaces(placesFile).map((place) => place.id));
  const db = openDatabase(dbFile);
  try {
    return importWebsiteChecks(db, report, placeIds, { reportSha256: sha256, dryRun });
  } finally {
    db.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((arg) => arg !== '--dry-run');
  const [file] = files;
  if (!file || files.length !== 1 || file.startsWith('-')) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  loadDotEnvIfPresent();
  const result = runImport(loadConfig(process.env).dataDir, path.resolve(file), dryRun);
  process.stdout.write(describeImport(result, dryRun));
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const known = /^(website_checks_.*|live_database_missing|places_.*)$/;
    process.stderr.write(`Website check import failed (${known.test(message) ? message : 'import_failed'}).\n`);
    process.exitCode = 1;
  }
}
