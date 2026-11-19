import { describe, it, expect, vi, afterEach } from 'vitest';
import { getVolatileCookiesFor, startCookieCheck, takeCookieCheck, learnVolatileCookies, ignoreCookieChange, hasPendingCookieCheck, cancelCookieChecksFor } from '../../lib/volatile-cookies.js';

const cookie = (name, value) => ({ name, value, domain: 'a.com', path: '/' });
const scope = (domain, cookieExact = false) => ({ origins: [`*://${domain}/*`], cookieDomain: domain, cookieExact });
const stored = (domain, until, more = {}) => ({ domain, cookies: [], ...scope(domain), until, ...more });

describe('lib/volatile-cookies', () => {
  afterEach(() => vi.useRealTimers());

  it('hands a started check to the next take, once', async () => {
    await startCookieCheck(5, 'a.com', [cookie('sid', '1')], scope('a.com'));
    expect(await hasPendingCookieCheck(5)).toBe(true);
    expect(await hasPendingCookieCheck(6)).toBe(false);
    expect(await takeCookieCheck(5)).toMatchObject({ domain: 'a.com', cookies: [cookie('sid', '1')] });
    expect(await takeCookieCheck(5)).toBeNull();
    expect(await hasPendingCookieCheck(5)).toBe(false);
  });

  it('stores the origins and cookie domain the check needs', async () => {
    await startCookieCheck(5, 'example.com', [], { origins: ['*://example.com/*', '*://*.example.com/*'], cookieDomain: 'app.example.com', cookieExact: false });
    expect(await takeCookieCheck(5)).toMatchObject({
      domain: 'example.com',
      origins: ['*://example.com/*', '*://*.example.com/*'],
      cookieDomain: 'app.example.com',
    });
  });

  it('cancels the pending checks of every tab that shares the cookie scope', async () => {
    const until = Date.now() + 60_000;
    await chrome.storage.local.set({ cookieChecks: {
      5: stored('example.com', until),
      6: stored('example.com', until),
      7: stored('app.example.com', until),
      8: stored('other.com', until),
    } });
    await cancelCookieChecksFor('example.com');
    expect(await hasPendingCookieCheck(5)).toBe(false);
    expect(await hasPendingCookieCheck(6)).toBe(false);
    expect(await hasPendingCookieCheck(7)).toBe(false);
    expect(await hasPendingCookieCheck(8)).toBe(true);
  });

  it('a new check drops the other tabs\' checks on the same cookie scope', async () => {
    await startCookieCheck(5, 'example.com', [cookie('sid', 'a')], scope('example.com'));
    await startCookieCheck(9, 'other.com', [], scope('other.com'));
    await startCookieCheck(6, 'example.com', [cookie('sid', 'b')], scope('example.com'));
    expect(await hasPendingCookieCheck(5)).toBe(false);
    expect(await hasPendingCookieCheck(9)).toBe(true);
    expect(await takeCookieCheck(6)).toMatchObject({ cookies: [cookie('sid', 'b')] });
  });

  it('keeps a lookalike domain\'s check, which only shares a suffix', async () => {
    await startCookieCheck(9, 'notexample.com', [], scope('notexample.com'));
    await cancelCookieChecksFor('example.com');
    expect(await hasPendingCookieCheck(9)).toBe(true);
    await startCookieCheck(5, 'example.com', [], scope('example.com'));
    expect(await hasPendingCookieCheck(9)).toBe(true);
    await startCookieCheck(6, 'app.notexample.com', [], scope('app.notexample.com'));
    expect(await hasPendingCookieCheck(5)).toBe(true);
  });

  it('a new check on a parent domain drops a child\'s check, and one on a child drops the parent\'s', async () => {
    await startCookieCheck(5, 'app.example.com', [], scope('app.example.com'));
    await startCookieCheck(6, 'example.com', [], scope('example.com'));
    expect(await hasPendingCookieCheck(5)).toBe(false);
    await startCookieCheck(7, 'www.example.com', [], scope('www.example.com'));
    expect(await hasPendingCookieCheck(6)).toBe(false);
    expect(await hasPendingCookieCheck(7)).toBe(true);
  });

  it('keeps the checks of sibling hosts whose exact scopes share no cookie', async () => {
    await startCookieCheck(5, 'example.com', [], scope('app.example.com', true));
    await startCookieCheck(6, 'example.com', [], scope('www.example.com', true));
    expect(await hasPendingCookieCheck(5)).toBe(true);
    expect(await hasPendingCookieCheck(6)).toBe(true);
  });

  it('an exact scope on the base keeps the subdomains\' checks, a wide one drops them', async () => {
    await startCookieCheck(5, 'example.com', [], scope('app.example.com', true));
    await startCookieCheck(6, 'example.com', [], scope('example.com', true));
    expect(await hasPendingCookieCheck(5)).toBe(true);
    await startCookieCheck(7, 'example.com', [], scope('example.com', false));
    expect(await hasPendingCookieCheck(5)).toBe(false);
    expect(await hasPendingCookieCheck(6)).toBe(false);
  });

  it('a stored check without origins or cookieDomain is discarded', async () => {
    const until = Date.now() + 60_000;
    const seedOld = () => chrome.storage.local.set({ cookieChecks: {
      5: { domain: 'example.com', cookies: [], until },
      6: { domain: 'example.com', cookies: [], cookieDomain: 'example.com', until },
      7: { domain: 'example.com', cookies: [], origins: ['*://example.com/*'], until },
    } });

    await seedOld();
    expect(await hasPendingCookieCheck(5)).toBe(false);
    expect(await takeCookieCheck(5)).toBeNull();
    expect(await takeCookieCheck(6)).toBeNull();
    expect(await takeCookieCheck(7)).toBeNull();

    await seedOld();
    await cancelCookieChecksFor('other.com');
    expect(Object.keys((await chrome.storage.local.get('cookieChecks')).cookieChecks)).toEqual([]);

    await seedOld();
    await startCookieCheck(8, 'other.com', [], scope('other.com'));
    expect(Object.keys((await chrome.storage.local.get('cookieChecks')).cookieChecks)).toEqual(['8']);
  });

  it('cancels by the cleared scope: an exact host leaves its siblings\' and subdomains\' checks', async () => {
    const until = Date.now() + 60_000;
    await chrome.storage.local.set({ cookieChecks: {
      5: stored('example.com', until, { cookieDomain: 'app.example.com', cookieExact: true }),
      6: stored('example.com', until, { cookieDomain: 'www.example.com', cookieExact: true }),
      7: stored('api.app.example.com', until),
    } });
    await cancelCookieChecksFor({ domain: 'app.example.com', exact: true });
    expect(await hasPendingCookieCheck(5)).toBe(false);
    expect(await hasPendingCookieCheck(6)).toBe(true);
    expect(await hasPendingCookieCheck(7)).toBe(true);
  });

  it('drops expired checks even when their scope does not overlap', async () => {
    vi.useFakeTimers({ now: 0 });
    await startCookieCheck(5, 'example.com', [], scope('example.com'));
    await startCookieCheck(6, 'other.com', [], scope('other.com'));
    vi.setSystemTime(61_000);
    await startCookieCheck(7, 'example.com', [], scope('example.com'));
    expect(Object.keys((await chrome.storage.local.get('cookieChecks')).cookieChecks)).toEqual(['7']);
  });

  it('stores whether the cookie scope is exact', async () => {
    await startCookieCheck(5, 'example.com', [], scope('example.com', true));
    expect(await takeCookieCheck(5)).toMatchObject({ cookieDomain: 'example.com', cookieExact: true });
  });

  it('taking a check leaves the other tabs\' checks', async () => {
    await startCookieCheck(5, 'a.com', [], scope('a.com'));
    await startCookieCheck(6, 'b.com', [], scope('b.com'));
    await takeCookieCheck(5);
    expect(Object.keys((await chrome.storage.local.get('cookieChecks')).cookieChecks)).toEqual(['6']);
  });

  it('taking or cancelling with nothing to drop writes nothing', async () => {
    await startCookieCheck(5, 'a.com', [], scope('a.com'));
    const set = vi.spyOn(chrome.storage.local, 'set');
    expect(await takeCookieCheck(6)).toBeNull();
    await cancelCookieChecksFor('other.com');
    await cancelCookieChecksFor({ domain: 'b.com', exact: true });
    expect(set).not.toHaveBeenCalled();
    expect(await hasPendingCookieCheck(5)).toBe(true);
  });

  it('drops a check that is taken after its window', async () => {
    vi.useFakeTimers({ now: 0 });
    await startCookieCheck(5, 'a.com', [], scope('a.com'));
    vi.setSystemTime(61_000);
    expect(await takeCookieCheck(5)).toBeNull();
    expect(await chrome.storage.local.get('cookieChecks')).toEqual({ cookieChecks: {} });
  });

  it('learns per domain, never downgrading "any" to "value"', async () => {
    await learnVolatileCookies('a.com', [cookie('x', '1')], []);
    await learnVolatileCookies('a.com', [cookie('x', '1'), cookie('csrf', '1')], [cookie('x', '2'), cookie('csrf', '2')]);
    expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|x': 'any', 'a.com|/|csrf': 'value' });
    expect(await getVolatileCookiesFor('b.com')).toEqual({});
  });

  it('records a cookie the user chose to ignore: a value change as "value", a cookie that came or went as "any"', async () => {
    await ignoreCookieChange('a.com', { type: 'cookies', key: 'a.com|/|psidts', name: 'psidts', kind: 'value' });
    await ignoreCookieChange('a.com', { type: 'cookies', key: 'a.com|/|tmp', name: 'tmp', kind: 'presence' });
    expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|psidts': 'value', 'a.com|/|tmp': 'any' });
  });
});
