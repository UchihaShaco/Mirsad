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

  it('any phone number the chat already surfaced is a repeat, current or not', () => {
    const earlier = [known('+447700900123', 10), known('+447700900456', 20)];
    expect(decideDetail('phone_number', '+447700900123', earlier)).toEqual({ kind: 'repeat' });
    expect(decideDetail('phone_number', '+447700900789', earlier)).toEqual({ kind: 'new' });
  });
});
