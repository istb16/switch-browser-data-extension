import { describe, it, expect, vi } from 'vitest';
import { otherSiteTabs, reloadTabs } from '../../lib/site-tabs.js';

const tab = (id, url, more = {}) => ({ id, url, status: 'complete', ...more });
const ids = tabs => tabs.map(t => t.id);

describe('lib/site-tabs otherSiteTabs', () => {
  const active = tab(1, 'https://app.example.com/page');

  it('matches the same host and, under an exact scope, its subdomains', () => {
    const tabs = [
      active,
      tab(2, 'https://app.example.com/other'),
      tab(3, 'https://api.app.example.com/'),
      tab(4, 'https://www.example.com/'),
      tab(5, 'https://example.com/'),
    ];
    expect(ids(otherSiteTabs(tabs, active, { sameOrigin: false, cookieDomain: 'app.example.com' }))).toEqual([2, 3]);
  });

  it('matches the siblings within a group, and nothing outside it', () => {
    const tabs = [
      active,
      tab(2, 'https://www.example.com/'),
      tab(3, 'https://example.com/'),
      tab(4, 'https://notexample.com/'),
      tab(5, 'https://example.org/'),
    ];
    expect(ids(otherSiteTabs(tabs, active, { sameOrigin: false, cookieDomain: 'example.com' }))).toEqual([2, 3]);
  });

  it('ignores the scheme and port for cookies, but not for the same origin', () => {
    const local = tab(1, 'http://localhost:3000/');
    const tabs = [
      local,
      tab(2, 'https://localhost:3000/'),
      tab(3, 'http://localhost:5173/'),
      tab(4, 'http://localhost:3000/other'),
    ];
    expect(ids(otherSiteTabs(tabs, local, { sameOrigin: false, cookieDomain: 'localhost' }))).toEqual([2, 3, 4]);
    expect(ids(otherSiteTabs(tabs, local, { sameOrigin: true, cookieDomain: null }))).toEqual([4]);
  });

  it('without sameOrigin, the active host\'s tabs match only through the cookie domain', () => {
    const tabs = [active, tab(2, 'https://app.example.com/other'), tab(3, 'https://b.example.com/')];
    expect(ids(otherSiteTabs(tabs, active, { sameOrigin: false, cookieDomain: 'b.example.com' }))).toEqual([3]);
  });

  it('matches nothing when neither was written', () => {
    const tabs = [active, tab(2, 'https://app.example.com/other')];
    expect(otherSiteTabs(tabs, active, { sameOrigin: false, cookieDomain: null })).toEqual([]);
  });

  it('leaves out tabs of the other incognito mode, discarded and unloaded tabs', () => {
    const tabs = [
      active,
      tab(2, 'https://app.example.com/a', { incognito: true }),
      tab(3, 'https://app.example.com/b', { discarded: true }),
      tab(4, 'https://app.example.com/c', { status: 'unloaded' }),
      tab(5, 'https://app.example.com/d', { status: 'loading' }),
    ];
    expect(ids(otherSiteTabs(tabs, active, { sameOrigin: true, cookieDomain: 'app.example.com' }))).toEqual([5]);
    const privateActive = { ...active, incognito: true };
    expect(ids(otherSiteTabs(tabs, privateActive, { sameOrigin: true, cookieDomain: 'app.example.com' }))).toEqual([2]);
  });

  it('leaves out browser and extension pages, and tabs without a URL', () => {
    const tabs = [
      active,
      tab(2, 'chrome://settings/'),
      tab(3, 'chrome-extension://abc/options/options.html'),
      tab(4, undefined),
      tab(5, 'not a url'),
      tab(6, 'about:blank'),
    ];
    expect(otherSiteTabs(tabs, active, { sameOrigin: true, cookieDomain: 'app.example.com' })).toEqual([]);
  });

  it('leaves out the active tab, and an empty cookie domain matches nothing', () => {
    const file = tab(1, 'file:///C:/page.html');
    const tabs = [active, tab(2, 'https://app.example.com/other'), file];
    expect(ids(otherSiteTabs(tabs, active, { sameOrigin: true, cookieDomain: 'app.example.com' }))).toEqual([2]);
    expect(otherSiteTabs([file, tab(3, 'https://a.com/')], { ...file, id: 9 }, { sameOrigin: true, cookieDomain: '' })).toEqual([]);
  });
});

describe('lib/site-tabs reloadTabs', () => {
  it("loads each tab's URL again, so a page from a form POST is fetched with a GET", async () => {
    chrome._state.tabs = [tab(2, 'https://a.com/post/submit'), tab(4, 'https://a.com/b')];
    expect(await reloadTabs([2, 4])).toBe(2);
    expect(chrome._state.navigatedTabs).toEqual([
      { tabId: 2, url: 'https://a.com/post/submit' },
      { tabId: 4, url: 'https://a.com/b' },
    ]);
  });

  it('reloads a tab whose URL has a fragment, since going to it again would only scroll', async () => {
    chrome._state.tabs = [tab(2, 'https://a.com/#/inbox'), tab(3, 'https://a.com/page#')];
    expect(await reloadTabs([2, 3])).toBe(2);
    expect(chrome._state.navigatedTabs).toEqual([]);
    expect(chrome._state.reloadedTabs).toEqual([2, 3]);
  });

  it('reloads a tab whose URL it cannot read, rather than navigating to nothing', async () => {
    chrome._state.tabs = [{ id: 2 }];
    expect(await reloadTabs([2])).toBe(1);
    expect(chrome._state.reloadedTabs).toEqual([2]);
    expect(chrome._state.navigatedTabs).toEqual([]);
  });

  it('skips a tab closed before its URL is read', async () => {
    chrome._state.tabs = [tab(3, 'https://a.com/x')];
    const reload = vi.spyOn(chrome.tabs, 'reload');
    const update = vi.spyOn(chrome.tabs, 'update');
    expect(await reloadTabs([2, 3])).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(chrome._state.navigatedTabs).toEqual([{ tabId: 3, url: 'https://a.com/x' }]);
  });

  it('counts only the tabs that did reload, skipping closed ones', async () => {
    chrome._state.tabs = [tab(2, 'https://a.com/'), tab(3, 'https://a.com/x'), tab(5, 'https://a.com/#y')];
    const update = chrome.tabs.update;
    vi.spyOn(chrome.tabs, 'update').mockImplementation(async (id, details) => {
      if (id === 3) throw new Error('No tab with id: 3');
      return update(id, details);
    });
    expect(await reloadTabs([2, 3, 4, 5])).toBe(2);
    expect(chrome._state.reloadedTabs).toEqual([2, 5]);
  });
});
