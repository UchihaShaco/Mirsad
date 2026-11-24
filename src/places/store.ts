/** Places directory: file loading and officer search over the Overture JSON. */
import fs from 'node:fs';
import { PlaceRecord as PlaceRecordSchema, type PlaceRecord as PlaceRecordShape } from '../contract/schemas.ts';

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
}

export interface PlacesPage {
  items: PlaceRecord[];
  nextCursor: string | null;
  total: number;
  /** Offset of the first item in the match order; mirrors the opaque cursor for honest meta reporting. */
  offset: number;
  /** Distinct categories of the whole match set (not just the page), sorted, for the filter dropdown. */
  categories: string[];
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

/** Matches name, category and description (case-insensitive substring). Address and phones are not searched. */
function matchesText(place: PlaceRecord, needle: string): boolean {
  if (needle === '') return true;
  const hay = `${place.name} ${place.category} ${place.description}`.toLowerCase();
  return hay.includes(needle);
}

/** Bounding-box test. Crossing boxes (min > max) never match: viewports here do not cross the antimeridian. */
function matchesBbox(place: PlaceRecord, bbox: [number, number, number, number] | undefined, bboxOk: boolean): boolean {
  if (bbox === undefined) return true;
  if (!bboxOk) return false;
  return place.lng >= bbox[0] && place.lng <= bbox[2] && place.lat >= bbox[1] && place.lat <= bbox[3];
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

  const matched = places.filter(
    (place) => (category === '' || place.category === category) && matchesText(place, needle) && matchesBbox(place, bbox, bboxOk),
  );
  const categories = [...new Set(matched.map((place) => place.category))].sort();

  const offset = decodeCursor(query.cursor);
  const items = matched.slice(offset, offset + limit);
  const next = offset + limit < matched.length ? encodeCursor(offset + limit) : null;
  return { items, nextCursor: next, total: matched.length, offset, categories };
}
