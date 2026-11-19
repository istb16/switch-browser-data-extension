import { describe, it, expect } from 'vitest';

const cookie = (name, domain, extra = {}) => ({ name, value: 'v', domain, path: '/', secure: false, ...extra });
const names = () => chrome._state.cookies.map(c => `${c.name}@${c.domain}`).sort();

describe('chrome mock', () => {
  it('getAll matches the domain and its subdomains, with or without a leading dot', async () => {
    chrome._state.cookies = [
      cookie('host', 'example.com'),
      cookie('base', '.example.com'),
      cookie('app', 'app.example.com'),
      cookie('not', 'notexample.com'),
      cookie('other', 'other.com'),
    ];
    for (const domain of ['example.com', '.example.com']) {
      expect((await chrome.cookies.getAll({ domain })).map(c => c.name)).toEqual(['host', 'base', 'app']);
    }
    expect((await chrome.cookies.getAll({ domain: 'app.example.com' })).map(c => c.name)).toEqual(['app']);
  });

  it('set stores a host-only cookie without domain and replaces by name, domain and path', async () => {
    await chrome.cookies.set({ url: 'https://app.example.com/', name: 'sid', value: '1', path: '/' });
    await chrome.cookies.set({ url: 'https://app.example.com/', name: 'sid', value: '2', path: '/', domain: 'example.com' });
    await chrome.cookies.set({ url: 'https://app.example.com/a', name: 'sid', value: '3', path: '/a' });
    await chrome.cookies.set({ url: 'https://app.example.com/', name: 'sid', value: '4', path: '/' });

    expect(chrome._state.cookies.map(({ domain, path, value }) => ({ domain, path, value }))).toEqual([
      { domain: '.example.com', path: '/', value: '2' },
      { domain: 'app.example.com', path: '/a', value: '3' },
      { domain: 'app.example.com', path: '/', value: '4' },
    ]);
  });

  it('a URL on a subdomain removes a same-name .base domain cookie', async () => {
    chrome._state.cookies = [cookie('sid', '.example.com')];
    await chrome.cookies.remove({ url: 'https://app.example.com/', name: 'sid' });
    expect(chrome._state.cookies).toEqual([]);
  });

  it('a URL on the base removes the .base domain cookie', async () => {
    chrome._state.cookies = [cookie('sid', '.example.com')];
    await chrome.cookies.remove({ url: 'https://example.com/', name: 'sid' });
    expect(chrome._state.cookies).toEqual([]);
  });

  it('a host-only cookie is removed only by a URL on exactly its host', async () => {
    chrome._state.cookies = [cookie('sid', 'www.example.com'), cookie('sid', 'example.com')];
    await chrome.cookies.remove({ url: 'https://example.com/', name: 'sid' });
    expect(names()).toEqual(['sid@www.example.com']);

    await chrome.cookies.remove({ url: 'https://app.www.example.com/', name: 'sid' });
    expect(names()).toEqual(['sid@www.example.com']);

    await chrome.cookies.remove({ url: 'https://www.example.com/', name: 'sid' });
    expect(names()).toEqual([]);
  });

  it('remove needs the name and path to match', async () => {
    chrome._state.cookies = [cookie('sid', 'example.com', { path: '/admin' })];
    await chrome.cookies.remove({ url: 'https://example.com/', name: 'sid' });
    await chrome.cookies.remove({ url: 'https://example.com/admin', name: 'other' });
    expect(chrome._state.cookies).toHaveLength(1);

    await chrome.cookies.remove({ url: 'https://example.com/admin', name: 'sid' });
    expect(chrome._state.cookies).toEqual([]);
  });

  it('remove leaves a same-name cookie on an unrelated host', async () => {
    chrome._state.cookies = [cookie('sid', 'example.com'), cookie('sid', '.other.com')];
    await chrome.cookies.remove({ url: 'https://example.com/', name: 'sid' });
    expect(names()).toEqual(['sid@.other.com']);
  });

  it('permissions.contains honours *. patterns; remove drops only the listed origin', async () => {
    await chrome.permissions.request({ origins: ['*://example.com/*', '*://*.example.com/*'] });

    expect(await chrome.permissions.contains({ origins: ['*://app.example.com/*'] })).toBe(true);
    expect(await chrome.permissions.contains({ origins: ['*://*.example.com/*'] })).toBe(true);
    expect(await chrome.permissions.contains({ origins: ['*://*.app.example.com/*'] })).toBe(true);
    expect(await chrome.permissions.contains({ origins: ['*://notexample.com/*'] })).toBe(false);
    expect(await chrome.permissions.contains({ origins: ['*://app.example.com/*', '*://other.com/*'] })).toBe(false);

    await chrome.permissions.remove({ origins: ['*://*.example.com/*'] });

    expect(await chrome.permissions.contains({ origins: ['*://example.com/*'] })).toBe(true);
    expect(await chrome.permissions.contains({ origins: ['*://app.example.com/*'] })).toBe(false);
    expect([...chrome._state.grantedOrigins]).toEqual(['*://example.com/*']);
  });
});
