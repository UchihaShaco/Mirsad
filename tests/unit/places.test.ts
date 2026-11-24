/**
 * Places directory (Abu Dhabi): schema validation and officer search over the
 * Overture-derived JSON in data/places-abu-dhabi.json. The dashboard map
 * never receives the whole file; it pages through searchPlaces by bbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlaces, PlaceRecord, searchPlaces } from '../../src/places/store.ts';

const SAMPLE_FILE = fileURLToPath(new URL('../../fixtures/places/abu-dhabi-sample.json', import.meta.url));

describe('places directory', () => {
  it('accepts the agreed record shape', () => {
    const record = {
      id: '2ca3aec0-e67f-4199-99f4-a98ef0cefb79',
      name: 'Aesop',
      name_ar: null,
      location_link: 'https://www.google.com/maps/search/?api=1&query=24.488819,54.608689',
      urls: ['https://www.aesop.ae/'],
      phones: ['+97126500917'],
      description: 'beauty_supply_store, in Abu Dhabi, Ground Floor G-154, confidence 1',
      category: 'beauty_supply_store',
      address: 'Ground Floor, G-154, Abu Dhabi, AE',
      lat: 24.488819,
      lng: 54.608689,
      confidence: 1,
      source: 'overture',
      updated_at: '2026-11-24T00:00:00.000Z',
    };
    expect(PlaceRecord.parse(record)).toEqual(record);
  });

  it('rejects javascript: and data: URLs anywhere: rows become clickable hrefs', () => {
    const base = {
      id: 'x',
      name: 'X',
      name_ar: null,
      location_link: 'https://www.google.com/maps/search/?api=1&query=24.4,54.3',
      urls: [],
      phones: [],
      description: 'place in Abu Dhabi',
      category: 'place',
      address: null,
      lat: 24.4,
      lng: 54.3,
      confidence: null,
      source: 'overture',
      updated_at: '2026-11-24T00:00:00.000Z',
    };
    expect(() => PlaceRecord.parse({ ...base, location_link: 'javascript:alert(1)' })).toThrow();
    expect(() => PlaceRecord.parse({ ...base, urls: ['data:text/html,<img src=x onerror=alert(1)>'] })).toThrow();
    expect(() => PlaceRecord.parse({ ...base, urls: ['HTTPS://EXAMPLE.COM/ok'] })).not.toThrow();
  });

  it('rejects bad urls, bad coordinates and missing ids', () => {
    const base = {
      id: 'x',
      name: 'X',
      name_ar: null,
      location_link: 'https://www.google.com/maps/search/?api=1&query=24.4,54.3',
      urls: [],
      phones: [],
      description: 'place in Abu Dhabi',
      category: 'place',
      address: null,
      lat: 24.4,
      lng: 54.3,
      confidence: null,
      source: 'overture',
      updated_at: '2026-11-24T00:00:00.000Z',
    };
    expect(() => PlaceRecord.parse({ ...base, urls: [42] })).toThrow();
    expect(() => PlaceRecord.parse({ ...base, lat: '24.4' })).toThrow();
    expect(() => PlaceRecord.parse({ ...base, id: '' })).toThrow();
    expect(() => PlaceRecord.parse({ ...base, location_link: 'not a url' })).toThrow();
  });

  it('loads the sample fixture file', () => {
    const places = loadPlaces(SAMPLE_FILE);
    expect(places).toHaveLength(5);
    expect(places[0]?.location_link).toContain('google.com/maps/search');
  });

  it('throws on an invalid record inside the file, naming the file and the row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-places-'));
    try {
      const file = path.join(dir, 'bad.json');
      fs.writeFileSync(file, JSON.stringify([{ id: 'only-an-id' }]));
      expect(() => loadPlaces(file)).toThrow(/places_record_invalid:.*#0$/);
      expect(() => loadPlaces(path.join('fixtures', 'places', 'does-not-exist.json'))).toThrow(/places_file_unreadable/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the real directory when it is present', () => {
    const file = path.join('data', 'places-abu-dhabi.json');
    if (!fs.existsSync(file)) return;
    const manifestPath = fileURLToPath(new URL('../../fixtures/places/manifest.json', import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { records: number };
    const places = loadPlaces(file);
    expect(places.length).toBe(manifest.records);
    expect(places.length).toBeGreaterThan(1000);
    expect(places.every((p) => p.location_link.startsWith('https://'))).toBe(true);
  });

  it('searches by name substring, case-insensitive', () => {
    const places = loadPlaces(SAMPLE_FILE);
    const first = places[0]?.name ?? '';
    const needle = first.slice(0, 4).toLowerCase();
    const found = searchPlaces(places, { q: needle, limit: 200 });
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((p) => p.name.toLowerCase().includes(needle))).toBe(true);
  });

  it('filters by exact category and by bbox', () => {
    const places = loadPlaces(SAMPLE_FILE);
    const first = places[0];
    if (!first) throw new Error('sample fixture is empty');
    const category = first.category;
    const byCategory = searchPlaces(places, { category, limit: 200 });
    expect(byCategory.items.length).toBeGreaterThan(0);
    expect(byCategory.items.every((p) => p.category === category)).toBe(true);

    const target = first;
    const pad = 0.001;
    const inBox = searchPlaces(places, {
      bbox: [target.lng - pad, target.lat - pad, target.lng + pad, target.lat + pad],
      limit: 200,
    });
    expect(inBox.items.some((p) => p.id === target.id)).toBe(true);

    const nowhere = searchPlaces(places, { bbox: [0, 0, 0.01, 0.01], limit: 200 });
    expect(nowhere.items).toHaveLength(0);
  });

  it('caps page size at 200 and paginates with an opaque cursor', () => {
    const places = loadPlaces(SAMPLE_FILE);
    const page1 = searchPlaces(places, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.offset).toBe(0);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = searchPlaces(places, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.length).toBeGreaterThan(0);
    expect(page2.offset).toBe(2);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);

    const capped = searchPlaces(places, { limit: 9999 });
    expect(capped.items.length).toBeLessThanOrEqual(200);
  });

  it('lists the distinct categories of all matches, not just the page', () => {
    const places = loadPlaces(SAMPLE_FILE);
    const page = searchPlaces(places, { limit: 2 });
    const expected = [...new Set(places.map((p) => p.category))].sort();
    expect(page.categories).toEqual(expected);
    const filtered = searchPlaces(places, { category: expected[0] ?? '', limit: 1 });
    expect(filtered.categories).toEqual([expected[0]]);
  });

  it('restarts a garbage cursor at the first page instead of failing', () => {
    const places = loadPlaces(SAMPLE_FILE);
    const garbage = searchPlaces(places, { limit: 2, cursor: '!!!not-a-cursor!!!' });
    expect(garbage.offset).toBe(0);
    expect(garbage.items).toHaveLength(2);
    const negative = searchPlaces(places, { limit: 2, cursor: Buffer.from('-5').toString('base64url') });
    expect(negative.offset).toBe(0);
  });
});
