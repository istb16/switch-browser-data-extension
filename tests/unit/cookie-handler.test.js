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

  it('cookiesWithin drops a domain that is not a hostname, even when its suffix matches', () => {
    const crafted = [
      cookie('hash', 'evil.com#.example.com'),
      cookie('query', 'evil.com?.example.com'),
      cookie('slash', 'evil.com/.example.com'),
      cookie('at', 'evil.com@.example.com'),
      cookie('port', 'evil.com:80.example.com'),
      cookie('space', 'evil.com .example.com'),
      cookie('empty', ''),
      cookie('dots', '..example.com'),
    ];
    expect(cookiesWithin(crafted, 'example.com')).toEqual([]);
  });

  it.each([
    ['an underscore', 'a_b.example.com', 'example.com'],
    ['a hyphen', 'my-app.example.com', 'example.com'],
    ['a dot-domain', '.example.com', 'example.com'],
    ['an IPv4 address', '127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost', 'localhost'],
    ['a punycode label', 'xn--bcher-kva.example.com', 'example.com'],
    ['a bracketed IPv6 address', '[::1]', '[::1]'],
    ['a full IPv6 address', '[2001:db8::1]', '[2001:db8::1]'],
  ])('cookiesWithin keeps a domain with %s', (_label, domain, scope) => {
    const kept = [cookie('a', domain)];
    expect(cookiesWithin(kept, scope)).toEqual(kept);
    expect(cookiesWithin(kept, { domain: domain.replace(/^\./, ''), exact: true })).toEqual(kept);
  });

  // Chrome reports cookie domains in lower case, so the scope is compared as is:
  // an upper-case domain passes the hostname check but only matches its own case.
  it('cookiesWithin compares the domain with the scope case-sensitively', () => {
    const upper = [cookie('a', '.Example.com')];
    expect(cookiesWithin(upper, 'example.com')).toEqual([]);
    expect(cookiesWithin(upper, 'Example.com')).toEqual(upper);
  });

  it('cookiesWithin drops a domain the URL parser reads as another host', () => {
    expect(cookiesWithin([cookie('hex', '0x7f.0.0.1')], '0x7f.0.0.1')).toEqual([]);
    expect(cookiesWithin([cookie('short', '[0:0::1]')], '[0:0::1]')).toEqual([]);
  });

  it('cookiesWithin drops an IPv6 address with a dot prefix or without brackets', () => {
    expect(cookiesWithin([cookie('dot', '.[::1]')], '[::1]')).toEqual([]);
    expect(cookiesWithin([cookie('bare', '::1')], '::1')).toEqual([]);
  });

  it('setCookiesForDomain restores the saved cookies of an IPv6 host', async () => {
    chrome._state.cookies = [cookie('sid', '[::1]', { value: 'current' })];
    await setCookiesForDomain({ domain: '[::1]', exact: true }, [cookie('sid', '[::1]', { value: 'saved' })]);

    expect(chrome._state.cookies).toEqual([expect.objectContaining({ name: 'sid', value: 'saved', domain: '[::1]', url: 'http://[::1]/' })]);
  });

  it('setCookiesForDomain never sets a crafted domain on another host', async () => {
    const set = vi.spyOn(chrome.cookies, 'set');
    await setCookiesForDomain('example.com', [cookie('evil', 'evil.com#.example.com'), cookie('ok', 'example.com')]);

    expect(set.mock.calls.map(([d]) => d.name)).toEqual(['ok']);
    expect(set.mock.calls.every(([d]) => new URL(d.url).hostname === 'example.com')).toBe(true);
  });

  it('cookiesWithin with exact keeps only the host and its dot-domain', () => {
    const kept = [cookie('a', 'example.com'), cookie('b', '.example.com')];
    const dropped = [cookie('c', 'app.example.com'), cookie('d', '.app.example.com')];
    expect(cookiesWithin([...kept, ...dropped], { domain: 'example.com', exact: true })).toEqual(kept);
    expect(cookiesWithin([...kept, ...dropped], { domain: 'example.com', exact: false })).toEqual([...kept, ...dropped]);
  });

  it('setCookiesForDomain with exact leaves sibling-host cookies in the jar and does not set them', async () => {
    chrome._state.cookies = [
      cookie('old', 'example.com'),
      cookie('base', '.example.com'),
      cookie('sibling', 'www.example.com'),
      cookie('sid', 'app.example.com'),
    ];
    const set = vi.spyOn(chrome.cookies, 'set');
    await setCookiesForDomain({ domain: 'example.com', exact: true }, [cookie('new', 'example.com'), cookie('app', 'app.example.com')]);

    expect(set.mock.calls.map(([d]) => d.name)).toEqual(['new']);
    expect(chrome._state.cookies.map(c => `${c.domain}:${c.name}`).sort())
      .toEqual(['app.example.com:sid', 'example.com:new', 'www.example.com:sibling']);
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

  it('setCookiesForDomain removes every existing cookie before setting any', async () => {
    chrome._state.cookies = [cookie('a', 'example.com'), cookie('b', '.example.com'), cookie('c', 'app.example.com')];
    const events = [];
    const realRemove = chrome.cookies.remove;
    vi.spyOn(chrome.cookies, 'remove').mockImplementation(async details => {
      events.push(`remove-start:${details.name}`);
      await new Promise(resolve => setTimeout(resolve, details.name === 'a' ? 10 : 0));
      events.push(`remove-end:${details.name}`);
      return realRemove(details);
    });
    const realSet = chrome.cookies.set;
    vi.spyOn(chrome.cookies, 'set').mockImplementation(details => {
      events.push(`set:${details.name}`);
      return realSet(details);
    });

    await setCookiesForDomain('example.com', [cookie('new', 'example.com')]);

    const lastRemoveEnd = events.findLastIndex(e => e.startsWith('remove-end:'));
    const firstSet = events.findIndex(e => e.startsWith('set:'));
    expect(events.filter(e => e.startsWith('remove-end:'))).toHaveLength(3);
    expect(firstSet).toBeGreaterThan(lastRemoveEnd);
    expect(events.slice(0, 3).every(e => e.startsWith('remove-start:'))).toBe(true);
    expect(chrome._state.cookies.map(c => c.name)).toEqual(['new']);
  });

  it('setCookiesForDomain keeps the last value of a duplicate name/domain/path', async () => {
    await setCookiesForDomain('example.com', [
      cookie('sid', 'example.com', { value: 'first' }),
      cookie('sid', 'example.com', { value: 'last' }),
    ]);

    expect(chrome._state.cookies.map(({ name, value }) => ({ name, value }))).toEqual([{ name: 'sid', value: 'last' }]);
  });

  it('setCookiesForDomain sets both a host-only and a domain cookie of the same name into an empty jar', async () => {
    await setCookiesForDomain('example.com', [cookie('sid', 'example.com', { value: 'host' }), cookie('sid', '.example.com', { value: 'domain' })]);

    expect(chrome._state.cookies.map(({ domain, value }) => `${domain}:${value}`).sort())
      .toEqual(['.example.com:domain', 'example.com:host']);
  });
});
