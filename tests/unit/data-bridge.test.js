import { describe, it, expect, vi } from 'vitest';
import { collectData, applyData, clearData, canReachPage } from '../../lib/data-bridge.js';

describe('lib/data-bridge collectData', () => {
  it('requests host permission and collects cookies when types.cookies is true', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({});
    chrome._state.cookies.push({ name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false });

    const data = await collectData(1, 'example.com', { cookies: true, localStorage: false, sessionStorage: false, indexedDB: false });

    expect(data.cookies).toHaveLength(1);
    expect(await chrome.permissions.contains({ origins: ['*://example.com/*'] })).toBe(true);
  });

  it('skips cookies entirely when types.cookies is false', async () => {
    const data = await collectData(1, 'example.com', { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false });
    expect(data).not.toHaveProperty('cookies');
  });

  it('requests storage data from the content script via chrome.tabs.sendMessage', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ localStorage: { a: '1' }, sessionStorage: { b: '2' } });

    const data = await collectData(1, 'example.com', { cookies: false, localStorage: true, sessionStorage: true, indexedDB: false });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'getStorageData', types: { localStorage: true, sessionStorage: true, indexedDB: false }, digest: false });
    expect(data).toEqual({ localStorage: { a: '1' }, sessionStorage: { b: '2' } });
  });

  it('does not call chrome.tabs.sendMessage when no storage types are requested', async () => {
    chrome.tabs.sendMessage = vi.fn();
    await collectData(1, 'example.com', { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('silently omits storage data when the content script is unreachable', async () => {
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Could not establish connection.'));
    const data = await collectData(1, 'example.com', { cookies: false, localStorage: true, sessionStorage: false, indexedDB: false });
    expect(data).toEqual({});
  });

  it('omits storage data when the content script responds with an error', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'boom' });
    const data = await collectData(1, 'example.com', { cookies: false, localStorage: true, sessionStorage: false, indexedDB: false });
    expect(data).toEqual({});
  });
});

describe('lib/data-bridge applyData', () => {
  it('restores cookies for the domain when types.cookies is true and permission is granted', async () => {
    await applyData(1, 'example.com', { cookies: [{ name: 'a', value: '1', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' }] }, {
      cookies: true, localStorage: false, sessionStorage: false, indexedDB: false,
    });
    expect(chrome._state.cookies.some(c => c.name === 'a')).toBe(true);
  });

  it('sends only the enabled + present storage types to the content script', async () => {
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });

    await applyData(1, 'example.com', { localStorage: { a: '1' }, sessionStorage: { b: '2' } }, {
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
    await expect(applyData(1, 'example.com', payload, types)).resolves.toBeUndefined();

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'IndexedDB "app" is in use by the page' });
    await expect(applyData(1, 'example.com', payload, types)).rejects.toThrow('in use');
  });

  it('does not call chrome.tabs.sendMessage when there is no storage payload to apply', async () => {
    chrome.tabs.sendMessage = vi.fn();
    await applyData(1, 'example.com', {}, { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does not throw when the content script is unreachable', async () => {
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('no receiver'));
    await expect(applyData(1, 'example.com', { localStorage: { a: '1' } }, {
      cookies: false, localStorage: true, sessionStorage: false, indexedDB: false,
    })).resolves.toBeUndefined();
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

    expect(await clearData(1, 'a.com', ALL)).toEqual(['app']);

    expect(chrome._state.cookies.map(c => c.domain)).toEqual(['b.com']);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: 'clearStorageData',
      types: { localStorage: true, sessionStorage: true, indexedDB: true },
    });
  });

  it('leaves cookies alone when they are turned off, and skips the message when no storage type is on', async () => {
    chrome._state.cookies = [{ name: 'sid', value: 'a', domain: 'a.com', path: '/', secure: false }];
    chrome.tabs.sendMessage = vi.fn();

    await clearData(1, 'a.com', { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false });

    expect(chrome._state.cookies).toHaveLength(1);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('fails when the content script can\'t be reached or reports an error', async () => {
    chrome.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist.'));
    await expect(clearData(1, 'a.com', { ...ALL, cookies: false })).rejects.toThrow();

    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'QuotaExceededError' });
    await expect(clearData(1, 'a.com', { ...ALL, cookies: false })).rejects.toThrow('QuotaExceededError');
  });

  it('keeps the cookies when clearing the storage fails', async () => {
    chrome._state.cookies = [{ name: 'sid', value: 'a', domain: 'a.com', path: '/', secure: false }];
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ error: 'SecurityError' });

    await expect(clearData(1, 'a.com', ALL)).rejects.toThrow();
    expect(chrome._state.cookies).toHaveLength(1);
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
