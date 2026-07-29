import { describe, expect, it } from 'vitest';

import type { AmexAccount } from '#app-amex/models/amex';

import { mergeDiscoveredAccounts } from './amex-auth';

describe('mergeDiscoveredAccounts', () => {
  it('finds accounts in the flat arrays the v1 endpoints returned', () => {
    const accounts = mergeDiscoveredAccounts(
      [],
      [
        {
          account_token: 'tok-1',
          product_name: 'Amex Gold',
          display_account_number: '1006',
          total_credit_amount: 5000,
        },
      ],
    );

    expect(accounts).toEqual([
      {
        account_token: 'tok-1',
        name: 'Amex Gold',
        display_number: '1006',
        balance: undefined,
        credit_limit: 5000,
        available_credit: undefined,
      },
    ]);
  });

  it('finds accounts nested inside a v2 prefetch payload', () => {
    // The reason discovery silently returned zero: v1 sent a flat array, v2
    // buries the same records several levels down.
    const accounts = mergeDiscoveredAccounts([], {
      data: {
        member: {
          accounts: [
            { account_token: 'tok-1', product_name: 'Amex Gold' },
            { account_token: 'tok-2', product_name: 'Amex Green' },
          ],
        },
      },
    });

    expect(accounts.map(a => a.account_token)).toEqual(['tok-1', 'tok-2']);
  });

  it('combines fields that arrive in separate responses', () => {
    const accounts: AmexAccount[] = [];
    mergeDiscoveredAccounts(accounts, [
      { account_token: 'tok-1', product_name: 'Amex Gold' },
    ]);
    mergeDiscoveredAccounts(accounts, [
      { account_token: 'tok-1', statement_balance_amount: 220.5 },
    ]);
    mergeDiscoveredAccounts(accounts, [
      { account_token: 'tok-1', available_credit_amount: 4779.5 },
    ]);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: 'Amex Gold',
      balance: 220.5,
      available_credit: 4779.5,
    });
  });

  it('does not let a later payload erase what an earlier one supplied', () => {
    const accounts: AmexAccount[] = [];
    mergeDiscoveredAccounts(accounts, [
      { account_token: 'tok-1', statement_balance_amount: 220.5 },
    ]);
    mergeDiscoveredAccounts(accounts, [{ account_token: 'tok-1' }]);

    expect(accounts[0].balance).toBe(220.5);
  });

  it('falls back to a readable name and the token tail', () => {
    const accounts = mergeDiscoveredAccounts(
      [],
      [{ account_token: 'abcdef1234' }],
    );

    expect(accounts[0]).toMatchObject({
      name: 'Amex Card ****1234',
      display_number: '1234',
    });
  });

  it('names the card, not the cardholder', () => {
    // Amex returns no product name on these payloads, only the embossed
    // holder name. Naming the account after a person would be worse than the
    // generic fallback.
    const accounts = mergeDiscoveredAccounts(
      [],
      [
        {
          account_token: 'tok-1',
          embossed_name: 'CARDHOLDER NAME',
          display_account_number: '0000',
        },
      ],
    );

    expect(accounts[0].name).toBe('Amex Card ****0000');
    expect(accounts[0].display_number).toBe('0000');
  });

  it('ignores payloads with no account tokens', () => {
    expect(mergeDiscoveredAccounts([], { status: 'ok' })).toEqual([]);
    expect(mergeDiscoveredAccounts([], null)).toEqual([]);
    expect(mergeDiscoveredAccounts([], [{ account_token: '' }])).toEqual([]);
  });

  it('does not recurse forever on a self-referencing payload', () => {
    const payload: Record<string, unknown> = { account_token: 'tok-1' };
    payload.self = payload;

    expect(mergeDiscoveredAccounts([], payload)).toHaveLength(1);
  });
});
