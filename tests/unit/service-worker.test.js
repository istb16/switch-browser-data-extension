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

  describe('reloading the other tabs of a check', () => {
    const csrf = value => ({ name: 'csrf', value, domain: 'a.com', path: '/' });
    const withReload = ids => ({ ...A_SCOPE, reloadTabs: ids.map(id => ({ id, origin: 'https://a.com' })) });

    beforeEach(() => {
      chrome._state.tabs = [tab, { id: 2, url: 'https://a.com/other' }, { id: 3, url: 'https://a.com/third' }];
    });

    it('a load in another tab takes nothing, and the check\'s own tab still learns and reloads them', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2]));
      chrome._state.cookies = [sid('rotated')];

      chrome.tabs.onUpdated.dispatch(2, { status: 'complete' }, { id: 2, url: 'https://a.com/other' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(Object.keys((await chrome.storage.local.get('cookieChecks')).cookieChecks)).toEqual(['1']);
      expect(await getVolatileCookiesFor('a.com')).toEqual({});
      expect(chrome._state.reloadedTabs).toEqual([]);

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|sid': 'value' });
      expect(chrome._state.reloadedTabs).toEqual([2]);
    });

    it('reloads the listed tabs only after the learned cookies are written', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2, 3]));
      chrome._state.cookies = [sid('rotated')];
      const events = [];
      const set = chrome.storage.local.set;
      vi.spyOn(chrome.storage.local, 'set').mockImplementation(async items => {
        if ('volatileCookies' in items) events.push('volatileCookies');
        return set(items);
      });
      const update = chrome.tabs.update;
      vi.spyOn(chrome.tabs, 'update').mockImplementation(async (id, details) => {
        events.push(`reload ${id}`);
        return update(id, details);
      });

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(events).toEqual(['volatileCookies', 'reload 2', 'reload 3']);
    });

    it('a cookie a reloaded tab writes back is not learned', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied'), csrf('a')], withReload([2]));
      chrome._state.cookies = [sid('applied'), csrf('b')];
      vi.spyOn(chrome.tabs, 'update').mockImplementation(async () => {
        chrome._state.cookies = [sid('previous account'), csrf('c')];
      });

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      chrome.tabs.onUpdated.dispatch(2, { status: 'complete' }, { id: 2, url: 'https://a.com/other' });
      await vi.advanceTimersByTimeAsync(3000);

      expect(chrome.tabs.update).toHaveBeenCalledWith(2, { url: 'https://a.com/other' });
      expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|csrf': 'value' });
    });

    it('an expired check still reloads its tabs and learns nothing', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: 0 });
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2]));
      chrome._state.cookies = [sid('rotated')];
      vi.setSystemTime(61_000);

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('a.com')).toEqual({});
      expect(chrome._state.reloadedTabs).toEqual([2]);
    });

    it('a check without the permission still reloads its tabs and learns nothing', async () => {
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2]));
      chrome._state.cookies = [sid('rotated')];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('a.com')).toEqual({});
      expect(chrome._state.reloadedTabs).toEqual([2]);
    });

    it('still reloads its tabs when learning fails, and reports the failure', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2]));
      const failure = new Error('cookies unavailable');
      vi.spyOn(chrome.cookies, 'getAll').mockRejectedValue(failure);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(chrome._state.reloadedTabs).toEqual([2]);
      expect(error).toHaveBeenCalledWith(failure);
      expect(await getVolatileCookiesFor('a.com')).toEqual({});
    });

    it('a tab that fails to reload does not stop the others', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2, 3]));
      const update = chrome.tabs.update;
      vi.spyOn(chrome.tabs, 'update').mockImplementation(async (id, details) => {
        if (id === 2) throw new Error('No tab with id: 2');
        return update(id, details);
      });

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(chrome._state.reloadedTabs).toEqual([3]);
    });

    it('leaves out a listed tab that has since moved to another origin or been discarded', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2, 3, 4, 5, 6, 7]));
      chrome._state.tabs = [
        tab,
        { id: 2, url: 'https://other.com/' },
        { id: 3, url: 'https://a.com/third', discarded: true },
        { id: 4, url: 'https://a.com/fourth', status: 'unloaded' },
        { id: 5, url: 'http://a.com/insecure' },
        { id: 6, url: 'chrome://newtab/' },
        { id: 7, url: 'https://a.com/still', status: 'complete' },
      ];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(chrome._state.reloadedTabs).toEqual([7]);
      expect(chrome._state.navigatedTabs).toEqual([{ tabId: 7, url: 'https://a.com/still' }]);
    });

    it('an expired check re-checks its tabs too, minutes later', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: 0 });
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], withReload([2, 3]));
      vi.setSystemTime(5 * 60_000);
      chrome._state.tabs = [tab, { id: 2, url: 'https://unrelated.example/' }, { id: 3, url: 'https://a.com/third' }];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(chrome._state.reloadedTabs).toEqual([3]);
    });

    it('a check stored with plain tab ids by an older version reloads none of them', async () => {
      chrome._state.grantedOrigins.add('*://a.com/*');
      await loadServiceWorker();
      await startCookieCheck(1, 'a.com', [sid('applied')], { ...A_SCOPE, reloadTabs: [2, 3] });
      chrome._state.cookies = [sid('rotated')];

      chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|sid': 'value' });
      expect(chrome._state.reloadedTabs).toEqual([]);
    });
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

  it('badges a tab whose active record is an object with types under a plain host key', async () => {
    await setActiveSnapshots({ 'a.com': { host: 'a.com', name: 'Admin', types: ['cookies'] } });
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

  describe('badge colour', () => {
    const DEFAULT = ['#1F63D8', '#FFFFFF'];
    const RED = ['#C5221F', '#FFFFFF'];
    const GREEN = ['#1E7E45', '#FFFFFF'];
    const AMBER = ['#F6B820', '#1B1C20'];
    const bTab = { id: 2, url: 'https://b.com/' };
    const pair = id => [chrome._state.badgeBackgrounds[id], chrome._state.badgeTextColors[id]];
    const snapshotGets = (get, key) => get.mock.calls
      .filter(([keys]) => [keys].flat().some(k => typeof k === 'string' && (key ? k === key : k.startsWith('snapshots/'))))
      .length;
    const draw = t => chrome.tabs.onUpdated.dispatch(t.id, { status: 'complete' }, t);

    async function seed(items) {
      await chrome.storage.local.set(items);
      chrome._deliverStorageEvents();
    }

    // A change that must redraw every open tab. Its draw starts behind anything an earlier
    // event started, so once it lands a redraw or read that event caused has been made too.
    // A badge key change moves the generation, so a draw started before it sets no badge
    // afterwards: every setBadgeText call made after the dispatch is this redraw's own.
    async function redrawEveryTab() {
      expect(chrome._state.tabs.length).toBeGreaterThan(0);
      const setText = vi.spyOn(chrome.action, 'setBadgeText');
      const before = setText.mock.calls.length;
      chrome.storage.onChanged.dispatch({ groups: { newValue: [] } }, 'local');
      await vi.waitFor(() => {
        const drawn = new Set(setText.mock.calls.slice(before).map(([{ tabId }]) => tabId));
        for (const t of chrome._state.tabs) expect(drawn.has(t.id)).toBe(true);
      });
    }

    it('badges a tab in the active snapshot\'s label colour', async () => {
      chrome._state.tabs = [tab, bTab];
      await seed({
        activeSnapshots: { 'a.com': 'Admin', 'b.com': 'Owner' },
        'snapshots/a.com': { Admin: { color: 'red' } },
        'snapshots/b.com': { Owner: { color: 'amber' } },
      });
      await loadServiceWorker();

      draw(tab);
      draw(bTab);
      await vi.waitFor(() => {
        expect(pair(1)).toEqual(RED);
        expect(pair(2)).toEqual(AMBER);
      });
      expect(chrome._state.badges).toEqual({ 1: 'Ad', 2: 'Ow' });
    });

    it('a tab without a label, or with the badge off, gets the default colours', async () => {
      chrome._state.tabs = [tab, bTab];
      await seed({
        activeSnapshots: { 'a.com': 'Admin', 'b.com': 'Owner' },
        'snapshots/a.com': { Admin: {} },
        'snapshots/b.com': { Owner: { color: 'red' } },
      });
      await loadServiceWorker();

      chrome.runtime.onInstalled.dispatch({ reason: 'install' });
      await vi.waitFor(() => {
        expect(pair(1)).toEqual(DEFAULT);
        expect(pair(2)).toEqual(RED);
      });

      await setSettings({ ...(await getSettings()), showBadge: false });
      chrome._deliverStorageEvents();
      await vi.waitFor(() => expect(pair(2)).toEqual(DEFAULT));
      expect(chrome._state.badges).toEqual({ 1: '', 2: '' });
    });

    it('a tab drawn with the badge off, with no host or with no active snapshot reads no snapshot key', async () => {
      chrome._state.tabs = [tab];
      await seed({
        activeSnapshots: { 'a.com': 'Admin' },
        'snapshots/a.com': { Admin: { color: 'red' } },
        'snapshots/b.com': { Owner: { color: 'red' } },
      });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');

      draw({ id: 3, url: 'about:blank' });
      draw(bTab);
      await vi.waitFor(() => {
        expect(pair(3)).toEqual(DEFAULT);
        expect(pair(2)).toEqual(DEFAULT);
      });

      await setSettings({ ...(await getSettings()), showBadge: false });
      chrome._deliverStorageEvents();
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(DEFAULT));
      await redrawEveryTab();
      expect(snapshotGets(get)).toBe(0);
    });

    describe('a red tab returns to the default colours', () => {
      const cases = {
        'when its label is removed': () => seed({ 'snapshots/a.com': { Admin: {} } }),
        'when its active snapshot is deleted': async () => {
          await chrome.storage.local.remove('snapshots/a.com');
          await seed({ activeSnapshots: {} });
        },
        'when all data is cleared': async () => {
          await chrome.storage.local.clear();
          chrome._deliverStorageEvents();
        },
        'when the badge is turned off': async () => {
          await setSettings({ ...(await getSettings()), showBadge: false });
          chrome._deliverStorageEvents();
        },
        'when it navigates to a site with no active snapshot': async () => {
          const moved = { id: 1, url: 'https://c.com/' };
          chrome._state.tabs = [moved];
          chrome.tabs.onUpdated.dispatch(1, { url: moved.url }, moved);
        },
      };

      for (const [name, change] of Object.entries(cases)) {
        it(name, async () => {
          chrome._state.tabs = [tab];
          await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
          await loadServiceWorker();
          draw(tab);
          await vi.waitFor(() => expect(pair(1)).toEqual(RED));

          await change();
          await vi.waitFor(() => expect(pair(1)).toEqual(DEFAULT));
        });
      }
    });

    it('in a group the colour comes from the referenced host\'s snapshot', async () => {
      await setGroups(['example.com']);
      await seed({
        activeSnapshots: { 'example.com': { host: 'app.example.com', name: 'Admin' } },
        'snapshots/app.example.com': { Admin: { color: 'green' } },
        'snapshots/www.example.com': { Admin: { color: 'red' } },
      });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');

      draw({ id: 1, url: 'https://www.example.com/' });
      await vi.waitFor(() => expect(pair(1)).toEqual(GREEN));
      expect(chrome._state.badges[1]).toBe('Ad');
      expect(snapshotGets(get)).toBe(1);
      expect(snapshotGets(get, 'snapshots/app.example.com')).toBe(1);
    });

    it('a snapshot named __proto__ or constructor is badged by its own label', async () => {
      const cTab = { id: 3, url: 'https://c.com/' };
      await seed({
        activeSnapshots: { 'a.com': '__proto__', 'b.com': 'constructor', 'c.com': 'constructor' },
        'snapshots/a.com': JSON.parse('{"__proto__": {"color": "red"}, "constructor": {}}'),
        'snapshots/b.com': JSON.parse('{"__proto__": {}, "constructor": {"color": "red"}}'),
        'snapshots/c.com': { Other: { color: 'red' } },
      });
      await loadServiceWorker();

      draw(tab);
      draw(bTab);
      draw(cTab);
      await vi.waitFor(() => {
        expect(pair(1)).toEqual(RED);
        expect(pair(2)).toEqual(RED);
        expect(pair(3)).toEqual(DEFAULT);
      });

      await seed({ 'snapshots/a.com': JSON.parse('{"__proto__": {}}') });
      chrome._state.tabs = [tab, bTab, cTab];
      chrome.runtime.onStartup.dispatch();
      await vi.waitFor(() => expect(pair(1)).toEqual(DEFAULT));
    });

    it('editing the active snapshot\'s colour redraws without reading the snapshot key', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(RED));
      const get = vi.spyOn(chrome.storage.local, 'get');

      await seed({ 'snapshots/a.com': { Admin: { color: 'amber' } } });
      await vi.waitFor(() => expect(pair(1)).toEqual(AMBER));
      expect(snapshotGets(get)).toBe(0);
    });

    it('a coloured write to a host no tab has drawn redraws nothing and reads nothing', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin', 'b.com': 'Owner' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(RED));
      const get = vi.spyOn(chrome.storage.local, 'get');
      const query = vi.spyOn(chrome.tabs, 'query');

      await seed({ 'snapshots/b.com': { Owner: { color: 'red' } } });
      await redrawEveryTab();
      expect(query).toHaveBeenCalledTimes(1);
      expect(snapshotGets(get)).toBe(0);

      draw(bTab);
      await vi.waitFor(() => expect(pair(2)).toEqual(RED));
      expect(snapshotGets(get)).toBe(1);
      expect(snapshotGets(get, 'snapshots/b.com')).toBe(1);
    });

    it('removing a cached host\'s key resets its tab and forgets the host', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(RED));
      const get = vi.spyOn(chrome.storage.local, 'get');

      await chrome.storage.local.remove('snapshots/a.com');
      await seed({ activeSnapshots: {} });
      await vi.waitFor(() => expect(pair(1)).toEqual(DEFAULT));
      await redrawEveryTab();
      expect(snapshotGets(get)).toBe(0);

      await seed({ 'snapshots/a.com': { Admin: { color: 'red' } }, activeSnapshots: { 'a.com': 'Admin' } });
      await vi.waitFor(() => expect(pair(1)).toEqual(RED));
      expect(snapshotGets(get, 'snapshots/a.com')).toBe(1);
    });

    it('two tabs on one uncached host make one snapshot read', async () => {
      chrome._state.tabs = [tab, { id: 2, url: 'https://a.com/other' }];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');

      chrome.runtime.onInstalled.dispatch({ reason: 'install' });
      await vi.waitFor(() => {
        expect(pair(1)).toEqual(RED);
        expect(pair(2)).toEqual(RED);
      });
      expect(snapshotGets(get, 'snapshots/a.com')).toBe(1);
    });

    it('a colour change during the first snapshot read wins', async () => {
      const zTab = { id: 3, url: 'https://z.com/' };
      chrome._state.tabs = [tab];
      await seed({
        activeSnapshots: { 'a.com': 'Admin', 'z.com': 'Zed' },
        'snapshots/a.com': { Admin: { color: 'red' } },
        'snapshots/z.com': { Zed: { color: 'green' } },
      });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');
      const held = chrome._holdGet(keys => keys.includes('snapshots/a.com'));

      draw(tab);
      await vi.waitFor(() => expect(snapshotGets(get, 'snapshots/a.com')).toBe(1));
      await seed({ 'snapshots/a.com': { Admin: { color: 'amber' } } });
      await vi.waitFor(() => expect(pair(1)).toEqual(AMBER));

      // A draw that waits on a read released right after the stale one takes the same
      // steps behind it, so once it lands the stale draw has finished.
      const heldZ = chrome._holdGet(keys => keys.includes('snapshots/z.com'));
      draw(zTab);
      await vi.waitFor(() => expect(snapshotGets(get, 'snapshots/z.com')).toBe(1));
      held.release();
      heldZ.release();
      await vi.waitFor(() => expect(pair(3)).toEqual(GREEN));
      expect(pair(1)).toEqual(AMBER);

      chrome._state.badgeBackgrounds[1] = undefined;
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(AMBER));
      expect(snapshotGets(get, 'snapshots/a.com')).toBe(2);
    });

    it('a tab that navigates away during its colour read keeps the new site\'s badge', async () => {
      const otherA = { id: 3, url: 'https://a.com/other' };
      chrome._state.tabs = [tab, otherA];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');
      const held = chrome._holdGet(keys => keys.includes('snapshots/a.com'));

      draw(tab);
      await vi.waitFor(() => expect(snapshotGets(get, 'snapshots/a.com')).toBe(1));
      const moved = { id: 1, url: 'https://b.com/' };
      chrome.tabs.onUpdated.dispatch(1, { url: moved.url }, moved);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe(''));
      expect(pair(1)).toEqual(DEFAULT);

      // Shares the held read, and is settled right after the draw it outdates.
      draw(otherA);
      held.release();
      await vi.waitFor(() => expect(pair(3)).toEqual(RED));
      expect(chrome._state.badges[1]).toBe('');
      expect(pair(1)).toEqual(DEFAULT);
      expect(snapshotGets(get, 'snapshots/a.com')).toBe(1);
    });

    it('a draw of every tab outdated for one tab still draws the others', async () => {
      const otherA = { id: 3, url: 'https://a.com/other' };
      chrome._state.tabs = [tab, otherA];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      const get = vi.spyOn(chrome.storage.local, 'get');
      const held = chrome._holdGet(keys => keys.includes('snapshots/a.com'));

      chrome.runtime.onStartup.dispatch();
      await vi.waitFor(() => expect(snapshotGets(get, 'snapshots/a.com')).toBe(1));
      const moved = { id: 1, url: 'https://b.com/' };
      chrome._state.tabs = [moved, otherA];
      chrome.tabs.onUpdated.dispatch(1, { url: moved.url }, moved);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe(''));
      expect(chrome._state.badges[3]).toBeUndefined();

      held.release();
      await vi.waitFor(() => expect(pair(3)).toEqual(RED));
      expect(chrome._state.badges[3]).toBe('Ad');
      expect(chrome._state.badges[1]).toBe('');
      expect(pair(1)).toEqual(DEFAULT);
    });

    for (const event of ['onInstalled', 'onStartup']) {
      it(`${event} sets the default colours for tabs not drawn yet`, async () => {
        await loadServiceWorker();
        chrome.runtime[event].dispatch({ reason: 'install' });
        await vi.waitFor(() => {
          expect(chrome._state.badgeDefaultBackground).toBe(DEFAULT[0]);
          expect(chrome._state.badgeDefaultTextColor).toBe(DEFAULT[1]);
        });
      });
    }

    it('re-saving the active snapshot with the same labels redraws nothing', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red', cookies: [sid('one')] } } });
      await loadServiceWorker();
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(RED));
      const get = vi.spyOn(chrome.storage.local, 'get');
      const query = vi.spyOn(chrome.tabs, 'query');
      const background = vi.spyOn(chrome.action, 'setBadgeBackgroundColor');

      await seed({ 'snapshots/a.com': { Admin: { color: 'red', cookies: [sid('two')] } } });
      await redrawEveryTab();
      expect(query).toHaveBeenCalledTimes(1);
      expect(background).toHaveBeenCalledTimes(1);
      expect(snapshotGets(get)).toBe(0);
      expect(pair(1)).toEqual(RED);
    });

    it('a snapshot kept in the old single key badges in the default colours', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, snapshots: { 'a.com': { Admin: { color: 'red' } } } });
      await loadServiceWorker();

      draw(tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
      expect(pair(1)).toEqual(DEFAULT);
    });

    it('a snapshot key changed in another storage area is ignored', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      draw(tab);
      await vi.waitFor(() => expect(pair(1)).toEqual(RED));
      const query = vi.spyOn(chrome.tabs, 'query');

      chrome.storage.onChanged.dispatch({ 'snapshots/a.com': { newValue: { Admin: { color: 'amber' } } } }, 'sync');
      await redrawEveryTab();
      expect(query).toHaveBeenCalledTimes(1);
      expect(pair(1)).toEqual(RED);
    });

    it('a colour the browser refuses still leaves the text drawn', async () => {
      chrome._state.tabs = [tab];
      await seed({ activeSnapshots: { 'a.com': 'Admin' }, 'snapshots/a.com': { Admin: { color: 'red' } } });
      await loadServiceWorker();
      vi.spyOn(chrome.action, 'setBadgeBackgroundColor').mockRejectedValue(new Error('No tab with id: 1.'));
      vi.spyOn(chrome.action, 'setBadgeTextColor').mockRejectedValue(new Error('No tab with id: 1.'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      draw(tab);
      await vi.waitFor(() => expect(chrome._state.badges[1]).toBe('Ad'));
      await redrawEveryTab();
      expect(chrome._state.badges[1]).toBe('Ad');
      expect(logged).not.toHaveBeenCalled();
    });

    describe('a failed snapshot read', () => {
      const SECRET = 'secret-cookie-value';

      async function failFirstRead() {
        chrome._state.tabs = [tab, bTab];
        await seed({
          activeSnapshots: { 'a.com': 'Admin', 'b.com': 'Owner' },
          'snapshots/a.com': { Admin: { color: 'amber', cookies: [{ name: 'sid', value: SECRET, domain: 'a.com', path: '/' }] } },
          'snapshots/b.com': { Owner: { color: 'red' } },
        });
        await loadServiceWorker();
        const get = chrome.storage.local.get;
        let failed = false;
        const spy = vi.spyOn(chrome.storage.local, 'get').mockImplementation(async keys => {
          if (!failed && [keys].flat().includes('snapshots/a.com')) {
            failed = true;
            throw new Error('read failed');
          }
          return get(keys);
        });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        chrome.runtime.onInstalled.dispatch({ reason: 'install' });
        await vi.waitFor(() => {
          expect(chrome._state.badges[1]).toBe('Ad');
          expect(pair(2)).toEqual(RED);
        });
        return { get: spy, logged };
      }

      it('still badges the tab, in the default colours, and is retried', async () => {
        const { get } = await failFirstRead();
        expect(pair(1)).toEqual(DEFAULT);
        expect(chrome._state.badges[2]).toBe('Ow');

        draw(tab);
        await vi.waitFor(() => expect(pair(1)).toEqual(AMBER));
        expect(snapshotGets(get, 'snapshots/a.com')).toBe(2);
      });

      it('logs no snapshot data', async () => {
        const { logged } = await failFirstRead();
        draw(tab);
        await vi.waitFor(() => expect(pair(1)).toEqual(AMBER));

        expect(logged).toHaveBeenCalled();
        for (const args of logged.mock.calls) {
          for (const arg of args) {
            const text = arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg);
            expect(text).not.toContain(SECRET);
          }
        }
      });
    });
  });
});
