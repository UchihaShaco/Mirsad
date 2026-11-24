/** Pure Web-Mercator tile math for the officer places map (no DOM, unit-testable). */
import { describe, expect, it } from 'vitest';
import { bboxForView, project, tilesForView, unproject } from '../../src/dashboard/js/map-slippy.js';

describe('slippy map math', () => {
  it('centers the world at zoom 0', () => {
    const point = project(0, 0, 0);
    expect(point.x).toBe(128);
    expect(point.y).toBe(128);
    const back = unproject(point.x, point.y, 0);
    expect(back.lon).toBeCloseTo(0, 6);
    expect(back.lat).toBeCloseTo(0, 6);
  });

  it('round-trips Abu Dhabi through project and unproject', () => {
    for (const zoom of [10, 12, 15, 18]) {
      const point = project(54.375, 24.45, zoom);
      const back = unproject(point.x, point.y, zoom);
      expect(back.lon).toBeCloseTo(54.375, 6);
      expect(back.lat).toBeCloseTo(24.45, 6);
    }
  });

  it('covers the viewport with whole tiles', () => {
    const tiles = tilesForView(54.375, 24.45, 12, 800, 600);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(40);
    for (const tile of tiles) {
      expect(Number.isInteger(tile.x)).toBe(true);
      expect(Number.isInteger(tile.y)).toBe(true);
      const edge = 2 ** 12;
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(edge);
      expect(((tile.x % edge) + edge) % edge).toBe(tile.x);
    }
    // The center tile holds the center point.
    const center = tiles.find((tile) => tile.left <= 400 && 400 < tile.left + 256 && tile.top <= 300 && 300 < tile.top + 256);
    expect(center).toBeDefined();
  });

  it('produces a sane, non-crossing bbox around Abu Dhabi', () => {
    const [minLng, minLat, maxLng, maxLat] = bboxForView(54.375, 24.45, 12, 800, 600);
    expect(minLng).toBeLessThan(54.375);
    expect(maxLng).toBeGreaterThan(54.375);
    expect(minLat).toBeLessThan(24.45);
    expect(maxLat).toBeGreaterThan(24.45);
    expect(minLng).toBeGreaterThanOrEqual(-180);
    expect(maxLng).toBeLessThanOrEqual(180);
    expect(maxLng).toBeGreaterThan(minLng);
    expect(maxLat).toBeGreaterThan(minLat);
  });
});
