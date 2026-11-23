import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setSnapshots, getBackups } from '../support/storage-seed.js';
import { deleteSnapshot } from '../../lib/snapshot.js';

const cookie = value => ({ name: 'sid', value, domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' });
const account = user => ({ savedAt: '2026-01-01T00:00:00.000Z', cookies: [cookie(user)], localStorage: { user } });

let tab;
let page;

async function loadServiceWorker() {
  vi.resetModules();
  await import('../../background/service-worker.js');
}

// An explicit undefined target stands for an event that passes no tab.
function press(command = 'switch-previous', ...target) {
  return Promise.all(chrome.commands.onCommand.dispatch(command, ...(target.length ? target : [tab])));
}

function messagesOf(type) {
  return chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message.type === type);
}

const stored = key => chrome._state.storage[key];
const sid = () => chrome._state.cookies.find(c => c.name === 'sid')?.value;

function expectRefused(key, host = 'example.com') {
  expect(chrome._state.badges[tab.id]).toBe('!');
  if (key) {
    expect(stored('commandNotice')).toEqual({ tabId: tab.id, host, key, until: expect.any(Number) });
    expect(stored('commandNotice').until).toBeGreaterThan(Date.now() + 59_000);
  } else {
    expect(stored('commandNotice')).toBeUndefined();
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  tab = { id: 1, url: 'https://example.com/app', incognito: false };
  chrome._state.tabs = [{ ...tab }];
  chrome._state.grantedOrigins.add('*://example.com/*');
  chrome._state.cookies = [cookie('alice')];
  await setSnapshots({ 'example.com': { alice: account('alice'), bob: account('bob') } });
  await chrome.storage.local.set({
    activeSnapshots: { 'example.com': 'alice' },
    previousSnapshots: { 'example.com': { host: 'example.com', name: 'bob' } },
  });
  page = {
    user: 'alice',
    ping: async () => ({ ok: true }),
    getStorageData: async () => ({ localStorage: { user: page.user } }),
    setStorageData: async message => {
      page.user = message.data.localStorage.user;
      return { success: true };
    },
  };
  chrome.tabs.sendMessage = vi.fn(async (_id, message) => page[message.type](message));
  await loadServiceWorker();
});

afterEach(() => vi.useRealTimers());

describe('background/switch-command', () => {
  it('registers its listener without waiting for storage', async () => {
    const held = chrome._holdGet(() => true);
    vi.resetModules();
    await import('../../background/service-worker.js');
    expect(chrome.commands.onCommand.hasListeners()).toBe(true);
    held.release();
  });

  it('switches to the previous snapshot and back', async () => {
    await press();

    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
    expect(stored('previousSnapshots')).toEqual({ 'example.com': { host: 'example.com', name: 'alice' } });
    expect((await getBackups())['example.com']).toMatchObject({
      activeName: 'alice', localStorage: { user: 'alice' }, cookies: [expect.objectContaining({ value: 'alice' })],
    });
    expect(sid()).toBe('bob');
    expect(page.user).toBe('bob');
    expect(chrome._state.reloadedTabs).toEqual([1]);
    expect(stored('commandNotice')).toBeUndefined();

    await press();

    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    expect(stored('previousSnapshots')).toEqual({ 'example.com': { host: 'example.com', name: 'bob' } });
    expect((await getBackups())['example.com']).toMatchObject({ activeName: 'bob', localStorage: { user: 'bob' } });
    expect(sid()).toBe('alice');
  });

  it('with no active record loads the previous once, then reports no previous', async () => {
    await chrome.storage.local.set({ activeSnapshots: {} });

    await press();
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
    expect(stored('previousSnapshots')).toEqual({ 'example.com': { host: 'example.com', name: 'bob' } });

    await press();
    expectRefused('shortcut_no_previous');
    expect(sid()).toBe('bob');
  });

  it('loads the previous whole from a partial record, and the partial one whole after it', async () => {
    await chrome.storage.local.set({ activeSnapshots: { 'example.com': { host: 'example.com', name: 'alice', types: ['cookies'] } } });

    await press();
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
    expect(stored('previousSnapshots')).toEqual({ 'example.com': { host: 'example.com', name: 'alice' } });
    expect(page.user).toBe('bob');

    await press();
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    expect(page.user).toBe('alice');
  });

  it('uses the tab the event passes, and queries the last focused window only without one', async () => {
    const query = vi.spyOn(chrome.tabs, 'query');
    await press();
    expect(query).not.toHaveBeenCalled();

    await press('switch-previous', undefined);
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
  });

  it('ignores other commands', async () => {
    await press('something-else');
    expect(chrome._state.getContextsCalls).toEqual([]);
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    expect(chrome._state.badges[tab.id]).toBeUndefined();
  });

  describe('refusals', () => {
    afterEach(async () => {
      expect(chrome.tabs.sendMessage.mock.calls.some(([, m]) => m.type === 'setStorageData')).toBe(false);
      expect(await getBackups()).toEqual({});
    });

    it('without the host permission opens the popup on its permission panel, with no notice', async () => {
      chrome._state.grantedOrigins.clear();
      await press();
      expectRefused(null);
      expect(chrome._state.openedPopups).toBe(1);
      expect(sid()).toBe('alice');
      expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    });

    it('with automatic backup off', async () => {
      await chrome.storage.local.set({ settings: { autoBackup: false } });
      await press();
      expectRefused('shortcut_needs_backup');
      expect(chrome._state.openedPopups).toBe(1);
      expect(sid()).toBe('alice');
    });

    it('without a previous entry for the site', async () => {
      await chrome.storage.local.set({ previousSnapshots: { 'other.com': { host: 'other.com', name: 'x' } } });
      await press();
      expectRefused('shortcut_no_previous');
    });

    it('when the previous equals the active snapshot', async () => {
      await chrome.storage.local.set({ previousSnapshots: { 'example.com': { host: 'example.com', name: 'alice' } } });
      await press();
      expectRefused('shortcut_no_previous');
    });

    it.each([
      ['a bare name', 'bob'],
      ['a non-string host', { host: 1, name: 'bob' }],
      ['a non-string name', { host: 'example.com', name: 2 }],
    ])('when the previous record is malformed (%s)', async (_label, ref) => {
      await chrome.storage.local.set({ previousSnapshots: { 'example.com': ref } });
      await press();
      expectRefused('shortcut_no_previous');
      expect(sid()).toBe('alice');
    });

    it('when the previous equals the active { host, name } of a group', async () => {
      tab = { id: 1, url: 'https://app.example.com/' };
      chrome._state.tabs = [{ ...tab }];
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      await setSnapshots({ 'example.com': { bob: account('bob') }, 'app.example.com': { carol: account('carol') } });
      await chrome.storage.local.set({
        groups: ['example.com'],
        activeSnapshots: { 'example.com': { host: 'app.example.com', name: 'carol' } },
        previousSnapshots: { 'example.com': { host: 'app.example.com', name: 'carol' } },
      });
      await press();
      expectRefused('shortcut_no_previous', 'app.example.com');
      expect(sid()).toBe('alice');
    });

    it('when the page cannot be read for the backup', async () => {
      page.getStorageData = async () => ({ error: 'read failed' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await press();
      expectRefused('error_load_failed');
      expect(sid()).toBe('alice');
      expect(page.user).toBe('alice');
      expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    });

    it('when the previous is on a host outside the scope since its group was removed', async () => {
      await setSnapshots({ 'example.com': { alice: account('alice') }, 'app.example.com': { carol: account('carol') } });
      await chrome.storage.local.set({ previousSnapshots: { 'example.com': { host: 'app.example.com', name: 'carol' } } });
      const get = vi.spyOn(chrome.storage.local, 'get');
      await press();
      expectRefused('shortcut_no_previous');
      expect(get.mock.calls.some(([keys]) => [keys].flat().includes('snapshots/app.example.com'))).toBe(false);
      expect(sid()).toBe('alice');
    });

    it('after the previous snapshot was deleted', async () => {
      await deleteSnapshot('example.com', 'bob');
      await press();
      expectRefused('shortcut_no_previous');
    });

    it('when the page cannot be reached', async () => {
      page.ping = async () => { throw new Error('Receiving end does not exist.'); };
      await press();
      expectRefused('shortcut_page_unreachable');
      expect(sid()).toBe('alice');
      expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    });

    it('on a file: tab', async () => {
      tab = { id: 1, url: 'file:///C:/page.html' };
      chrome._state.tabs = [{ ...tab }];
      await press();
      expectRefused('unavailable', null);
      expect(chrome._state.openedPopups).toBe(1);
    });

    it('when the popup is open', async () => {
      chrome._state.contexts = [{ contextType: 'POPUP' }];
      await press();
      expectRefused(null);
      expect(chrome._state.openedPopups).toBe(0);
      expect(chrome._state.getContextsCalls).toEqual([{ contextTypes: ['POPUP'] }]);
      expect(sid()).toBe('alice');
    });

    it('without runtime.getContexts', async () => {
      delete chrome.runtime.getContexts;
      await press();
      expectRefused(null);
      expect(chrome._state.openedPopups).toBe(0);
      expect(sid()).toBe('alice');
    });
  });

  it('a cookies-only previous switches on a page that cannot be reached', async () => {
    await setSnapshots({ 'example.com': { alice: account('alice'), bob: { cookies: [cookie('bob')] } } });
    chrome.tabs.sendMessage = vi.fn(async () => { throw new Error('Receiving end does not exist.'); });

    await press();

    expect(sid()).toBe('bob');
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
    expect(stored('commandNotice')).toBeUndefined();
  });

  it('a previous on another host of the group applies the cookies only', async () => {
    tab = { id: 1, url: 'https://app.example.com/' };
    chrome._state.tabs = [{ ...tab }];
    chrome._state.grantedOrigins.add('*://*.example.com/*');
    await setSnapshots({ 'example.com': { bob: account('bob') }, 'app.example.com': { carol: account('carol') } });
    await chrome.storage.local.set({
      groups: ['example.com'],
      activeSnapshots: { 'example.com': { host: 'app.example.com', name: 'carol' } },
      previousSnapshots: { 'example.com': { host: 'example.com', name: 'bob' } },
    });

    await press();

    expect(sid()).toBe('bob');
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(messagesOf('ping')).toEqual([]);
    expect(stored('activeSnapshots')).toEqual({ 'example.com': { host: 'example.com', name: 'bob' } });
    expect(stored('previousSnapshots')).toEqual({ 'example.com': { host: 'app.example.com', name: 'carol' } });
    expect(stored('commandNotice')).toBeUndefined();
  });

  it('a non-popup context such as the service worker or an options tab does not block', async () => {
    chrome._state.contexts = [
      { contextType: 'BACKGROUND' },
      { contextType: 'TAB', documentUrl: 'chrome-extension://test-extension-id/options/options.html' },
    ];
    await press();
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
  });

  it('a tab that moved to another origin fails the switch and leaves the record', async () => {
    page.getStorageData = async () => {
      chrome._state.tabs[0].url = 'https://evil.test/';
      return { localStorage: { user: 'alice' } };
    };
    await press();
    expectRefused('error_load_failed');
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(await getBackups()).toEqual({});
  });

  it('a backup that cannot be written stops the switch', async () => {
    const set = chrome.storage.local.set;
    vi.spyOn(chrome.storage.local, 'set').mockImplementation(async items => {
      if ('backups/example.com' in items) throw new Error('QUOTA_BYTES quota exceeded');
      return set(items);
    });
    await press();
    expectRefused('shortcut_backup_failed');
    expect(sid()).toBe('alice');
    expect(messagesOf('setStorageData')).toEqual([]);
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
  });

  it('a page write that does not arrive fails the switch and leaves the record, with the backup kept', async () => {
    page.setStorageData = async () => { throw new Error('Receiving end does not exist.'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await press();
    expectRefused('error_load_failed');
    expect(page.user).toBe('alice');
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    expect(stored('previousSnapshots')).toEqual({ 'example.com': { host: 'example.com', name: 'bob' } });
    expect((await getBackups())['example.com']).toMatchObject({ localStorage: { user: 'alice' } });
  });

  it('with cookies turned off switches the storage without the host permission', async () => {
    chrome._state.grantedOrigins.clear();
    await chrome.storage.local.set({
      settings: { enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } },
    });
    await press();
    expect(page.user).toBe('bob');
    expect(sid()).toBe('alice');
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
    expect(stored('commandNotice')).toBeUndefined();
  });

  it('does nothing when no tab is passed and none is active', async () => {
    chrome.tabs.query = vi.fn().mockResolvedValue([]);
    await press('switch-previous', undefined);
    expect(chrome.tabs.query).toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });
    expect(stored('commandNotice')).toBeUndefined();
    expect(chrome._state.badges).toEqual({});
  });

  it('a second press while one is running is ignored', async () => {
    await Promise.all([press(), press()]);
    expect(messagesOf('setStorageData')).toHaveLength(1);
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
  });

  it('a press after a refused or a failing switch works again', async () => {
    await chrome.storage.local.set({ previousSnapshots: {} });
    await press();
    expectRefused('shortcut_no_previous');
    await chrome.storage.local.set({ previousSnapshots: { 'example.com': { host: 'example.com', name: 'bob' } } });

    const setStorageData = page.setStorageData;
    page.setStorageData = async () => ({ error: 'blocked' });
    await press();
    expectRefused('error_load_failed');
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'alice' });

    page.setStorageData = setStorageData;
    await press();
    expect(stored('activeSnapshots')).toEqual({ 'example.com': 'bob' });
    expect(page.user).toBe('bob');
  });

  it.each([
    ['missing', () => undefined],
    ['rejecting', () => vi.fn().mockRejectedValue(new Error('no focused window'))],
  ])('with openPopup %s the notice and the ! stay', async (_label, openPopup) => {
    chrome.action.openPopup = openPopup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await chrome.storage.local.set({ settings: { autoBackup: false } });
    await press();
    expectRefused('shortcut_needs_backup');
  });

  describe('the ! badge', () => {
    beforeEach(async () => {
      await chrome.storage.local.set({ previousSnapshots: {} });
    });

    it('gives way to the tab\'s badge and label colour after 4 s', async () => {
      await setSnapshots({ 'example.com': { alice: { ...account('alice'), color: 'red' }, bob: account('bob') } });
      await press();
      expect(chrome._state.badges[1]).toBe('!');
      expect(chrome._state.badgeBackgrounds[1]).toBe('#1F63D8');

      await vi.advanceTimersByTimeAsync(3900);
      expect(chrome._state.badges[1]).toBe('!');

      await vi.advanceTimersByTimeAsync(100);
      expect(chrome._state.badges[1]).toBe('al');
      expect(chrome._state.badgeBackgrounds[1]).toBe('#C5221F');
    });

    it('is cleared after 4 s with the badge off', async () => {
      await chrome.storage.local.set({ settings: { showBadge: true, autoBackup: false } });
      await press();
      await chrome.storage.local.set({ settings: { showBadge: false, autoBackup: false } });
      await vi.advanceTimersByTimeAsync(4000);
      expect(chrome._state.badges[1]).toBe('');
    });

    it('draws the new site\'s badge on a tab that navigated within 4 s', async () => {
      await press();
      chrome._state.tabs[0].url = 'https://other.test/';
      await chrome.storage.local.set({ activeSnapshots: { 'example.com': 'alice', 'other.test': 'zed' } });
      await vi.advanceTimersByTimeAsync(4000);
      expect(chrome._state.badges[1]).toBe('ze');
    });

    it('is not redrawn on a tab closed within 4 s', async () => {
      await press();
      chrome._state.tabs = [];
      const setBadgeText = vi.spyOn(chrome.action, 'setBadgeText');
      await vi.advanceTimersByTimeAsync(4000);
      expect(setBadgeText).not.toHaveBeenCalled();
    });
  });
});
