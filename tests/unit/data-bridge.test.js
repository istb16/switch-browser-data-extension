import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectData, applyData, clearData, canReachPage, cookieDomainFor } from '../../lib/data-bridge.js';
import { resolveScope } from '../../lib/groups.js';

const HOST = resolveScope('example.com', []);
const A_COM = resolveScope('a.com', []);

describe('lib/data-bridge collectData', () => {
  it('requests host permission and collects cookies when types.cookies is true', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({});
    chrome._state.cookies.push({ name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false });

    const data = await collectData(1, HOST, { cookies: true, localStorage: false, sessionStorage: false, indexedDB: false });

    expect(data.cookies).toHaveLength(1);
    expect(await chrome.permissions.contains({ origins: ['*://example.com/*'] })).toBe(true);
  });

  it('skips cookies entirely when types.cookies is false', async () => {
    const data = await collectData(1, HOST, { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false });
    expect(data).not.toHaveProperty('cookies');
  });

  it('requests storage data from the content script via chrome.tabs.sendMessage', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ localStorage: { a: '1' }, sessionStorage: { b: '2' } });

    const data = await collectData(1, HOST, { cookies: false, localStorage: true, sessionStorage: true, indexedDB: false });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'getStorageData', types: { localStorage: true, sessionStorage: true, indexedDB: false }, digest: false });
    expect(data).toEqual({ localStorage: { a: '1' }, sessionStorage: { b: '2' } });
  });

  it('does not call chrome.tabs.sendMessage when no storage types are requested', async () => {
    chrome.tabs.sendMessage = vi.fn();
    await collectData(1, HOST, { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('silently omits storage data when the content script is unreachable', async () => {
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Could not establish connection.'));
    const data = await collectData(1, HOST, { cookies: false, localStorage: true, sessionStorage: false, indexedDB: false });
    expect(data).toEqual({});
  });

  it('starts the page message before the cookie read resolves, with the same result', async () => {
    chrome._state.cookies.push({ name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false });
    let releaseCookies;
    const realGetAll = chrome.cookies.getAll;
    vi.spyOn(chrome.cookies, 'getAll').mockImplementation(async details => {
      await new Promise(resolve => { releaseCookies = resolve; });
      return realGetAll(details);
    });
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ localStorage: { k: 'v' } });

    const pending = collectData(1, HOST, { cookies: true, localStorage: true, sessionStorage: false, indexedDB: false });
    await vi.waitFor(() => expect(chrome.cookies.getAll).toHaveBeenCalled());
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'getStorageData' }));
    releaseCookies();
    const data = await pending;

    expect(data).toEqual({
      cookies: [expect.objectContaining({ name: 'a', value: '1', domain: 'example.com' })],
      localStorage: { k: 'v' },
    });
  });

  it('omits storage data when the content script responds with an error', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'boom' });
    const data = await collectData(1, HOST, { cookies: false, localStorage: true, sessionStorage: false, indexedDB: false });
    expect(data).toEqual({});
  });
});

