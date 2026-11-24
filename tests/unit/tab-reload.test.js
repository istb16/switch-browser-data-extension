import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectOtherTabs, reloadAfterApply, reloadAfterChange } from '../../lib/tab-reload.js';
import { resolveScope } from '../../lib/groups.js';

const TYPES = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };
const SETTINGS = { enabledTypes: TYPES, autoBackup: true, autoReload: true, reloadOtherTabs: true };
const COOKIE = { name: 'sid', value: 'bob', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' };
const SNAPSHOT = { cookies: [COOKIE], localStorage: { user: 'bob' } };
const ALL_APPLIED = { cookiesApplied: true, storageApplied: true, sharedStorageApplied: true };

let tab;

function addTabs(...tabs) {
  chrome._state.tabs.push(...tabs.map(t => ({ incognito: false, ...t })));
}

function reload(overrides = {}, applied = ALL_APPLIED) {
  return reloadAfterApply({
    tab,
    scope: resolveScope('example.com', []),
    settings: SETTINGS,
    storeKey: 'example.com',
    data: SNAPSHOT,
    ...overrides,
  }, applied);
}

beforeEach(() => {
  tab = { id: 1, url: 'https://example.com/app', incognito: false };
  addTabs({ ...tab });
});

describe('lib/tab-reload selectOtherTabs', () => {
  it('returns [] without querying unless autoReload and reloadOtherTabs are on', async () => {
    addTabs({ id: 2, url: 'https://example.com/other' });
    const query = vi.spyOn(chrome.tabs, 'query');
    const target = { sameOrigin: true, cookieDomain: 'example.com' };

    expect(await selectOtherTabs(tab, { ...SETTINGS, autoReload: false }, target)).toEqual([]);
    expect(await selectOtherTabs(tab, { ...SETTINGS, reloadOtherTabs: false }, target)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect((await selectOtherTabs(tab, SETTINGS, target)).map(t => t.id)).toEqual([2]);
  });

  it('returns [] and logs when tabs.query rejects', async () => {
    vi.spyOn(chrome.tabs, 'query').mockRejectedValue(new Error('query failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await selectOtherTabs(tab, SETTINGS, { sameOrigin: true, cookieDomain: 'example.com' })).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('lib/tab-reload reloadAfterApply', () => {
  it('with cookies applied stores the check before reloading the tab and leaves the others to it', async () => {
    addTabs({ id: 2, url: 'https://example.com/other' });
    const set = vi.spyOn(chrome.storage.local, 'set');
    const update = vi.spyOn(chrome.tabs, 'update');

    expect(await reload()).toBe(1);

    expect(chrome._state.storage.cookieChecks[1]).toMatchObject({
      domain: 'example.com', cookieDomain: 'example.com', cookieExact: true,
      cookies: [expect.objectContaining({ value: 'bob' })],
      reloadTabs: [{ id: 2, origin: 'https://example.com' }],
    });
    const checkWrite = set.mock.calls.findIndex(([items]) => 'cookieChecks' in items);
    expect(set.mock.invocationCallOrder[checkWrite]).toBeLessThan(update.mock.invocationCallOrder[0]);
    expect(chrome._state.reloadedTabs).toEqual([1]);
  });

  it('without cookies applied starts no check and reloads the tab, then the others', async () => {
    addTabs({ id: 2, url: 'https://example.com/other' });

    expect(await reload({}, { ...ALL_APPLIED, cookiesApplied: false })).toBe(1);
    expect(chrome._state.storage.cookieChecks ?? {}).toEqual({});
    expect(chrome._state.reloadedTabs).toEqual([1, 2]);
  });

  it('starts no check when cookies are off or the data has none', async () => {
    await reload({ settings: { ...SETTINGS, enabledTypes: { ...TYPES, cookies: false } } });
    expect(chrome._state.storage.cookieChecks ?? {}).toEqual({});

    await reload({ data: { localStorage: { user: 'bob' } } });
    expect(chrome._state.storage.cookieChecks ?? {}).toEqual({});
  });

  it('with only sessionStorage applied reloads no other tab', async () => {
    addTabs(
      { id: 2, url: 'https://example.com/other' },
      { id: 3, url: 'https://sub.example.com/' },
    );

    const applied = { cookiesApplied: false, storageApplied: true, sharedStorageApplied: false };
    expect(await reload({}, applied)).toBe(0);
    expect(chrome._state.reloadedTabs).toEqual([1]);
  });

  it('with only localStorage applied reloads the same-origin tabs and none that only shares the cookie domain', async () => {
    addTabs(
      { id: 2, url: 'https://example.com/other' },
      { id: 3, url: 'https://sub.example.com/' },
      { id: 4, url: 'https://example.com:8443/' },
    );

    const applied = { cookiesApplied: false, storageApplied: true, sharedStorageApplied: true };
    expect(await reload({}, applied)).toBe(1);
    expect(chrome._state.reloadedTabs).toEqual([1, 2]);
  });

  it('with only cookies applied hands over the tabs within the cookie domain, not other sites', async () => {
    addTabs(
      { id: 2, url: 'https://example.com/other' },
      { id: 3, url: 'https://sub.example.com/' },
      { id: 4, url: 'https://example.com:8443/' },
      { id: 5, url: 'https://other.test/' },
    );

    const applied = { cookiesApplied: true, storageApplied: false, sharedStorageApplied: false };
    expect(await reload({}, applied)).toBe(3);
    expect(chrome._state.storage.cookieChecks[1].reloadTabs).toEqual([
      { id: 2, origin: 'https://example.com' },
      { id: 3, origin: 'https://sub.example.com' },
      { id: 4, origin: 'https://example.com:8443' },
    ]);
    expect(chrome._state.reloadedTabs).toEqual([1]);
  });

  it('for a snapshot stored under another host of the group hands over only that host\'s tabs', async () => {
    tab = { id: 1, url: 'https://app.example.com/', incognito: false };
    chrome._state.tabs[0].url = tab.url;
    addTabs(
      { id: 2, url: 'https://app.example.com/other' },
      { id: 3, url: 'https://www.example.com/' },
    );

    const applied = { cookiesApplied: true, storageApplied: false, sharedStorageApplied: false, storageSkipped: true };
    expect(await reload({
      scope: resolveScope('app.example.com', ['example.com']),
      storeKey: 'www.example.com',
      data: { cookies: [{ ...COOKIE, domain: 'www.example.com' }] },
    }, applied)).toBe(1);
    expect(chrome._state.storage.cookieChecks[1]).toMatchObject({
      domain: 'example.com', cookieDomain: 'www.example.com', cookieExact: true,
      reloadTabs: [{ id: 3, origin: 'https://www.example.com' }],
    });
  });

  it('with auto reload off still starts the check and reloads nothing', async () => {
    addTabs({ id: 2, url: 'https://example.com/other' });

    expect(await reload({ settings: { ...SETTINGS, autoReload: false } })).toBe(0);
    expect(chrome._state.reloadedTabs).toEqual([]);
    expect(chrome._state.storage.cookieChecks[1].reloadTabs).toEqual([]);
  });

  it('does not throw when the tab is closed before the reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    addTabs({ id: 2, url: 'https://example.com/other' });
    vi.spyOn(chrome.tabs, 'get').mockRejectedValue(new Error('No tab with id: 1.'));

    expect(await reload()).toBe(1);
    expect(chrome._state.storage.cookieChecks[1]).toBeDefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('reloads an active tab whose URL has a fragment instead of navigating', async () => {
    tab = { id: 1, url: 'https://example.com/app#section', incognito: false };
    chrome._state.tabs[0].url = tab.url;

    await reload();
    expect(chrome._state.reloadedTabs).toEqual([1]);
    expect(chrome._state.navigatedTabs).toEqual([]);
  });
});

describe('lib/tab-reload reloadAfterChange', () => {
  const OTHERS = [{ id: 2, url: 'https://example.com/other' }, { id: 3, url: 'https://example.com/more' }];

  beforeEach(() => {
    addTabs(...OTHERS);
  });

  it('with auto reload off reloads no tab', async () => {
    expect(await reloadAfterChange(tab, { ...SETTINGS, autoReload: false }, [], false)).toBe(0);
    expect(chrome._state.reloadedTabs).toEqual([]);
    expect(chrome._state.navigatedTabs).toEqual([]);
  });

  it('with deferred true reloads only the active tab and returns others.length', async () => {
    expect(await reloadAfterChange(tab, SETTINGS, OTHERS, true)).toBe(2);
    expect(chrome._state.reloadedTabs).toEqual([1]);
  });

  it('still reloads the others when the active tab was closed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    chrome._state.tabs.splice(0, 1);

    expect(await reloadAfterChange(tab, SETTINGS, OTHERS, false)).toBe(2);
    expect(chrome._state.reloadedTabs).toEqual([2, 3]);
    expect(console.error).toHaveBeenCalled();
  });

  it('counts only the tabs that did reload', async () => {
    chrome._state.tabs.splice(2, 1);

    expect(await reloadAfterChange(tab, SETTINGS, OTHERS, false)).toBe(1);
    expect(chrome._state.reloadedTabs).toEqual([1, 2]);
  });
});
