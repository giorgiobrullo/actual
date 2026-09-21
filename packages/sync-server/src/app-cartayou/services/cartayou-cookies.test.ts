import { describe, expect, it } from 'vitest';

import { buildCookieHeader, selectApiCookies } from './cartayou-auth';

describe('selectApiCookies', () => {
  it('keeps the session cookies and drops OpenID Connect handshake leftovers', () => {
    const cookies = [
      { name: 'frontCookie', value: 'front' },
      { name: '.AspNetCore.Cookies', value: 'session' },
      { name: '.AspNetCore.CookiesC1', value: 'chunk' },
      { name: '.AspNetCore.OpenIdConnect.Nonce.CfDJ8Lid', value: 'N' },
      { name: '.AspNetCore.Correlation.abc123', value: 'N' },
    ];

    expect(selectApiCookies(cookies)).toEqual({
      frontCookie: 'front',
      '.AspNetCore.Cookies': 'session',
      '.AspNetCore.CookiesC1': 'chunk',
    });
  });

  it('keeps the header small no matter how many logins were abandoned', () => {
    // One nonce + one correlation cookie per attempt that never got its SMS
    // code: a month of those is what pushed the real header past the limit.
    const abandoned = Array.from({ length: 80 }, (_, i) => [
      {
        name: `.AspNetCore.OpenIdConnect.Nonce.${'x'.repeat(120)}${i}`,
        value: 'N',
      },
      { name: `.AspNetCore.Correlation.${'y'.repeat(40)}${i}`, value: 'N' },
    ]).flat();

    const header = buildCookieHeader(
      selectApiCookies([
        { name: 'frontCookie', value: 'f'.repeat(326) },
        ...abandoned,
      ]),
    );

    expect(header).toBe(`frontCookie=${'f'.repeat(326)}`);
  });
});
