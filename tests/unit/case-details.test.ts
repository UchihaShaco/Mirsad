import { describe, expect, it } from 'vitest';
import { decideDetail, type KnownDetail } from '../../src/domain/case-details.ts';

const known = (normalizedValue: string, lastSeenPosition: number): KnownDetail => ({
  normalizedValue,
  displayValue: `shown ${normalizedValue}`,
  lastSeenPosition,
});

describe('decideDetail', () => {
  it('a value with no earlier detail in its category is new', () => {
    expect(decideDetail('payment_link', 'pay.a.test/1', [])).toEqual({ kind: 'new' });
    expect(decideDetail('phone_number', '+447700900123', [])).toEqual({ kind: 'new' });
  });

  it('the current detail seen again is a repeat', () => {
    expect(decideDetail('payment_link', 'pay.a.test/1', [known('pay.a.test/1', 10)])).toEqual({ kind: 'repeat' });
  });

  it('a different value is a change from the current detail, the one seen last', () => {
    const earlier = [known('pay.a.test/1', 10), known('pay.b.test/2', 20)];
    expect(decideDetail('payment_recipient', 'test trading llc', earlier)).toEqual({ kind: 'changed', changedFrom: 'shown pay.b.test/2' });
  });

  it('switching back to an older value is a change from the current one', () => {
    const earlier = [known('pay.a.test/1', 10), known('pay.b.test/2', 20)];
    expect(decideDetail('payment_link', 'pay.a.test/1', earlier)).toEqual({ kind: 'changed', changedFrom: 'shown pay.b.test/2' });
  });

  it('details one message carried together are all current, so repeating any of them is a repeat, in any order', () => {
    // A holder name and an IBAN given in one message share the last-seen position.
    const earlier = [known('old holder', 5), known('test trading llc', 10), known('gb82 test 1234 5698 7654 32', 10)];
    for (const value of ['test trading llc', 'gb82 test 1234 5698 7654 32']) {
      expect(decideDetail('payment_recipient', value, earlier), value).toEqual({ kind: 'repeat' });
      expect(decideDetail('payment_recipient', value, [...earlier].reverse()), value).toEqual({ kind: 'repeat' });
    }
  });

  it('a value that is none of several current details is a change from the first of them in the order given', () => {
    const earlier = [known('old holder', 5), known('test trading llc', 10), known('gb82 test 1234 5698 7654 32', 10)];
    expect(decideDetail('payment_recipient', 'other holdings', earlier)).toEqual({ kind: 'changed', changedFrom: 'shown test trading llc' });
    expect(decideDetail('payment_recipient', 'old holder', earlier)).toEqual({ kind: 'changed', changedFrom: 'shown test trading llc' });
  });

  it('any phone number the chat already surfaced is a repeat, current or not', () => {
    const earlier = [known('+447700900123', 10), known('+447700900456', 20)];
    expect(decideDetail('phone_number', '+447700900123', earlier)).toEqual({ kind: 'repeat' });
    expect(decideDetail('phone_number', '+447700900789', earlier)).toEqual({ kind: 'new' });
  });
});