describe('lib/data-bridge applyData', () => {
  it('restores cookies for the domain when types.cookies is true and permission is granted', async () => {
    await applyData(1, HOST, { cookies: [{ name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' }] }, {
      cookies: true, localStorage: false, sessionStorage: false, indexedDB: false,
    });
    expect(chrome._state.cookies.some(c => c.name === 'a')).toBe(true);
  });

  it('sends only the enabled + present storage types to the content script', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });

    await applyData(1, HOST, { localStorage: { a: '1' }, sessionStorage: { b: '2' } }, {
      cookies: false, localStorage: true, sessionStorage: false, indexedDB: true,
    });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: 'setStorageData',
      data: { localStorage: { a: '1' } },
      types: { cookies: false, localStorage: true, sessionStorage: false, indexedDB: true },
    });
  });

  it('stays silent when the page is unreachable, but fails on an error the content script reports', async () => {
    const payload = { localStorage: { a: '1' } };
    const types = { cookies: false, localStorage: true, sessionStorage: false, indexedDB: false };
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist.'));
    await expect(applyData(1, HOST, payload, types)).resolves.toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: false, sharedStorageApplied: false });

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    await expect(applyData(1, HOST, payload, types)).resolves.toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: true, sharedStorageApplied: true });

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'IndexedDB "app" is in use by the page' });
    await expect(applyData(1, HOST, payload, types)).rejects.toThrow('in use');
  });

  it('does not call chrome.tabs.sendMessage when there is no storage payload to apply', async () => {
    chrome.tabs.sendMessage = vi.fn();
    const result = await applyData(1, HOST, {}, { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: false, sharedStorageApplied: false });
  });

  it('does not report sessionStorage alone as shared storage, since other tabs never see it', async () => {
    const types = { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true };
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    expect(await applyData(1, HOST, { sessionStorage: { s: '1' } }, types))
      .toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: true, sharedStorageApplied: false });
    expect(await applyData(1, HOST, { sessionStorage: { s: '1' }, indexedDB: {} }, types))
      .toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: true, sharedStorageApplied: true });
  });

  it('applyData reports storageApplied only when the content script confirms the write', async () => {
    const types = { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true };
    const payload = { localStorage: { a: '1' } };
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    expect(await applyData(1, HOST, payload, types)).toMatchObject({ storageApplied: true });

    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist.'));
    expect(await applyData(1, HOST, payload, types)).toMatchObject({ storageApplied: false });

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue(undefined);
    expect(await applyData(1, HOST, payload, types)).toMatchObject({ storageApplied: false });

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: false });
    expect(await applyData(1, HOST, payload, types)).toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: false, sharedStorageApplied: false });

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true, error: 'quota exceeded' });
    await expect(applyData(1, HOST, payload, types)).rejects.toThrow('quota exceeded');

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    expect(await applyData(1, HOST, {}, types)).toMatchObject({ storageApplied: false });

    const app = resolveScope('app.example.com', ['example.com']);
    expect(await applyData(1, app, payload, types, 'example.com')).toMatchObject({ storageApplied: false, storageSkipped: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('reports the cookies as applied only when the permission is granted', async () => {
    const snapshot = { cookies: [{ name: 'a', value: '1', domain: 'example.com', path: '/' }] };
    const types = { cookies: true, localStorage: false, sessionStorage: false, indexedDB: false };
    expect(await applyData(1, HOST, snapshot, types)).toMatchObject({ cookiesApplied: true });

    chrome.permissions.request = vi.fn().mockResolvedValue(false);
    expect(await applyData(1, A_COM, { cookies: [{ name: 'a', value: '1', domain: 'a.com', path: '/' }] }, types))
      .toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: false, sharedStorageApplied: false });
    expect(chrome._state.cookies.some(c => c.domain === 'a.com')).toBe(false);
  });
});

describe('lib/data-bridge clearData', () => {
  const ALL = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };

  it('removes the domain\'s cookies and asks the content script to clear storage', async () => {
    chrome._state.cookies = [
      { name: 'sid', value: 'a', domain: 'a.com', path: '/', secure: false },
      { name: 'other', value: 'x', domain: 'b.com', path: '/', secure: false },
    ];
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true, blockedIndexedDB: ['app'] });

    expect(await clearData(1, A_COM, ALL)).toEqual(['app']);

    expect(chrome._state.cookies.map(c => c.domain)).toEqual(['b.com']);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: 'clearStorageData',
      types: { localStorage: true, sessionStorage: true, indexedDB: true },
    });
  });

  it('leaves cookies alone when they are turned off, and skips the message when no storage type is on', async () => {
    chrome._state.cookies = [{ name: 'sid', value: 'a', domain: 'a.com', path: '/', secure: false }];
    chrome.tabs.sendMessage = vi.fn();

    await clearData(1, A_COM, { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false });

    expect(chrome._state.cookies).toHaveLength(1);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('fails when the content script can\'t be reached or reports an error', async () => {
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist.'));
    await expect(clearData(1, A_COM, { ...ALL, cookies: false })).rejects.toThrow();

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'QuotaExceededError' });
    await expect(clearData(1, A_COM, { ...ALL, cookies: false })).rejects.toThrow('QuotaExceededError');
  });

  it('keeps the cookies when clearing the storage fails', async () => {
    chrome._state.cookies = [{ name: 'sid', value: 'a', domain: 'a.com', path: '/', secure: false }];
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'SecurityError' });

    await expect(clearData(1, A_COM, ALL)).rejects.toThrow();
    expect(chrome._state.cookies).toHaveLength(1);
  });
});

