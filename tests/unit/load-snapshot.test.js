import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadWholeSnapshot, pageTypesOf } from '../../lib/load-snapshot.js';
import { resolveScope } from '../../lib/groups.js';
import { getBackups } from '../support/storage-seed.js';

const TYPES = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };
const SETTINGS = { enabledTypes: TYPES, autoBackup: true, autoReload: true, reloadOtherTabs: true };
const COOKIE = { name: 'sid', value: 'bob', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' };
const SNAPSHOT = { savedAt: '2026-01-01T00:00:00.000Z', cookies: [COOKIE], localStorage: { user: 'bob' } };

let tab;
let pageReplies;

function messagesOf(type) {
  return chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message.type === type);
}

function moveTab(url) {
  chrome._state.tabs.find(t => t.id === tab.id).url = url;
}

function load(overrides = {}) {
  return loadWholeSnapshot({
    tab,
    scope: resolveScope('example.com', []),
    settings: SETTINGS,
    entry: { host: 'example.com', name: 'bob' },
    snapshot: SNAPSHOT,
    activeBefore: 'alice',
    ...overrides,
  });
}

beforeEach(() => {
  tab = { id: 1, url: 'https://example.com/app', incognito: false };
  chrome._state.tabs.push({ ...tab }, { id: 2, url: 'https://example.com/other', incognito: false });
  chrome._state.grantedOrigins.add('*://example.com/*');
  chrome._state.cookies.push({ ...COOKIE, value: 'alice' });
  chrome._state.storage.activeSnapshots = { 'example.com': 'alice' };
  pageReplies = {
    getStorageData: async () => ({ localStorage: { user: 'alice' } }),
    setStorageData: async () => ({ success: true }),
  };
  chrome.tabs.sendMessage = vi.fn((_id, message) => pageReplies[message.type]?.(message));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lib/load-snapshot loadWholeSnapshot', () => {
  it('backs up, applies, records, starts the cookie check with reloadTabs, and reloads only the tab', async () => {
    const result = await load();

    expect(result).toMatchObject({ backedUp: true, applied: { cookiesApplied: true, storageApplied: true }, reloaded: 1 });
    expect((await getBackups())['example.com']).toMatchObject({
      activeName: 'alice', localStorage: { user: 'alice' }, cookies: [expect.objectContaining({ value: 'alice' })],
    });
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('bob');
    expect(messagesOf('setStorageData')[0][1].data).toEqual({ localStorage: { user: 'bob' } });
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'bob' });
    expect(chrome._state.storage.cookieChecks[1]).toMatchObject({
      domain: 'example.com', cookieDomain: 'example.com', cookieExact: true,
      cookies: [expect.objectContaining({ value: 'bob' })],
      reloadTabs: [{ id: 2, origin: 'https://example.com' }],
    });
    expect(chrome._state.reloadedTabs).toEqual([1]);
  });

  it('sends the tab\'s origin with the read and the write', async () => {
    await load();
    expect(messagesOf('getStorageData')[0][1].origin).toBe('https://example.com');
    expect(messagesOf('setStorageData')[0][1].origin).toBe('https://example.com');
  });

  it('records a bare name outside a group and { host, name } in a group', async () => {
    await load();
    expect(chrome._state.storage.activeSnapshots['example.com']).toBe('bob');

    tab = { id: 1, url: 'https://app.example.com/', incognito: false };
    chrome._state.tabs[0].url = tab.url;
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    await load({
      scope: resolveScope('app.example.com', ['example.com']),
      entry: { host: 'app.example.com', name: 'carol' },
      snapshot: { cookies: [], localStorage: { user: 'carol' } },
    });
    expect(chrome._state.storage.activeSnapshots['example.com']).toEqual({ host: 'app.example.com', name: 'carol' });
  });

  it('records no types even when the entry carries them', async () => {
    await load({ entry: { host: 'example.com', name: 'bob', types: ['cookies'] } });
    expect(chrome._state.storage.activeSnapshots['example.com']).toBe('bob');

    tab = { id: 1, url: 'https://app.example.com/', incognito: false };
    chrome._state.tabs[0].url = tab.url;
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    await load({
      scope: resolveScope('app.example.com', ['example.com']),
      entry: { host: 'app.example.com', name: 'carol', types: ['cookies'] },
      snapshot: { cookies: [], localStorage: { user: 'carol' } },
    });
    expect(chrome._state.storage.activeSnapshots['example.com']).toEqual({ host: 'app.example.com', name: 'carol' });
  });

  it('without cookies applied reloads the tab, then the others', async () => {
    const result = await load({ snapshot: { localStorage: { user: 'bob' } } });

    expect(result.reloaded).toBe(1);
    expect(chrome._state.storage.cookieChecks ?? {}).toEqual({});
    expect(chrome._state.reloadedTabs).toEqual([1, 2]);
  });

  it('keeps the record of the switch when the tab is closed before the reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setCookie = vi.spyOn(chrome.cookies, 'set');
    const realGet = chrome.tabs.get;
    vi.spyOn(chrome.tabs, 'get').mockImplementation(async id => {
      if (id === tab.id && setCookie.mock.calls.length > 0) throw new Error(`No tab with id: ${id}.`);
      return realGet(id);
    });

    const result = await load();

    expect(setCookie).toHaveBeenCalled();
    expect(result).toMatchObject({ backedUp: true, reloaded: 1 });
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'bob' });
    expect(chrome._state.storage.cookieChecks[tab.id]).toMatchObject({
      reloadTabs: [{ id: 2, origin: 'https://example.com' }],
    });
    expect(chrome._state.reloadedTabs).toEqual([]);
  });

  it('applies nothing when the backup cannot be written', async () => {
    const realSet = chrome.storage.local.set;
    vi.spyOn(chrome.storage.local, 'set').mockImplementation(async items => {
      if (Object.keys(items).some(key => key.startsWith('backups/'))) throw new Error('quota exceeded');
      return realSet(items);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await load()).toEqual({ backedUp: false });
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
    expect(chrome._state.reloadedTabs).toEqual([]);
  });

  it('throws on a tab already on another origin, before the read', async () => {
    moveTab('https://evil.example/');
    await expect(load()).rejects.toThrow();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(await getBackups()).toEqual({});
  });

  it('throws when the tab moves to http on the same host, before the read', async () => {
    moveTab('http://example.com/app');
    await expect(load()).rejects.toThrow();
    expect(messagesOf('getStorageData')).toEqual([]);
    expect(await getBackups()).toEqual({});
  });

  it('throws when the tab moves during the read, without saving what was read', async () => {
    pageReplies.getStorageData = async () => {
      moveTab('https://evil.example/');
      return { localStorage: { foreign: '1' } };
    };
    await expect(load()).rejects.toThrow();
    expect(await getBackups()).toEqual({});
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
  });

  it('throws when the tab moves during the backup, before any cookie or page write', async () => {
    const realSet = chrome.storage.local.set;
    vi.spyOn(chrome.storage.local, 'set').mockImplementation(async items => {
      const result = await realSet(items);
      if (Object.keys(items).some(key => key.startsWith('backups/'))) moveTab('https://evil.example/');
      return result;
    });
    await expect(load()).rejects.toThrow();
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
  });

  it('continues when the tab moves to another path of the same origin', async () => {
    pageReplies.getStorageData = async () => {
      moveTab('https://example.com/elsewhere?x=1');
      return { localStorage: { user: 'alice' } };
    };
    expect(await load()).toMatchObject({ backedUp: true });
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'bob' });
  });

  it('throws before any write when tabs.get rejects', async () => {
    chrome._state.tabs.splice(0, 1);
    await expect(load()).rejects.toThrow();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(await getBackups()).toEqual({});
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
  });

  it('throws and leaves the record when the page refuses the write', async () => {
    pageReplies.setStorageData = async () => ({ error: 'origin mismatch' });
    await expect(load()).rejects.toThrow('origin mismatch');
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
  });

  it('writes the page before the cookies', async () => {
    const setCookie = vi.spyOn(chrome.cookies, 'set');
    await load();
    const { calls, invocationCallOrder } = chrome.tabs.sendMessage.mock;
    const pageOrder = invocationCallOrder[calls.findIndex(([, message]) => message.type === 'setStorageData')];
    expect(setCookie).toHaveBeenCalled();
    expect(pageOrder).toBeLessThan(Math.min(...setCookie.mock.invocationCallOrder));
  });

  it('leaves the cookies and puts the page back from the backup when the page write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let writes = 0;
    pageReplies.setStorageData = async () => (++writes === 1 ? { error: 'IndexedDB is blocked' } : { success: true });
    await expect(load()).rejects.toThrow('IndexedDB is blocked');
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
    const sent = messagesOf('setStorageData').map(([, message]) => message);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ data: { localStorage: { user: 'alice' } }, origin: 'https://example.com' });
    expect(sent[1].types.cookies).toBe(false);
  });

  it('puts the page back from the backup when a page write is not confirmed', async () => {
    let writes = 0;
    pageReplies.setStorageData = async () => (++writes === 1 ? undefined : { success: true });
    await expect(load()).rejects.toThrow('page storage not written');
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
    expect(messagesOf('setStorageData').map(([, message]) => message.data)).toEqual([
      { localStorage: { user: 'bob' } }, { localStorage: { user: 'alice' } },
    ]);
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
  });

  it('puts the page back even when the cookie jar keeps failing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const realGetAll = chrome.cookies.getAll;
    let reads = 0;
    vi.spyOn(chrome.cookies, 'getAll').mockImplementation(async filter => {
      if (++reads >= 2) throw new Error('cookie store unavailable');
      return realGetAll(filter);
    });
    await expect(load()).rejects.toThrow('cookie store unavailable');
    expect(messagesOf('setStorageData').map(([, message]) => message.data)).toEqual([
      { localStorage: { user: 'bob' } }, { localStorage: { user: 'alice' } },
    ]);
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
  });

  it('puts the page and the cookies back from the backup when the cookie write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const realGetAll = chrome.cookies.getAll;
    let reads = 0;
    // The first read is the backup's; the second is the switch's own write.
    vi.spyOn(chrome.cookies, 'getAll').mockImplementation(async filter => {
      if (++reads === 2) throw new Error('cookie store unavailable');
      return realGetAll(filter);
    });
    await expect(load()).rejects.toThrow('cookie store unavailable');
    expect(messagesOf('setStorageData').map(([, message]) => message.data)).toEqual([
      { localStorage: { user: 'bob' } }, { localStorage: { user: 'alice' } },
    ]);
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
  });

  it.each([
    ['reports an error', async () => ({ error: 'read failed' })],
    ['does not answer', async () => undefined],
    ['cannot be reached', async () => { throw new Error('Receiving end does not exist.'); }],
    ['leaves out a type about to be written', async () => ({ sessionStorage: {} })],
  ])('throws before the backup when the page %s', async (_label, reply) => {
    pageReplies.getStorageData = reply;
    await expect(load()).rejects.toThrow();
    expect(await getBackups()).toEqual({});
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('alice');
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
  });

  it('throws before the backup when the cookies about to be written cannot be read', async () => {
    chrome._state.grantedOrigins.clear();
    await expect(load()).rejects.toThrow();
    expect(await getBackups()).toEqual({});
    expect(messagesOf('setStorageData')).toEqual([]);
  });

  it('does not need the page when only cookies are written', async () => {
    pageReplies.getStorageData = async () => { throw new Error('Receiving end does not exist.'); };
    const result = await load({ snapshot: { cookies: [COOKIE] } });
    expect(result).toMatchObject({ backedUp: true });
    expect((await getBackups())['example.com']).toMatchObject({ cookies: [expect.objectContaining({ value: 'alice' })] });
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'bob' });
  });

  it('does not need the page for a snapshot of another host of the group, which applies cookies only', async () => {
    tab = { id: 1, url: 'https://app.example.com/', incognito: false };
    chrome._state.tabs[0].url = tab.url;
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    pageReplies.getStorageData = async () => { throw new Error('Receiving end does not exist.'); };

    const result = await load({
      scope: resolveScope('app.example.com', ['example.com']),
      entry: { host: 'www.example.com', name: 'bob' },
      snapshot: { ...SNAPSHOT, cookieDomain: 'example.com' },
    });

    expect(result).toMatchObject({ backedUp: true, applied: { cookiesApplied: true, storageSkipped: true, storageApplied: false } });
    expect((await getBackups())['app.example.com']).toMatchObject({ cookies: [expect.objectContaining({ value: 'alice' })] });
    expect(messagesOf('getStorageData')).toHaveLength(1);
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(chrome._state.cookies.find(c => c.name === 'sid').value).toBe('bob');
    expect(chrome._state.storage.activeSnapshots['example.com']).toEqual({ host: 'www.example.com', name: 'bob' });
  });

  it.each([
    ['does not arrive', async () => { throw new Error('Receiving end does not exist.'); }],
    ['is not confirmed', async () => undefined],
  ])('throws and leaves the record when the page write %s', async (_label, reply) => {
    pageReplies.setStorageData = reply;
    await expect(load()).rejects.toThrow();
    expect(chrome._state.storage.activeSnapshots).toEqual({ 'example.com': 'alice' });
    expect((await getBackups())['example.com']).toMatchObject({ localStorage: { user: 'alice' } });
    expect(chrome._state.reloadedTabs).toEqual([]);
  });
});

describe('lib/load-snapshot pageTypesOf', () => {
  const FULL = { localStorage: {}, sessionStorage: {}, indexedDB: {} };
  const scope = resolveScope('app.example.com', ['example.com']);

  it('marks the enabled types the snapshot has, on the scope\'s own host', () => {
    expect(pageTypesOf(FULL, TYPES, 'app.example.com', scope))
      .toEqual({ localStorage: true, sessionStorage: true, indexedDB: true });
    expect(pageTypesOf({ localStorage: {} }, TYPES, 'app.example.com', scope))
      .toEqual({ localStorage: true, sessionStorage: false, indexedDB: false });
    expect(pageTypesOf(FULL, { ...TYPES, sessionStorage: false }, 'app.example.com', scope))
      .toEqual({ localStorage: true, sessionStorage: false, indexedDB: true });
  });

  it('marks nothing for another host of the group', () => {
    expect(pageTypesOf(FULL, TYPES, 'www.example.com', scope))
      .toEqual({ localStorage: false, sessionStorage: false, indexedDB: false });
  });
});
