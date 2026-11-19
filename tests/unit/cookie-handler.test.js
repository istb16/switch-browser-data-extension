import { describe, it, expect, vi } from 'vitest';
import { cookiesWithin, getCookiesForDomain, setCookiesForDomain } from '../../lib/cookie-handler.js';

describe('lib/cookie-handler', () => {
  it('getCookiesForDomain maps chrome.cookies fields to a plain snapshot shape', async () => {
    chrome._state.cookies.push({
      name: 'session', value: 'abc', domain: 'example.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 1700000000, storeId: '0',
      hostOnly: true, session: false,
    });

    const cookies = await getCookiesForDomain('example.com');
    expect(cookies).toEqual([{
      name: 'session', value: 'abc', domain: 'example.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 1700000000, storeId: '0',
    }]);
  });

  it('getCookiesForDomain only returns cookies for the requested domain', async () => {
    chrome._state.cookies.push(
      { name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false },
      { name: 'b', value: '2', domain: 'other.com', path: '/', secure: false, httpOnly: false },
    );
    const cookies = await getCookiesForDomain('example.com');
    expect(cookies.map(c => c.name)).toEqual(['a']);
  });

  it('setCookiesForDomain replaces all existing cookies for the domain', async () => {
    chrome._state.cookies.push({ name: 'stale', value: 'x', domain: 'example.com', path: '/', secure: false, httpOnly: false });

    await setCookiesForDomain('example.com', [
      { name: 'fresh', value: 'y', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' },
    ]);

    const names = chrome._state.cookies.filter(c => c.domain === 'example.com').map(c => c.name);
    expect(names).toEqual(['fresh']);
  });

  it('setCookiesForDomain builds an https url for secure cookies and strips a leading dot from the domain', async () => {
    await setCookiesForDomain('example.com', [
      { name: 'a', value: '1', domain: '.example.com', path: '/admin', secure: true, httpOnly: false, sameSite: 'strict' },
    ]);

    const stored = chrome._state.cookies.find(c => c.name === 'a');
    expect(stored.url).toBe('https://example.com/admin');
  });

  it('setCookiesForDomain builds an http url for non-secure cookies', async () => {
    await setCookiesForDomain('example.com', [
      { name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' },
    ]);

    const stored = chrome._state.cookies.find(c => c.name === 'a');
    expect(stored.url).toBe('http://example.com/');
  });

  it('setCookiesForDomain only sets expirationDate when the cookie has one (session cookies stay session cookies)', async () => {
    await setCookiesForDomain('example.com', [
      { name: 'persistent', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax', expirationDate: 1999999999 },
      { name: 'session', value: '2', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' },
    ]);

    expect(chrome._state.cookies.find(c => c.name === 'persistent').expirationDate).toBe(1999999999);
    expect(chrome._state.cookies.find(c => c.name === 'session')).not.toHaveProperty('expirationDate');
  });

  const cookie = (name, domain, extra = {}) => ({
    name, value: 'v', domain, path: '/', secure: false, httpOnly: false, sameSite: 'lax', ...extra,
  });

  it('cookiesWithin keeps the domain and its subdomains only', () => {
    const kept = [cookie('a', 'example.com'), cookie('b', '.example.com'), cookie('c', 'app.example.com')];
    const dropped = [
      cookie('d', 'evil.com'),
      cookie('e', 'notexample.com'),
      cookie('f', 42),
      cookie('g', 'example.com', { path: 'admin' }),
      cookie('h', 'example.com', { value: null }),
      null,
    ];
    expect(cookiesWithin([...kept, ...dropped], 'example.com')).toEqual(kept);
    expect(cookiesWithin('nope', 'example.com')).toEqual([]);
    expect(cookiesWithin(undefined, 'example.com')).toEqual([]);
  });

  it('setCookiesForDomain restores a dot-domain cookie as a domain cookie', async () => {
    const set = vi.spyOn(chrome.cookies, 'set');
    await setCookiesForDomain('example.com', [cookie('dom', '.example.com'), cookie('host', 'example.com')]);

    expect(set.mock.calls.find(([d]) => d.name === 'dom')[0].domain).toBe('.example.com');
    expect(set.mock.calls.find(([d]) => d.name === 'host')[0]).not.toHaveProperty('domain');
    expect(chrome._state.cookies.map(c => c.domain).sort()).toEqual(['.example.com', 'example.com']);
  });

  it('setCookiesForDomain never passes an out-of-scope cookie to cookies.set', async () => {
    const set = vi.spyOn(chrome.cookies, 'set');
    await setCookiesForDomain('app.example.com', [
      cookie('in', 'app.example.com'),
      cookie('base', '.example.com'),
      cookie('sibling', 'www.example.com'),
      cookie('evil', 'evil.com'),
    ]);

    expect(set.mock.calls.map(([d]) => d.name)).toEqual(['in']);
  });

  it('setCookiesForDomain on a host leaves .base and sibling-host cookies in the jar', async () => {
    chrome._state.cookies = [
      cookie('old', 'app.example.com'),
      cookie('base', '.example.com'),
      cookie('sibling', 'www.example.com'),
    ];
    await setCookiesForDomain('app.example.com', [cookie('new', 'app.example.com')]);

    expect(chrome._state.cookies.map(c => c.name).sort()).toEqual(['base', 'new', 'sibling']);
  });

  it('setCookiesForDomain on a base removes .base and sibling-host cookies first', async () => {
    chrome._state.cookies = [
      cookie('base', '.example.com'),
      cookie('sibling', 'www.example.com'),
      cookie('host', 'example.com'),
      cookie('other', 'other.com'),
    ];
    const given = [cookie('sid', '.example.com'), cookie('app', 'app.example.com')];
    await setCookiesForDomain('example.com', given);

    const jar = chrome._state.cookies.filter(c => c.domain !== 'other.com');
    expect(jar.map(({ name, domain }) => ({ name, domain }))).toEqual(given.map(({ name, domain }) => ({ name, domain })));
    expect(chrome._state.cookies.some(c => c.name === 'other')).toBe(true);
  });

  it('setCookiesForDomain keeps a host-only and a domain cookie of the same name distinct', async () => {
    const both = [cookie('sid', 'example.com', { value: 'host' }), cookie('sid', '.example.com', { value: 'domain' })];
    chrome._state.cookies = both.map(c => ({ ...c, value: 'stale' }));

    await setCookiesForDomain('example.com', both);

    expect(chrome._state.cookies.map(({ domain, value }) => ({ domain, value })).sort((a, b) => a.domain.localeCompare(b.domain)))
      .toEqual([{ domain: '.example.com', value: 'domain' }, { domain: 'example.com', value: 'host' }]);
  });
});
