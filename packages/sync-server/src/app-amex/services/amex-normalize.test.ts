import { describe, expect, it } from 'vitest';

import type { AmexRawTransaction } from '#app-amex/models/amex';

import { normalizeTransaction } from './amex-services';

function raw(overrides: Partial<AmexRawTransaction>): AmexRawTransaction {
  return {
    identifier: 'id-1',
    description: 'SOMETHING',
    amount: 10,
    type: 'DEBIT',
    post_date: '2026-07-25',
    charge_date: '2026-07-24',
    ...overrides,
  } as AmexRawTransaction;
}

describe('normalizeTransaction', () => {
  it('books a purchase as money out', () => {
    const tx = normalizeTransaction(
      raw({ amount: 17.92, type: 'DEBIT', description: 'AMAZON.IT' }),
    );
    expect(tx.amount).toBe(-17.92);
  });

  it('books a refund as money in even though Amex sends it negative', () => {
    // Taken from a real statement: the Amazon Prime refund shows as -6,75 EUR
    // in the Amex UI and arrives from the API with that sign. Passing it
    // through unchanged booked the refund as a second purchase.
    const tx = normalizeTransaction(
      raw({
        amount: -6.75,
        type: 'CREDIT',
        description: 'AMAZON PRIME PMTS AMZN.COM/BILL',
      }),
    );
    expect(tx.amount).toBe(6.75);
  });

  it('books a refund as money in when sent positive', () => {
    // The sign must not decide the direction either way.
    const tx = normalizeTransaction(raw({ amount: 6.75, type: 'CREDIT' }));
    expect(tx.amount).toBe(6.75);
  });

  it('books a card repayment as money in', () => {
    const tx = normalizeTransaction(
      raw({ amount: -1180.24, type: 'CREDIT', sub_type: 'payment' }),
    );
    expect(tx.amount).toBe(1180.24);
    expect(tx.payeeName).toBe('Credit Card Payment');
  });

  it('never lets a negative purchase become an inflow', () => {
    // Defensive: a DEBIT is money out whatever sign accompanies it.
    const tx = normalizeTransaction(raw({ amount: -50, type: 'DEBIT' }));
    expect(tx.amount).toBe(-50);
  });

  it('dates a purchase when the card was used, not when it posted', () => {
    // Amex shows this Lufthansa charge on the 26th; it posted on the 28th.
    const tx = normalizeTransaction(
      raw({ post_date: '2026-07-28', charge_date: '2026-07-26' }),
    );
    expect(tx.date).toBe('2026-07-26');
    expect(tx.rawChargeDate).toBe('2026-07-26');
  });

  it('falls back to the posting date when there is no charge date', () => {
    // Repayments are posted, never "charged".
    const tx = normalizeTransaction(
      raw({ post_date: '2026-07-06', charge_date: '', sub_type: 'payment' }),
    );
    expect(tx.date).toBe('2026-07-06');
  });

  it('prefers the merchant name over the raw description', () => {
    const tx = normalizeTransaction(
      raw({
        description: 'AMAZON.IT*YV2RT39K5 WWW.AMAZON.IT',
        extended_details: { merchant: { name: 'Amazon' } },
      }),
    );
    expect(tx.payeeName).toBe('Amazon');
  });

  it('carries the Amex identifier through as the dedup key', () => {
    const tx = normalizeTransaction(raw({ identifier: 'amex-abc-123' }));
    expect(tx.transactionId).toBe('amex-abc-123');
  });
});
