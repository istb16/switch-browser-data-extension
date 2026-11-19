import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCookieCheck, getVolatileCookiesFor } from '../../lib/volatile-cookies.js';
import { setActiveSnapshots, setSettings, getSettings, setGroups } from '../../lib/storage.js';

const sid = value => ({ name: 'sid', value, domain: 'a.com', path: '/' });
const tab = { id: 1, url: 'https://a.com/page' };
const A_SCOPE = { origins: ['*://a.com/*'], cookieDomain: 'a.com', cookieExact: false };

async function loadServiceWorker() {
  vi.resetModules();
  await import('../../background/service-worker.js');
}

describe('background/service-worker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });

  afterEach(() => vi.useRealTimers());

  it('learns the cookies the site rewrote on the first load after a snapshot was applied', async () => {
    chrome._state.grantedOrigins.add('*://a.com/*');
    await loadServiceWorker();
    await startCookieCheck(1, 'a.com', [sid('applied')], A_SCOPE);
    chrome._state.cookies = [sid('rotated')];

    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|sid': 'value' });
  });

  it('learns nothing without the host permission, where every cookie would look gone', async () => {
    await loadServiceWorker();
    await startCookieCheck(1, 'a.com', [sid('applied')], A_SCOPE);

    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await getVolatileCookiesFor('a.com')).toEqual({});
  });

  describe('in a subdomain group', () => {
    const ORIGINS = ['*://example.com/*', '*://*.example.com/*'];
    const cookie = (name, domain, value) => ({ name, value, domain, path: '/' });
    const appTab = { id: 1, url: 'https://app.example.com/' };

    it('cookie check uses stored origins and cookieDomain', async () => {
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'example.com', [cookie('parent', '.example.com', 'applied')], { origins: ORIGINS, cookieDomain: 'example.com' });
      chrome._state.cookies = [cookie('parent', '.example.com', 'rotated')];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, appTab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('example.com')).toEqual({ '.example.com|/|parent': 'value' });
    });

    it('a check without origins is dropped, not learned', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      const contains = vi.spyOn(chrome.permissions, 'contains');
      await chrome.storage.local.set({ cookieChecks: { 2: { domain: 'a.com', cookies: [sid('applied')], until: Date.now() + 60_000 } } });
      chrome._state.cookies = [sid('rotated')];

      chrome.tabs.onUpdated.dispatch(2, { status: 'complete' }, { id: 2, url: 'https://a.com/' });
      await vi.advanceTimersByTimeAsync(3000);

      expect(contains).not.toHaveBeenCalled();
      expect(await getVolatileCookiesFor('a.com')).toEqual({});
      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual({});
    });

    it('cookie check after a host-scoped load in a group does not mark sibling cookies volatile', async () => {
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'example.com', [cookie('own', 'app.example.com', 'applied')], { origins: ORIGINS, cookieDomain: 'app.example.com' });
      chrome._state.cookies = [cookie('own', 'app.example.com', 'applied'), cookie('sibling', 'www.example.com', 'x'), cookie('parent', '.example.com', 'y')];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, appTab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('example.com')).toEqual({});
    });

    it('an exact cookie check on the base host does not mark sibling-host cookies volatile', async () => {
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'example.com', [cookie('parent', '.example.com', 'applied')], {
        origins: ORIGINS, cookieDomain: 'example.com', cookieExact: true,
      });
      chrome._state.cookies = [cookie('parent', '.example.com', 'rotated'), cookie('own', 'app.example.com', 'x')];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, { id: 1, url: 'https://example.com/' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('example.com')).toEqual({ '.example.com|/|parent': 'value' });
    });

    it('cookie check learns nothing when the stored origins are not granted', async () => {
      chrome._state.grantedOrigins.add('*://example.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'example.com', [cookie('parent', '.example.com', 'applied')], { origins: ORIGINS, cookieDomain: 'example.com' });
      chrome._state.cookies = [cookie('parent', '.example.com', 'rotated')];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, appTab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('example.com')).toEqual({});
    });

    it('badge shows the group\'s active snapshot on every member host', async () => {
      await setGroups(['example.com']);
      await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'Admin' } });
      await loadServiceWorker();

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, appTab);
      chrome.tabs.onUpdated.dispatch(2, { status: 'complete' }, { id: 2, url: 'https://www.example.com/' });
      await vi.waitFor(() => expect(chrome._state.badges).toMatchObject({ 1: 'Ad', 2: 'Ad' }));

      await setActiveSnapshots({ 'example.com': 'User' });
      chrome._deliverStorageEvents();
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, appTab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Us'));
    });

    it('badge refreshes when groups change', async () => {
      await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'Admin' } });
      await loadServiceWorker();
      chrome.tabs.query = vi.fn().mockResolvedValue([appTab]);

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, appTab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe(''));

      await setGroups(['example.com']);
      chrome.storage.onChanged.dispatch({ groups: { newValue: ['example.com'] } }, 'local');
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
    });
  });

  it('badge for a non-group host is unchanged', async () => {
    await setGroups(['example.com']);
    await setActiveSnapshots({ 'a.com': 'Admin', 'example.com': { host: 'example.com', name: 'Other' } });
    await loadServiceWorker();

    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
  });

  it('badges a tab with the active snapshot of its domain, unless the badge is turned off', async () => {
    await setActiveSnapshots({ 'a.com': 'Admin' });
    await loadServiceWorker();

    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));

    await setSettings({ ...(await getSettings()), showBadge: false });
    chrome._deliverStorageEvents();
    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.waitFor(() => expect(chrome._state.badges[1]).toBe(''));
  });

  describe('badge cache', () => {
    const badgeKeyGets = get => get.mock.calls.filter(([keys]) => [keys].flat().includes('activeSnapshots')).length;

    it('a second tab update reads no badge keys', async () => {
      await setActiveSnapshots({ 'a.com': 'Admin' });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
      const reads = badgeKeyGets(get);
      chrome._state.badges[1] = undefined;

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
      expect(reads).toBe(1);
      expect(badgeKeyGets(get)).toBe(reads);
    });

    it('a change during the first load ends with the newest value', async () => {
      chrome._state.tabs = [tab];
      await setActiveSnapshots({ 'a.com': 'Admin' });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');
      const held = chrome._holdGet(keys => keys.includes('activeSnapshots'));

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await setActiveSnapshots({ 'a.com': 'User' });
      chrome._deliverStorageEvents();
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Us'));
      const heldCall = get.mock.calls.findIndex(([keys]) => [keys].flat().includes('activeSnapshots'));
      expect(heldCall).toBeGreaterThanOrEqual(0);
      const staleRead = get.mock.results[heldCall].value;

      held.release();
      expect((await staleRead).activeSnapshots).toEqual({ 'a.com': 'Admin' });
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      expect(chrome._state.badges[1]).toBe('Us');

      chrome._state.badges[1] = 'zz';
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Us'));
    });

    it('a failed first read is not cached, so the next tab update sets the badge', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setActiveSnapshots({ 'a.com': 'Admin' });
      await loadServiceWorker();
      const get = chrome.storage.local.get;
      vi.spyOn(chrome.storage.local, 'get')
        .mockImplementationOnce(async () => { throw new Error('read failed'); })
        .mockImplementation(get);

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      expect(chrome._state.badges[1]).toBeUndefined();

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
    });

    it('a write to a key the badge does not use keeps the cache and updates no tabs', async () => {
      chrome._state.tabs = [tab];
      await setActiveSnapshots({ 'a.com': 'Admin' });
      chrome._deliverStorageEvents();
      await loadServiceWorker();
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
      const get = vi.spyOn(chrome.storage.local, 'get');
      const query = vi.spyOn(chrome.tabs, 'query');

      await chrome.storage.local.set({ 'snapshots/a.com': { Admin: {} }, snapshotOrder: { 'a.com': ['Admin'] } });
      chrome._deliverStorageEvents();
      chrome.storage.onChanged.dispatch({ activeSnapshots: { newValue: {} } }, 'session');
      await vi.advanceTimersByTimeAsync(0);

      expect(query).not.toHaveBeenCalled();
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(0);
      expect(badgeKeyGets(get)).toBe(0);
    });

    it('on install sets the badge colours and badges every open tab', async () => {
      chrome._state.tabs = [tab, { id: 2, url: 'https://b.com/' }];
      await setActiveSnapshots({ 'a.com': 'Admin' });
      await loadServiceWorker();
      const background = vi.spyOn(chrome.action, 'setBadgeBackgroundColor');
      const text = vi.spyOn(chrome.action, 'setBadgeTextColor');

      chrome.runtime.onInstalled.dispatch({ reason: 'install' });
      await vi.waitFor(() => expect(chrome._state.badges).toEqual({ 1: 'Ad', 2: '' }));
      expect(background).toHaveBeenCalledWith({ color: '#1F63D8' });
      expect(text).toHaveBeenCalledWith({ color: '#FFFFFF' });
    });

    it('after clear() a tab update sets an empty badge without throwing', async () => {
      await setActiveSnapshots({ 'a.com': 'Admin' });
      await loadServiceWorker();
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));

      await chrome.storage.local.clear();
      chrome._deliverStorageEvents();
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe(''));
    });

    it('a check started after the cache loaded is still taken and learned', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);

      await startCookieCheck(1, 'a.com', [sid('applied')], A_SCOPE);
      chrome._state.cookies = [sid('rotated')];
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);

      expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|sid': 'value' });
    });

    it('a taken check is not learned twice', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], A_SCOPE);
      chrome._state.cookies = [sid('rotated')];
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual({});

      chrome._state.cookies = [];
      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|sid': 'value' });
    });
  });
});
