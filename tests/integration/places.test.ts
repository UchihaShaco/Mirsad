/**
 * Places directory endpoints: officer search by text/category/viewport and
 * single-place reads for the map details panel.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPlaces } from '../../src/places/store.ts';
import { startHarness, type TestHarness } from '../helpers/harness.ts';

const SAMPLE_FILE = fileURLToPath(new URL('../../fixtures/places/abu-dhabi-sample.json', import.meta.url));

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness({ places: loadPlaces(SAMPLE_FILE) });
});

afterAll(async () => {
  await h.close();
});

describe('places directory endpoints', () => {
  it('lists the directory entries for an officer', async () => {
    const res = await h.http(h.tokens.officerA).get('/v1/places/search');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.places).toHaveLength(5);
    expect(res.body.meta.total).toBe(5);
    expect(res.body.data.places[0].location_link).toContain('google.com/maps/search');
  });

  it('filters by name text and by category', async () => {
    const all = await h.http(h.tokens.officerA).get('/v1/places/search');
    const first = all.body.data.places[0];
    const needle = encodeURIComponent(first.name.slice(0, 5));
    const byText = await h.http(h.tokens.officerA).get(`/v1/places/search?q=${needle}`);
    expect(byText.status).toBe(200);
    expect(byText.body.data.places.length).toBeGreaterThan(0);

    const byCategory = await h.http(h.tokens.officerA).get(
      `/v1/places/search?category=${encodeURIComponent(first.category)}`,
    );
    expect(byCategory.status).toBe(200);
    expect(byCategory.body.data.places.every((p: { category: string }) => p.category === first.category)).toBe(true);
  });

  it('paginates with an honest offset and full-match categories', async () => {
    const page1 = await h.http(h.tokens.officerA).get('/v1/places/search?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.meta.offset).toBe(0);
    expect(page1.body.data.categories).toEqual([...page1.body.data.categories].sort());
    const page2 = await h.http(h.tokens.officerA).get(
      `/v1/places/search?limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.meta.offset).toBe(2);
    expect(page2.body.meta.total).toBe(page1.body.meta.total);
  });

  it('filters by map viewport bbox', async () => {
    const all = await h.http(h.tokens.officerA).get('/v1/places/search');
    const target = all.body.data.places[0];
    const pad = 0.001;
    const bbox = `${target.lng - pad},${target.lat - pad},${target.lng + pad},${target.lat + pad}`;
    const inBox = await h.http(h.tokens.officerA).get(`/v1/places/search?bbox=${encodeURIComponent(bbox)}`);
    expect(inBox.status).toBe(200);
    expect(inBox.body.data.places.some((p: { id: string }) => p.id === target.id)).toBe(true);

    const nowhere = await h.http(h.tokens.officerA).get('/v1/places/search?bbox=0,0,0.01,0.01');
    expect(nowhere.status).toBe(200);
    expect(nowhere.body.data.places).toHaveLength(0);
  });

  it('rejects a bad bbox with validation_failed', async () => {
    const res = await h.http(h.tokens.officerA).get('/v1/places/search?bbox=nope');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('reads one place and 404s an unknown id', async () => {
    const all = await h.http(h.tokens.officerA).get('/v1/places/search');
    const id = all.body.data.places[0].id;
    const one = await h.http(h.tokens.officerA).get(`/v1/places/${encodeURIComponent(id)}`);
    expect(one.status).toBe(200);
    expect(one.body.data.place.id).toBe(id);
    expect(one.body.data.place.phones).toEqual(expect.any(Array));
    expect(one.body.data.place.urls).toEqual(expect.any(Array));

    const missing = await h.http(h.tokens.officerA).get('/v1/places/does-not-exist');
    expect(missing.status).toBe(404);
  });

  it('refuses anonymous callers', async () => {
    const res = await h.http(null).get('/v1/places/search');
    expect(res.status).toBe(401);
    const detail = await h.http(null).get('/v1/places/does-not-exist');
    expect(detail.status).toBe(401);
  });
});

describe('places directory without a data file', () => {
  it('serves an empty directory instead of failing', async () => {
    const empty = await startHarness();
    try {
      const res = await empty.http(empty.tokens.officerA).get('/v1/places/search');
      expect(res.status).toBe(200);
      expect(res.body.data.places).toHaveLength(0);
      expect(res.body.meta.total).toBe(0);
    } finally {
      await empty.close();
    }
  });
});
