import { describe, it, expect, vi } from 'vitest';
import { collectData, applyData } from '../../lib/data-bridge.js';

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

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'getStorageData', types: { localStorage: true, sessionStorage: true, indexedDB: false } });
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
