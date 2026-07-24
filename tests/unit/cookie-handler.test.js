import { describe, it, expect } from 'vitest';
import { getCookiesForDomain, setCookiesForDomain } from '../../lib/cookie-handler.js';

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
});
