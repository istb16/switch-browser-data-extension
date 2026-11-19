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
    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.waitFor(() => expect(chrome._state.badges[1]).toBe(''));
  });
});
