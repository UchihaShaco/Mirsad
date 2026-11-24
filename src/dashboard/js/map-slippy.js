/**
 * Pure Web-Mercator tile math for the officer places map. No DOM here so the
 * geometry stays unit-testable; the view in views/places-map.js does the drawing.
 */

export const TILE_SIZE = 256;
export const MAX_LAT = 85.05112878;

export function clampLat(lat) {
  return Math.min(MAX_LAT, Math.max(-MAX_LAT, lat));
}

export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Global pixel coordinates of a lon/lat at a zoom (fractional). */
export function project(lon, lat, zoom) {
  const clamped = clampLat(lat);
  const scale = TILE_SIZE * 2 ** zoom;
  const x = ((wrapLon(lon) + 180) / 360) * scale;
  const radians = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale;
  return { x, y };
}

/** Inverse of project. */
export function unproject(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI * (1 - (2 * y) / scale);
  const lat = (Math.atan((Math.exp(n) - Math.exp(-n)) / 2) * 180) / Math.PI;
  return { lon: wrapLon(lon), lat: clampLat(lat) };
}

/**
 * Tiles covering a w by h viewport centered on centerLon/centerLat.
 * Returns { x, y, left, top } with left/top relative to the viewport origin;
 * x wraps around the antimeridian, y is clamped to the tile grid.
 */
export function tilesForView(centerLon, centerLat, zoom, width, height) {
  const scale = TILE_SIZE * 2 ** zoom;
  const center = project(centerLon, centerLat, zoom);
  const left = center.x - width / 2;
  const top = center.y - height / 2;
  const fromX = Math.floor(left / TILE_SIZE);
  const toX = Math.floor((left + width - 1) / TILE_SIZE);
  const fromY = Math.floor(top / TILE_SIZE);
  const toY = Math.floor((top + height - 1) / TILE_SIZE);
  const edge = 2 ** zoom;
  const tiles = [];
  for (let x = fromX; x <= toX; x += 1) {
    for (let y = fromY; y <= toY; y += 1) {
      if (y < 0 || y >= edge) continue;
      tiles.push({ x: ((x % edge) + edge) % edge, y, left: x * TILE_SIZE - left, top: y * TILE_SIZE - top });
    }
  }
  return tiles;
}

/**
 * Geographic bbox [minLng, minLat, maxLng, maxLat] of the current viewport.
 * Assumes a viewport that does not cross the antimeridian (true for Abu Dhabi):
 * longitudes are clamped, never wrapped, so a crossing box can never be produced here.
 */
export function bboxForView(centerLon, centerLat, zoom, width, height) {
  const center = project(centerLon, centerLat, zoom);
  const southEast = unproject(center.x + width / 2, center.y + height / 2, zoom);
  const northWest = unproject(center.x - width / 2, center.y - height / 2, zoom);
  const minLng = Math.max(-180, Math.min(northWest.lon, southEast.lon));
  const maxLng = Math.min(180, Math.max(northWest.lon, southEast.lon));
  return [minLng, Math.max(-MAX_LAT, Math.min(northWest.lat, southEast.lat)), maxLng, Math.min(MAX_LAT, Math.max(northWest.lat, southEast.lat))];
}
