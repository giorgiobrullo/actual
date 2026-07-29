import type { AvardaMyPages } from 'avarda-mypages';
import createDebug from 'debug';

const debug = createDebug('actual:tfbank:probe');

const MY_BASE = 'https://mypages-api.production.avarda.com';
const CARD_BASE = 'https://cardmanagement.production.avarda.com';

/**
 * One-shot discovery sweep for the TF Bank (Avarda) account identifier.
 *
 * `/api/v3/transactions/{id}` wants a GUID it calls `cornicheAccountId`, and
 * the endpoint we assumed produced it (`/api/card/details`) 404s on both hosts,
 * so login falls back to the login email and Avarda rejects it. This sweeps
 * every endpoint we know of, harvests every GUID out of the responses, and
 * tests each one against the transactions endpoint to see which is the real
 * account id.
 *
 * Deliberately one pass: an Avarda login costs the user an SMS and the bank
 * rate-limits after a few, so this gathers everything at once rather than
 * being run repeatedly. Read-only — GET requests only, nothing is mutated.
 *
 * Enabled by setting TFBANK_PROBE=1; off by default.
 */

export function isProbeEnabled(): boolean {
  return process.env.TFBANK_PROBE === '1';
}

const GUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Taken from the real customer-area bundle (areacliente.tfbank.it), whose Elm
// code builds every URL as o(["api", ...]). Extracting those shows the app
// talks only to the mypages host and has no /api/card/details and no
// /api/v3/transactions at all -- which is why our current guesses 404. The
// account list has to come from /api/client/details, and per-account data from
// /api/accounts/{id}. The cardmanagement guesses are kept at the end purely to
// confirm they are dead.
const ENDPOINTS: Array<[base: string, path: string]> = [
  // Top candidate: its decoder in the bundle is
  // { allowedBicCodesForFinland, accounts: [{ accountId, accountNumber, ... }] }
  // -- the only place we have found that lists accounts with their ids.
  [MY_BASE, '/api/Accounts/tocredit'],
  // Returns firstName/lastName/email/phone plus a `creditLimits` list.
  [MY_BASE, '/api/client/details'],
  [MY_BASE, '/api/accounts'],
  [CARD_BASE, '/api/v1/CreditLimit/GetCreditLimits'],
  [CARD_BASE, '/api/v1/invoices'],
  [MY_BASE, '/api/card/details'],
  [CARD_BASE, '/api/card/details'],
];

// Statement history. The web app's date-range picker drives
// /api/Client/filter-payments, which is paginated and takes fromDate/toDate;
// /api/Client/payments is the unfiltered recent list. Both return invoice
// objects that nest `financialTransactions` and `paymentsAndReturns`, so
// between them they should cover history beyond the current period.
function historyEndpoints(): Array<[base: string, path: string]> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 730 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return [
    [MY_BASE, '/api/Client/payments?itemsToReturn=24'],
    [
      MY_BASE,
      `/api/Client/filter-payments?pageNumber=1&pageSize=50&fromDate=${from}&toDate=${to}`,
    ],
  ];
}

// Once GUIDs are harvested, these are the shapes the real app actually uses.
// `{id}` is substituted per candidate.
const PER_ACCOUNT: Array<[base: string, template: string]> = [
  [MY_BASE, '/api/accounts/{id}'],
  [MY_BASE, '/api/accounts/{id}/summary'],
];

// Extra paths to try without rebuilding the image, as
// TFBANK_PROBE_EXTRA="/api/foo,/api/bar" (all on the mypages host).
function extraEndpoints(): Array<[base: string, path: string]> {
  return (process.env.TFBANK_PROBE_EXTRA ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => [MY_BASE, p] as [string, string]);
}

// `it-IT` is rejected outright, so the working value has to be found too --
// a correct account id alone would still 400.
const LOCALES = ['it-IT', 'it', 'en-US', 'en', 'sv-SE', 'fi-FI', ''];

// Syntactically valid but certainly not ours: lets us tell a Locale complaint
// apart from an account-id complaint, since the API reports both at once.
const DUMMY_GUID = '00000000-0000-4000-8000-000000000000';

type Probe = { label: string; status: number; body: string };

async function get(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { headers });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return {
      status: 0,
      body: `fetch error: ${e instanceof Error ? e.message : e}`,
    };
  }
}

