/** Places as a check on evidence: whose number, whose website. Uses the committed Overture sample. */
import { describe, expect, it } from 'vitest';
import { hostOf, loadPlaces, nationalNumber, searchPlaces } from '../../src/places/store.ts';

const places = loadPlaces(new URL('../../fixtures/places/abu-dhabi-sample.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const names = (q: string) => searchPlaces(places, { q, limit: 10 }).items.map(place => place.name);

describe('places lookup by phone and website', () => {
  it('finds a listed number however the evidence wrote it', () => {
    for (const written of ['+97126429176', '+971 2 642 9176', '00971 2 642 9176', '02 642 9176', '(02) 642-9176']) {
      expect(names(written), written).toEqual(['Aesop']);
    }
    expect(names('+971 50 000 0301')).toEqual([]);
    // A short run of digits is not a phone number and finds nothing by phone.
    expect(names('9176')).toEqual([]);
  });

  it('finds a listed website by its host, never by a look-alike host', () => {
    expect(names('aesop.ae')).toEqual(['Aesop']);
    expect(names('https://www.aesop.ae/checkout')).toEqual(['Aesop']);
    expect(names('pay.aesop.ae')).toEqual(['Aesop']);
    expect(names('aesop.ae.delivery-fee.example')).toEqual([]);
    expect(names('aesop-ae.example')).toEqual([]);
    expect(names('ae.hm.com')).toEqual(['H&M', 'H&M']);
  });

  it('still searches names and categories as before', () => {
    expect(names('burberry')).toEqual(['Burberry']);
    expect(names('beauty')).toEqual(['Aesop']);
  });

  it('normalises numbers and hosts', () => {
    expect(nationalNumber('+971 2 642 9176')).toBe('26429176');
    expect(nationalNumber('0501234567')).toBe('501234567');
    expect(nationalNumber('+44 7700 900123')).toBe('447700900123');
    expect(hostOf('HTTPS://WWW.Aesop.ae/x')).toBe('aesop.ae');
    expect(hostOf('not a domain')).toBeNull();
  });
});
