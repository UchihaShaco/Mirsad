/**
 * Places directory (design section 6, officer lookup for the Abu Dhabi map):
 * GET /v1/places/search pages the in-memory directory by text, category and map
 * viewport, and GET /v1/places/{placeId} returns one place for the details panel. Both carry the website checks
 * imported from Mirsad's website shield (scripts/import-website-checks.ts): a flag per listing on the map, the check
 * itself in the panel.
 */
import { AppError, ok } from '../../contract/errors.ts';
import { PlacesSearchQuery } from '../../contract/schemas.ts';
import { searchPlaces } from '../../places/store.ts';
import { readWebsiteCheck, readWebsiteFlags } from '../../places/website-checks.ts';
import { principalOf, type RouteModule } from '../context.ts';
import { parseQuery } from '../middleware/validate.ts';

/** Parses minLng,minLat,maxLng,maxLat; anything else is a 400 with the field named. */
function parseBbox(raw: string | undefined): [number, number, number, number] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((part) => Number(part.trim()));
  const [minLng, minLat, maxLng, maxLat] = parts;
  const valid =
    parts.length === 4 &&
    minLng !== undefined && minLat !== undefined && maxLng !== undefined && maxLat !== undefined &&
    parts.every((n) => Number.isFinite(n)) && minLng <= maxLng && minLat <= maxLat;
  if (!valid || minLng === undefined || minLat === undefined || maxLng === undefined || maxLat === undefined) {
    throw AppError.of('validation_failed', 'bbox must be minLng,minLat,maxLng,maxLat.', {
      fields: [{ path: 'bbox', message: 'Expected four comma-separated numbers with min <= max.' }],
    });
  }
  return [minLng, minLat, maxLng, maxLat];
}

export const routes: RouteModule = {
  'GET /v1/places/search': (c, deps) => {
    principalOf(c);
    const query = parseQuery(c, PlacesSearchQuery);
    const { items, nextCursor, total, offset, categories, websiteFlags, websiteFlagCounts } = searchPlaces(deps.places, {
      q: query.q,
      category: query.category,
      bbox: parseBbox(query.bbox),
      websiteFlag: query.websiteFlag,
      websiteFlags: readWebsiteFlags(deps.db),
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
    return c.json(ok(
      { places: items, nextCursor, categories, websiteFlags, websiteFlagCounts },
      { total, limit: query.limit, offset },
    ));
  },
  'GET /v1/places/{placeId}': (c, deps) => {
    principalOf(c);
    const placeId = c.req.param('placeId') ?? '';
    const place = deps.places.find((entry) => entry.id === placeId);
    if (!place) throw AppError.of('not_found', 'No such place in the directory.');
    return c.json(ok({ place, websiteCheck: readWebsiteCheck(deps.db, place.id) }));
  },
};
