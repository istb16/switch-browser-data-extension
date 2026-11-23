import { describe, it, expect, vi } from 'vitest';

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

  it('storage events are queued and delivered on request', async () => {
    const listener = vi.fn();
    chrome.storage.onChanged.addListener(listener);
    await chrome.storage.local.set({ a: { n: 1 }, b: 'same' });
    await chrome.storage.local.set({ a: { n: 2 }, b: 'same' });
    await chrome.storage.local.set({ b: 'same' });
    await chrome.storage.local.remove(['b', 'missing']);
    expect(listener).not.toHaveBeenCalled();

    chrome._deliverStorageEvents();

    expect(listener.mock.calls).toEqual([
      [{ a: { newValue: { n: 1 } }, b: { newValue: 'same' } }, 'local'],
      [{ a: { oldValue: { n: 1 }, newValue: { n: 2 } } }, 'local'],
      [{ b: { oldValue: 'same' } }, 'local'],
    ]);

    listener.mockClear();
    await chrome.storage.local.clear();
    chrome._deliverStorageEvents();
    chrome._deliverStorageEvents();
    expect(listener.mock.calls).toEqual([[{ a: { oldValue: { n: 2 } } }, 'local']]);
    chrome.storage.onChanged.removeListener(listener);
  });

  it('per-tab and default badge colours are recorded apart', async () => {
    await chrome.action.setBadgeBackgroundColor({ color: '#000000' });
    await chrome.action.setBadgeTextColor({ color: '#111111' });
    await chrome.action.setBadgeBackgroundColor({ tabId: 1, color: '#C5221F' });
    await chrome.action.setBadgeBackgroundColor({ tabId: 1, color: '#1F63D8' });
    await chrome.action.setBadgeTextColor({ tabId: 1, color: '#FFFFFF' });
    await chrome.action.setBadgeBackgroundColor({ tabId: 2, color: '#F6B820' });
    await chrome.action.setBadgeTextColor({ tabId: 2, color: '#1B1C20' });

    expect(chrome._state.badgeBackgrounds).toEqual({ 1: '#1F63D8', 2: '#F6B820' });
    expect(chrome._state.badgeTextColors).toEqual({ 1: '#FFFFFF', 2: '#1B1C20' });
    expect(chrome._state.badgeDefaultBackground).toBe('#000000');
    expect(chrome._state.badgeDefaultTextColor).toBe('#111111');
  });

  it('a held get resolves with the data from call time', async () => {
    await chrome.storage.local.set({ a: 1, b: 1 });
    const held = chrome._holdGet(keys => keys.includes('a'));

    expect(await chrome.storage.local.get('b')).toEqual({ b: 1 });
    let result;
    const pending = chrome.storage.local.get(['a', 'b']).then(value => { result = value; });
    await chrome.storage.local.set({ a: 2, b: 2 });
    await Promise.resolve();
    expect(result).toBeUndefined();

    held.release();
    await pending;
    expect(result).toEqual({ a: 1, b: 1 });
    expect(await chrome.storage.local.get('a')).toEqual({ a: 2 });
  });
});
