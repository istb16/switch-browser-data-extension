import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCookieCheck, getVolatileCookiesFor } from '../../lib/volatile-cookies.js';
import { setActiveSnapshots, setSettings, getSettings } from '../../lib/storage.js';

const sid = value => ({ name: 'sid', value, domain: 'a.com', path: '/' });
const tab = { id: 1, url: 'https://a.com/page' };

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
    await startCookieCheck(1, 'a.com', [sid('applied')]);
    chrome._state.cookies = [sid('rotated')];

    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await getVolatileCookiesFor('a.com')).toEqual({ 'a.com|/|sid': 'value' });
  });

  it('learns nothing without the host permission, where every cookie would look gone', async () => {
    await loadServiceWorker();
    await startCookieCheck(1, 'a.com', [sid('applied')]);

    chrome.tabs.onUpdated.dispatch(1, { status: 'complete' }, tab);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await getVolatileCookiesFor('a.com')).toEqual({});
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