describe('lib/data-bridge in a subdomain group', () => {
  const GROUP = ['example.com'];
  const APP = resolveScope('app.example.com', GROUP);
  const BASE = resolveScope('example.com', GROUP);
  const APP_ALONE = resolveScope('app.example.com', []);
  const COOKIES_ONLY = { cookies: true, localStorage: false, sessionStorage: false, indexedDB: false };
  const ALL = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };
  const cookie = (name, domain, value = '1') => ({ name, value, domain, path: '/', secure: false, httpOnly: false, sameSite: 'lax' });
  const jar = () => chrome._state.cookies.map(c => `${c.domain}:${c.name}=${c.value}`).sort();

  beforeEach(() => {
    chrome._state.cookies = [
      cookie('parent', '.example.com'),
      cookie('own', 'app.example.com'),
      cookie('sibling', 'www.example.com'),
      cookie('other', 'notexample.com'),
    ];
  });

  it('group collect returns parent and sibling-subdomain cookies and stamps cookieDomain', async () => {
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    const data = await collectData(1, APP, COOKIES_ONLY);
    expect(data.cookies.map(c => c.name).sort()).toEqual(['own', 'parent', 'sibling']);
    expect(data.cookieDomain).toBe('example.com');
  });

  it('group collect without the wildcard permission omits cookies when non-interactive', async () => {
    chrome._state.grantedOrigins.add('*://app.example.com/*');
    const data = await collectData(1, APP, COOKIES_ONLY, { interactive: false });
    expect(data).not.toHaveProperty('cookies');
    expect(data).not.toHaveProperty('cookieDomain');
  });

  it('non-group collect adds no cookieDomain', async () => {
    chrome._state.grantedOrigins.add('*://app.example.com/*');
    const data = await collectData(1, APP_ALONE, COOKIES_ONLY);
    expect(data.cookies.map(c => c.name)).toEqual(['own']);
    expect(data).not.toHaveProperty('cookieDomain');
  });

  it('requests both group origins', async () => {
    const request = vi.spyOn(chrome.permissions, 'request');
    await collectData(1, APP, COOKIES_ONLY);
    expect(request).toHaveBeenCalledWith({ origins: ['*://example.com/*', '*://*.example.com/*'] });
  });

  it('cookieDomainFor narrows to the captured scope, never wider than the current one', () => {
    const exact = domain => ({ domain, exact: true });
    const wide = domain => ({ domain, exact: false });
    const BASE_ALONE = resolveScope('example.com', []);

    expect(cookieDomainFor({}, 'app.example.com', APP)).toEqual(exact('app.example.com'));
    expect(cookieDomainFor({ cookieDomain: 'example.com' }, 'app.example.com', APP)).toEqual(wide('example.com'));
    expect(cookieDomainFor({ cookieDomain: 'example.com' }, 'app.example.com', APP_ALONE)).toEqual(exact('app.example.com'));
    // A pre-group snapshot on the base host holds only the base host's cookies.
    expect(cookieDomainFor({}, 'example.com', BASE)).toEqual(exact('example.com'));
    // After the group is removed, a group snapshot on the base host is narrowed to that host.
    expect(cookieDomainFor({ cookieDomain: 'example.com' }, 'example.com', BASE_ALONE)).toEqual(exact('example.com'));
    // A foreign cookieDomain falls back to the host it was stored under, not the whole group.
    expect(cookieDomainFor({ cookieDomain: 'evil.com' }, 'app.example.com', APP)).toEqual(exact('app.example.com'));
    expect(cookieDomainFor({ cookieDomain: 5 }, 'app.example.com', APP)).toEqual(exact('app.example.com'));
    expect(cookieDomainFor({}, 'evil.com', APP)).toEqual(exact('app.example.com'));
    // A cookieDomain wider than the group is cut down to the group.
    expect(cookieDomainFor({ cookieDomain: 'com' }, 'app.example.com', APP)).toEqual(wide('example.com'));
    // A cookieDomain narrower than the group is kept as it is, subdomains included.
    expect(cookieDomainFor({ cookieDomain: 'www.example.com' }, 'app.example.com', APP)).toEqual(wide('www.example.com'));
    // An exact capture under another host of the group stays on that host.
    expect(cookieDomainFor({}, 'www.example.com', APP)).toEqual(exact('www.example.com'));
  });

  it('cookieDomainFor outside a group never leaves the current host', () => {
    const exact = domain => ({ domain, exact: true });

    expect(cookieDomainFor({ cookieDomain: 'www.example.com' }, 'app.example.com', APP_ALONE)).toEqual(exact('app.example.com'));
    expect(cookieDomainFor({ cookieDomain: 'app.example.com' }, 'app.example.com', APP_ALONE)).toEqual(exact('app.example.com'));
    expect(cookieDomainFor({}, 'www.example.com', APP_ALONE)).toEqual(exact('app.example.com'));
  });

  it('clearData hands the cookie scope to beforeCookies only when it is about to remove cookies', async () => {
    const beforeCookies = vi.fn();
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    await clearData(1, APP, COOKIES_ONLY, { beforeCookies });
    expect(beforeCookies).toHaveBeenCalledWith({ domain: 'example.com', exact: false });

    beforeCookies.mockClear();
    await clearData(1, APP, { ...COOKIES_ONLY, cookies: false }, { beforeCookies });
    expect(beforeCookies).not.toHaveBeenCalled();
  });

  it('clearData does not call beforeCookies when the host permission is denied', async () => {
    vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);
    const before = jar();
    const beforeCookies = vi.fn();
    await clearData(1, APP, COOKIES_ONLY, { beforeCookies });
    expect(beforeCookies).not.toHaveBeenCalled();
    expect(jar()).toEqual(before);
  });

  it('clearData calls beforeCookies before the jar is emptied', async () => {
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    const before = jar();
    let seen;
    await clearData(1, APP, COOKIES_ONLY, { beforeCookies: () => { seen = jar(); } });
    expect(seen).toEqual(before);
    expect(jar()).toEqual(['notexample.com:other=1']);
  });

  it('clearData leaves the cookies alone when beforeCookies rejects', async () => {
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    const before = jar();
    const beforeCookies = vi.fn().mockRejectedValue(new Error('storage failed'));
    await expect(clearData(1, APP, COOKIES_ONLY, { beforeCookies })).rejects.toThrow('storage failed');
    expect(jar()).toEqual(before);
  });

  it('group applyData of a pre-group base-host snapshot leaves sibling-host cookies in place', async () => {
    await applyData(1, BASE, { cookies: [cookie('parent', '.example.com', 'new')] }, COOKIES_ONLY, 'example.com');
    expect(jar()).toEqual([
      '.example.com:parent=new', 'app.example.com:own=1', 'notexample.com:other=1', 'www.example.com:sibling=1',
    ]);
  });

  it('host applyData of a group snapshot on the base host, after the group is gone, sets only the base host\'s cookies', async () => {
    const set = vi.spyOn(chrome.cookies, 'set');
    await applyData(1, resolveScope('example.com', []), {
      cookieDomain: 'example.com',
      cookies: [cookie('parent', '.example.com', 'new'), cookie('own', 'app.example.com', 'new')],
    }, COOKIES_ONLY, 'example.com');
    expect(set.mock.calls.map(([details]) => details.name)).toEqual(['parent']);
    expect(jar()).toContain('app.example.com:own=1');
  });

  it('host clearData leaves sibling-host cookies alone', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    await clearData(1, resolveScope('example.com', []), ALL);
    expect(jar()).toEqual(['app.example.com:own=1', 'notexample.com:other=1', 'www.example.com:sibling=1']);
  });

  it('group applyData of a group snapshot replaces the whole jar', async () => {
    await applyData(1, APP, { cookieDomain: 'example.com', cookies: [cookie('own', 'app.example.com', 'new')] }, COOKIES_ONLY, 'app.example.com');
    expect(jar()).toEqual(['app.example.com:own=new', 'notexample.com:other=1']);
  });

  it('group applyData of a pre-group host snapshot leaves .base and sibling cookies in place', async () => {
    await applyData(1, APP, { cookies: [cookie('own', 'app.example.com', 'new')] }, COOKIES_ONLY, 'app.example.com');
    expect(jar()).toEqual([
      '.example.com:parent=1', 'app.example.com:own=new', 'notexample.com:other=1', 'www.example.com:sibling=1',
    ]);
  });

  it('host applyData of a group snapshot sets only the host\'s cookies', async () => {
    const set = vi.spyOn(chrome.cookies, 'set');
    await applyData(1, APP_ALONE, {
      cookieDomain: 'example.com',
      cookies: [cookie('own', 'app.example.com', 'new'), cookie('parent', '.example.com', 'new'), cookie('sibling', 'www.example.com', 'new')],
    }, COOKIES_ONLY, 'app.example.com');
    expect(set.mock.calls.map(([details]) => details.name)).toEqual(['own']);
    expect(jar()).toContain('.example.com:parent=1');
    expect(jar()).toContain('www.example.com:sibling=1');
  });

  it('applyData on a subdomain skips page data for a snapshot stored under the base key', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    const result = await applyData(1, APP, { localStorage: { a: '1' } }, ALL, 'example.com');
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ storageSkipped: true, cookiesApplied: false, storageApplied: false, sharedStorageApplied: false });
  });

  it('applyData on the base host applies page data of a snapshot stored under the base key', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    const result = await applyData(1, BASE, { localStorage: { a: '1' } }, ALL, 'example.com');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'setStorageData', data: { localStorage: { a: '1' } } }));
    expect(result).toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: true, sharedStorageApplied: true });
  });

  it('applyData on app applies page data of a snapshot stored under app, in a group and outside one', async () => {
    for (const scope of [APP, APP_ALONE]) {
      chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
      expect(await applyData(1, scope, { localStorage: { a: '1' } }, ALL, 'app.example.com')).toEqual({ storageSkipped: false, cookiesApplied: false, storageApplied: true, sharedStorageApplied: true });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'setStorageData' }));
    }
  });
});

describe('lib/data-bridge canReachPage', () => {
  const STORAGE = { cookies: true, localStorage: true, sessionStorage: false, indexedDB: false };

  it('asks the content script, and treats no answer as unreachable', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ ok: true });
    expect(await canReachPage(1, STORAGE)).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'ping' });

    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist.'));
    expect(await canReachPage(1, STORAGE)).toBe(false);
  });

  it('does not need the page when only cookies are enabled', async () => {
    chrome.tabs.sendMessage = vi.fn();
    expect(await canReachPage(1, { cookies: true, localStorage: false, sessionStorage: false, indexedDB: false })).toBe(true);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
