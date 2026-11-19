import { describe, it, expect, vi, afterEach } from 'vitest';
import { getVolatileCookiesFor, startCookieCheck, takeCookieCheck, learnVolatileCookies } from '../../lib/volatile-cookies.js';

const cookie = (name, value) => ({ name, value, domain: 'a.com', path: '/' });

describe('lib/volatile-cookies', () => {
  afterEach(() => vi.useRealTimers());

  it('hands a started check to the next take, once', async () => {
    await startCookieCheck(5, 'a.com', [cookie('sid', '1')]);
    expect(await takeCookieCheck(5)).toMatchObject({ domain: 'a.com', cookies: [cookie('sid', '1')] });
    expect(await takeCookieCheck(5)).toBeNull();
  });

  it('drops a check that is taken after its window', async () => {
    vi.useFakeTimers({ now: 0 });
    await startCookieCheck(5, 'a.com', []);
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
});
