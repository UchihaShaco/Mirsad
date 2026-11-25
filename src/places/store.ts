/** Places directory: file loading and officer search over the Overture JSON. */
import fs from 'node:fs';
import {
  PlaceRecord as PlaceRecordSchema, type PlaceRecord as PlaceRecordShape, type WebsiteFlag, type WebsiteFlagCounts,
} from '../contract/schemas.ts';

export const PlaceRecord = PlaceRecordSchema;
export type PlaceRecord = PlaceRecordShape;

export const PLACES_PAGE_MAX = 200;
export const PLACES_FILE = 'places-abu-dhabi.json';

/**
 * Reads and validates a places JSON file; throws on unreadable files or bad records.
 * The error names the file and the record index so the operator can repair the data.
 */
export function loadPlaces(filePath: string): PlaceRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    throw new Error(`places_file_unreadable:${filePath}`);
  }
  if (!Array.isArray(raw)) throw new Error(`places_file_not_array:${filePath}`);
  return raw.map((entry, index) => {
    const parsed = PlaceRecord.safeParse(entry);
    if (!parsed.success) throw new Error(`places_record_invalid:${filePath}#${index}`);
    return parsed.data;
  });
}

export interface PlacesQuery {
  q?: string;
  category?: string;
  /** [minLng, minLat, maxLng, maxLat] of the visible map area. */
  bbox?: [number, number, number, number];
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
  /** Only listings whose website was flagged: harmful, suspicious or parked (`flagged`), or one kind. */
  websiteFlag?: WebsiteFlag | 'flagged';
  /** Each flagged listing's website flag (website-checks.ts, readWebsiteFlags); none when no report was imported. */
  websiteFlags?: ReadonlyMap<string, WebsiteFlag>;
}

export interface PlacesPage {
  items: PlaceRecord[];
  nextCursor: string | null;
  total: number;
  /** Offset of the first item in the match order; mirrors the opaque cursor for honest meta reporting. */
  offset: number;
  /** Distinct categories of the whole match set (not just the page), sorted, for the filter dropdown. */
  categories: string[];
  /** The website flag of each place on this page that has one. */
  websiteFlags: Record<string, WebsiteFlag>;
  /** Flagged listings per kind for the text and category match, before the viewport and the flag filter. */
  websiteFlagCounts: WebsiteFlagCounts;
}

/**
 * Decodes an opaque page cursor. Cursors are server-minted base64url offsets; anything else
 * (garbage, out-of-range, hand-crafted) restarts at the first page rather than failing.
 */
function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

/**
 * The national significant number of a UAE-style number, else all its digits: +971 2 642 9176, 00971 2 642 9176 and
 * 02 642 9176 all become 26429176. Lets an officer check a number however the evidence wrote it.
 */
export function nationalNumber(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('971')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/** A website's host without www., from a URL or a bare domain; null when the text is not one. */
export function hostOf(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (text === '' || /\s/.test(text) || !text.includes('.')) return null;
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const PHONE_TEXT = /^[+\d\s().\/-]+$/;

/**
 * Matches name, category and description (case-insensitive substring). A query that is a phone number (7 or more
 * digits) also matches a listed phone with the same national number, and a domain or URL matches a listed website on
 * that host or under it, so an officer can ask "whose number, whose site is this?". Addresses are not searched.
 */
function matchesText(place: PlaceRecord, needle: string): boolean {
  if (needle === '') return true;
  const hay = `${place.name} ${place.category} ${place.description}`.toLowerCase();
  if (hay.includes(needle)) return true;
  if (PHONE_TEXT.test(needle)) {
    const wanted = nationalNumber(needle);
    if (wanted.length >= 7 && place.phones.some((phone) => nationalNumber(phone) === wanted)) return true;
  }
  const host = hostOf(needle);
  if (host !== null && !PHONE_TEXT.test(needle)) {
    return place.urls.some((url) => {
      const listed = hostOf(url);
      return listed !== null && (listed === host || host.endsWith(`.${listed}`));
    });
  }
  return false;
}

/** Bounding-box test. Crossing boxes (min > max) never match: viewports here do not cross the antimeridian. */
function matchesBbox(place: PlaceRecord, bbox: [number, number, number, number] | undefined, bboxOk: boolean): boolean {
  if (bbox === undefined) return true;
  if (!bboxOk) return false;
  return place.lng >= bbox[0] && place.lng <= bbox[2] && place.lat >= bbox[1] && place.lat <= bbox[3];
}

const FLAG_ORDER: Record<WebsiteFlag, number> = { harmful: 4, suspicious: 3, parked: 2, unconfirmed: 1 };

function flagOrder(flag: WebsiteFlag | undefined): number {
  return flag === undefined ? 0 : FLAG_ORDER[flag];
}

/** `flagged` is every flag but a low-confidence warning, which an officer asks for by name. */
function flagMatches(flag: WebsiteFlag | undefined, wanted: WebsiteFlag | 'flagged'): boolean {
  if (flag === undefined) return false;
  return wanted === 'flagged' ? flag !== 'unconfirmed' : flag === wanted;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** Filters the in-memory directory; the map calls this per viewport through the search endpoint. */
export function searchPlaces(places: readonly PlaceRecord[], query: PlacesQuery): PlacesPage {
  const needle = query.q?.trim().toLowerCase() ?? '';
  const category = query.category?.trim() ?? '';
  const bbox = query.bbox;
  const bboxOk =
    bbox !== undefined &&
    bbox.length === 4 &&
    bbox.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    bbox[0] <= bbox[2] &&
    bbox[1] <= bbox[3];
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), PLACES_PAGE_MAX);

  const flags = query.websiteFlags ?? new Map<string, WebsiteFlag>();
  const wanted = query.websiteFlag;
  const websiteFlagCounts: WebsiteFlagCounts = { harmful: 0, suspicious: 0, parked: 0, unconfirmed: 0 };
  const matched = places.filter((place) => {
    if ((category !== '' && place.category !== category) || !matchesText(place, needle)) return false;
    const flag = flags.get(place.id);
    if (flag !== undefined) websiteFlagCounts[flag] += 1;
    if (wanted !== undefined && !flagMatches(flag, wanted)) return false;
    return matchesBbox(place, bbox, bboxOk);
  });
  // Flagged listings first, most serious first (the sort is stable), so a capped page never hides them from the map.
  if (flags.size > 0) matched.sort((a, b) => flagOrder(flags.get(b.id)) - flagOrder(flags.get(a.id)));
  const categories = [...new Set(matched.map((place) => place.category))].sort();

  const offset = decodeCursor(query.cursor);
  const items = matched.slice(offset, offset + limit);
  const next = offset + limit < matched.length ? encodeCursor(offset + limit) : null;
  const websiteFlags: Record<string, WebsiteFlag> = {};
  for (const place of items) {
    const flag = flags.get(place.id);
    if (flag !== undefined) websiteFlags[place.id] = flag;
  }
  return { items, nextCursor: next, total: matched.length, offset, categories, websiteFlags, websiteFlagCounts };
}
