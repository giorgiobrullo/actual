import { describe, expect, it } from 'vitest';

import { normalizeTransaction } from './tfbank-services';

/**
 * Shapes here mirror rows the live account actually returned, so the assertions
 * describe what the statement shows rather than what the API might send.
 */
describe('normalizeTransaction', () => {
  it('keeps the merchant as the payee for a purchase', () => {
    const tx = normalizeTransaction({
      date: '2026-07-12',
      description: 'HILL HILL BILLIARD CAF',
      amount: 11.5,
      type: 'CardTransaction',
    });

    expect(tx?.payeeName).toBe('HILL HILL BILLIARD CAF');
    expect(tx?.amount).toBe(-11.5);
  });

  it('drops the bare type from the notes', () => {
    // 'CardTransaction' appeared on every purchase and said nothing.
    const tx = normalizeTransaction({
      date: '2026-07-12',
      description: 'HILL HILL BILLIARD CAF',
      amount: 11.5,
      type: 'CardTransaction',
    });

    expect(tx?.notes).toBe('');
  });

  it('names a repayment rather than showing its IBAN', () => {
    // The account reports repayments with the sending IBAN as the description,
    // which is unreadable in a payee column.
    const tx = normalizeTransaction({
      date: '2026-07-23',
      description: 'IT39X0357601601010003183401',
      amount: 271.07,
      type: 'IncomingPayment',
    });

    expect(tx?.payeeName).toBe('Credit Card Payment');
    expect(tx?.amount).toBe(271.07);
    expect(tx?.notes).toContain('From: IT39X0357601601010003183401');
    expect(tx?.notes).toContain('Convert to transfer');
  });

  it('keeps descriptive text a transfer carries', () => {
    const tx = normalizeTransaction({
      date: '2026-06-22',
      description: 'IT32O0338501601100000924261',
      amount: 508.29,
      type: 'IncomingPayment',
      notes: 'Bonifico disposto a favore di Avarda Bank AB',
    });

    expect(tx?.notes).toContain('Bonifico disposto a favore di Avarda Bank AB');
  });

  it('labels foreign currency and category the way Carta You does', () => {
    const tx = normalizeTransaction({
      date: '2026-07-01',
      description: 'WANIKANI',
      amount: 9,
      type: 'CardTransaction',
      merchantCategory: 'shopping',
      foreignAmount: 9,
      foreignCurrency: 'USD',
    });

    expect(tx?.notes).toBe('Category: shopping | Original: 9 USD');
  });

  it('keeps an unrecognised type, since that one is informative', () => {
    const tx = normalizeTransaction({
      date: '2026-07-01',
      description: 'SOMETHING',
      amount: 5,
      type: 'Reversal',
    });

    expect(tx?.notes).toBe('Type: Reversal');
  });

  it('does not mistake a merchant name for an IBAN', () => {
    const tx = normalizeTransaction({
      date: '2026-07-01',
      description: 'IL CASTELLO DI BACCO',
      amount: 65,
      type: 'IncomingPayment',
    });

    expect(tx?.payeeName).toBe('IL CASTELLO DI BACCO');
  });
});
