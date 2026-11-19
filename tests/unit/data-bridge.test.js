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
    await expect(applyData(1, HOST, payload, types)).resolves.toEqual({ storageSkipped: false });

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'IndexedDB "app" is in use by the page' });
    await expect(applyData(1, HOST, payload, types)).rejects.toThrow('in use');
  });

  it('does not call chrome.tabs.sendMessage when there is no storage payload to apply', async () => {
    chrome.tabs.sendMessage = vi.fn();
    await applyData(1, HOST, {}, { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does not throw when the content script is unreachable', async () => {
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('no receiver'));
    await expect(applyData(1, HOST, { localStorage: { a: '1' } }, {
      cookies: false, localStorage: true, sessionStorage: false, indexedDB: false,
    })).resolves.toEqual({ storageSkipped: false });
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
    expect(cookieDomainFor({}, 'app.example.com', APP)).toBe('app.example.com');
    expect(cookieDomainFor({ cookieDomain: 'example.com' }, 'app.example.com', APP)).toBe('example.com');
    expect(cookieDomainFor({ cookieDomain: 'example.com' }, 'app.example.com', APP_ALONE)).toBe('app.example.com');
    expect(cookieDomainFor({ cookieDomain: 'evil.com' }, 'app.example.com', APP)).toBe('example.com');
    expect(cookieDomainFor({}, 'evil.com', APP)).toBe('example.com');
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
    expect(result).toEqual({ storageSkipped: true });
  });

  it('applyData on the base host applies page data of a snapshot stored under the base key', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    const result = await applyData(1, BASE, { localStorage: { a: '1' } }, ALL, 'example.com');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'setStorageData', data: { localStorage: { a: '1' } } }));
    expect(result).toEqual({ storageSkipped: false });
  });

  it('applyData on app applies page data of a snapshot stored under app, in a group and outside one', async () => {
    for (const scope of [APP, APP_ALONE]) {
      chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
      expect(await applyData(1, scope, { localStorage: { a: '1' } }, ALL, 'app.example.com')).toEqual({ storageSkipped: false });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'setStorageData' }));
    }
  });

  it('group clearData removes every cookie under the base', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });
    await clearData(1, APP, ALL);
    expect(jar()).toEqual(['notexample.com:other=1']);
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
