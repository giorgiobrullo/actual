import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-test-'));

vi.mock('#load-config', () => ({
  config: { get: (key: string) => (key === 'dataDir' ? dataDir : undefined) },
}));

// Camoufox launches a real browser, so it is stubbed: these tests are about
// profile lifecycle, not the browser itself.
const launched: Array<{ user_data_dir: string }> = [];
let launchImpl: (opts: { user_data_dir: string }) => unknown = opts => ({
  close: vi.fn(async () => undefined),
  pages: () => [],
  _opts: opts,
});

vi.mock('camoufox-js', () => ({
  Camoufox: vi.fn(async (opts: { user_data_dir: string }) => {
    launched.push(opts);
    return launchImpl(opts);
  }),
}));

const { launchStealthContext, closeStealthContext } =
  await import('./stealth-browser');

const profileDir = (name: string) =>
  path.join(dataDir, 'browser-profiles', name);
const lockFile = (name: string) => path.join(profileDir(name), '.actual-lock');

beforeEach(() => {
  launched.length = 0;
  launchImpl = opts => ({
    close: vi.fn(async () => undefined),
    pages: () => [],
    _opts: opts,
  });
  fs.rmSync(path.join(dataDir, 'browser-profiles'), {
    recursive: true,
    force: true,
  });
});

afterEach(() => vi.clearAllMocks());

describe('launchStealthContext', () => {
  it('keeps a named profile across runs so cookies survive', async () => {
    const first = await launchStealthContext({ profile: 'amex' });
    await closeStealthContext(first);

    expect(launched[0].user_data_dir).toBe(profileDir('amex'));
    expect(fs.existsSync(profileDir('amex'))).toBe(true);

    const second = await launchStealthContext({ profile: 'amex' });
    await closeStealthContext(second);

    expect(launched[1].user_data_dir).toBe(profileDir('amex'));
  });

  it('gives each bank its own profile', async () => {
    const amex = await launchStealthContext({ profile: 'amex' });
    await closeStealthContext(amex);
    const cartayou = await launchStealthContext({ profile: 'cartayou' });
    await closeStealthContext(cartayou);

    expect(launched[0].user_data_dir).not.toBe(launched[1].user_data_dir);
  });

  it('deletes an unnamed profile on close', async () => {
    const context = await launchStealthContext();
    const dir = launched[0].user_data_dir;

    expect(fs.existsSync(dir)).toBe(true);
    await closeStealthContext(context);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses a profile already held by a live process', async () => {
    const context = await launchStealthContext({ profile: 'amex' });

    await expect(launchStealthContext({ profile: 'amex' })).rejects.toThrow(
      /in use/,
    );

    await closeStealthContext(context);
    // Released, so the next run gets it.
    const after = await launchStealthContext({ profile: 'amex' });
    expect(after).toBeDefined();
    await closeStealthContext(after);
  });

  it('takes over a lock left behind by a dead process', async () => {
    fs.mkdirSync(profileDir('amex'), { recursive: true });
    // A pid that cannot be running: the container was killed mid-scrape.
    fs.writeFileSync(lockFile('amex'), '2147483647');

    const context = await launchStealthContext({ profile: 'amex' });
    expect(context).toBeDefined();
    await closeStealthContext(context);
  });

  it('recreates a profile that will not open, rather than failing forever', async () => {
    fs.mkdirSync(profileDir('amex'), { recursive: true });
    fs.writeFileSync(path.join(profileDir('amex'), 'corrupt'), 'x');

    let attempt = 0;
    launchImpl = opts => {
      if (++attempt === 1) throw new Error('profile is corrupt');
      return {
        close: vi.fn(async () => undefined),
        pages: () => [],
        _opts: opts,
      };
    };

    const context = await launchStealthContext({ profile: 'amex' });
    expect(context).toBeDefined();
    expect(attempt).toBe(2);
    await closeStealthContext(context);
    expect(fs.existsSync(path.join(profileDir('amex'), 'corrupt'))).toBe(false);
  });

  it('does not swallow a launch failure when there is no profile to blame', async () => {
    launchImpl = () => {
      throw new Error('no display');
    };

    await expect(launchStealthContext()).rejects.toThrow('no display');
  });
});