function transactionsUrl(id: string, locale: string): string {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const localeParam = locale ? `&locale=${encodeURIComponent(locale)}` : '';
  return `${CARD_BASE}/api/v3/transactions/${encodeURIComponent(id)}?transactionDateFrom=${from}&transactionDateTo=${to}${localeParam}`;
}

export async function probeAccountDiscovery(
  client: AvardaMyPages,
): Promise<void> {
  const token = client.getSession()?.accessToken ?? '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://areacliente.tfbank.it',
    Referer: 'https://areacliente.tfbank.it/',
  };

  debug('=== TF BANK DISCOVERY PROBE (read-only) ===');

  // 1. JWT claims. Only keys and GUID-shaped values are logged -- the payload
  //    also carries the customer's ssn and email, which we do not want in logs.
  const claims = client.getSession()?.claims ?? {};
  debug('JWT claim keys: %s', Object.keys(claims).join(', ') || '(none)');
  for (const [k, v] of Object.entries(claims)) {
    if (typeof v === 'string' && GUID_RE.test(v)) {
      GUID_RE.lastIndex = 0;
      debug('JWT claim GUID: %s = %s', k, v);
    }
  }

  // 2. Sweep every known and plausible endpoint.
  const probes: Probe[] = [];
  for (const [base, path] of [
    ...ENDPOINTS,
    ...historyEndpoints(),
    ...extraEndpoints(),
  ]) {
    const { status, body } = await get(`${base}${path}`, headers);
    const label = `${base.includes('mypages') ? 'MY ' : 'CARD'} ${path}`;
    probes.push({ label, status, body });
    debug(
      '%s -> %d %s',
      label,
      status,
      status === 200 ? body.slice(0, 1200) : body.slice(0, 160),
    );
  }

  // 3. Harvest every GUID any endpoint returned, remembering where it came from.
  const found = new Map<string, string>();
  const claimsJson = JSON.stringify(claims);
  for (const source of [
    { label: 'JWT claims', body: claimsJson },
    ...probes.filter(p => p.status === 200),
  ]) {
    for (const guid of source.body.match(GUID_RE) ?? []) {
      if (!found.has(guid.toLowerCase())) {
        found.set(guid.toLowerCase(), source.label);
      }
    }
  }
  debug('--- harvested %d unique GUID(s) ---', found.size);
  for (const [guid, source] of found) {
    debug('  %s  (from %s)', guid, source);
  }

  // 4. Find a Locale the API accepts, using a well-formed but bogus id so the
  //    only remaining complaint should be about the account.
  debug('--- locale probe (dummy id, so Locale errors stand alone) ---');
  let workingLocale: string | null = null;
  for (const locale of LOCALES) {
    const { status, body } = await get(
      transactionsUrl(DUMMY_GUID, locale),
      headers,
    );
    const localeRejected = /not valid for Locale/i.test(body);
    debug(
      '  locale=%-6s -> %d  localeRejected=%s  %s',
      locale || '(omitted)',
      status,
      localeRejected,
      body.slice(0, 200),
    );
    if (!localeRejected && workingLocale === null) {
      workingLocale = locale;
    }
  }
  debug(
    '--- first accepted locale: %s ---',
    workingLocale === null ? '(none)' : workingLocale || '(omitted)',
  );

  // 5. Try each harvested GUID against the endpoints the real app uses. A 200
  //    from /api/accounts/{id}/summary is the answer we are after: its decoder
  //    in the bundle carries financialTransactions / historicalTransactions /
  //    paymentsAndReturns, i.e. the transaction list.
  debug('--- per-account probe (endpoints the real web app uses) ---');
  for (const [guid, source] of found) {
    for (const [base, template] of PER_ACCOUNT) {
      const path = template.replace('{id}', encodeURIComponent(guid));
      const { status, body } = await get(`${base}${path}`, headers);
      debug(
        '  %s %s (from %s) -> %d %s',
        path,
        guid,
        source,
        status,
        body.slice(0, 500),
      );
    }
  }

  // 6. The legacy cardmanagement guess, for completeness.
  debug('--- legacy /api/v3/transactions probe ---');
  for (const [guid] of found) {
    const { status, body } = await get(
      transactionsUrl(guid, workingLocale ?? ''),
      headers,
    );
    debug('  v3 %s -> %d %s', guid, status, body.slice(0, 200));
  }

  debug('=== PROBE COMPLETE ===');
}
