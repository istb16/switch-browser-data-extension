import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setSnapshots, getSnapshots, setSettings, getSettings, setActiveSnapshots, getActiveSnapshots, getBackups } from '../../lib/storage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const popupHtml = readFileSync(path.join(repoRoot, 'popup/popup.html'), 'utf-8');
const bodyHtml = popupHtml.match(/<body>([\s\S]*)<\/body>/)[1];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

const $ = id => document.getElementById(id);
const rows = () => [...document.querySelectorAll('#snapshotList .snapshot')];
const rowNames = () => rows().map(r => r.dataset.name);
const row = name => rows().find(r => r.dataset.name === name);

// The page state the content script reports; setStorageData replaces it.
let pageData;

function mockContentScript() {
  chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
    if (message.type === 'ping') return { ok: true };
    if (message.type === 'getStorageData') return structuredClone(pageData);
    if (message.type === 'setStorageData') {
      pageData = { ...pageData, ...structuredClone(message.data) };
      return { success: true };
    }
  });
}

async function loadPopup(tabUrl) {
  document.body.innerHTML = bodyHtml;
  chrome.tabs.query = vi.fn().mockResolvedValue(tabUrl == null ? [] : [{ id: 1, url: tabUrl }]);
  vi.resetModules();
  await import('../../popup/popup.js');
  await settle();
}

const snap = (savedAt, data = {}) => ({ savedAt, ...data });

describe('popup/popup.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    pageData = { localStorage: { current: '1' } };
    mockContentScript();
    // Most tests are about a site whose cookie access was already allowed.
    chrome._state.grantedOrigins.add('*://example.com/*');
  });

  describe('when cookie access to the site has not been allowed yet', () => {
    beforeEach(() => {
      chrome._state.grantedOrigins.clear();
    });

    it('asks for it up front instead of showing the list', async () => {
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z') } });
      chrome.permissions.request = vi.fn();
      await loadPopup('https://example.com/');

      expect($('currentDomain').textContent).toBe('example.com');
      expect($('permissionPanel').classList.contains('hidden')).toBe(false);
      expect($('mainContent').classList.contains('hidden')).toBe(true);
      expect(rows()).toHaveLength(0);
      expect(chrome.permissions.request).not.toHaveBeenCalled();
    });

    it('requests access for this site only, and shows the list when the popup survives the prompt', async () => {
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z') } });
      const request = vi.spyOn(chrome.permissions, 'request');
      await loadPopup('https://example.com/');

      $('grantPermissionBtn').click();
      await settle();

      expect(request).toHaveBeenCalledWith({ origins: ['*://example.com/*'] });
      expect($('permissionPanel').classList.contains('hidden')).toBe(true);
      expect($('mainContent').classList.contains('hidden')).toBe(false);
      expect(rowNames()).toEqual(['first']);
    });

    it('says so when access is not allowed, and keeps asking', async () => {
      chrome.permissions.request = vi.fn().mockResolvedValue(false);
      await loadPopup('https://example.com/');

      $('grantPermissionBtn').click();
      await settle();

      expect($('permissionDenied').classList.contains('hidden')).toBe(false);
      expect($('permissionPanel').classList.contains('hidden')).toBe(false);
      expect($('mainContent').classList.contains('hidden')).toBe(true);
    });

    it('offers the settings page for not using cookies', async () => {
      chrome.runtime.openOptionsPage = vi.fn();
      await loadPopup('https://example.com/');

      $('skipCookiesBtn').click();

      expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
    });

    it('does not ask when cookies are turned off in settings', async () => {
      await setSettings({ ...(await getSettings()), enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
      await loadPopup('https://example.com/');

      expect($('permissionPanel').classList.contains('hidden')).toBe(true);
      expect($('mainContent').classList.contains('hidden')).toBe(false);
    });
  });

  it('shows the "unavailable" message for restricted URLs (chrome://, edge://, no tab)', async () => {
    await loadPopup('chrome://extensions/');

    expect($('unavailableMsg').classList.contains('hidden')).toBe(false);
    expect($('mainContent').classList.contains('hidden')).toBe(true);
    expect($('currentDomain').textContent).toBe('-');
  });

  it('shows the "unavailable" message when there is no active tab at all', async () => {
    await loadPopup(undefined);
    expect($('unavailableMsg').classList.contains('hidden')).toBe(false);
  });

  it('detects the domain from the active tab and reveals the main content', async () => {
    await loadPopup('https://example.com/some/path?x=1');

    expect($('currentDomain').textContent).toBe('example.com');
    expect($('mainContent').classList.contains('hidden')).toBe(false);
  });

  it('shows the empty state when the domain has no snapshots', async () => {
    await loadPopup('https://example.com/');

    expect(rows()).toHaveLength(0);
    expect($('emptyState').classList.contains('hidden')).toBe(false);
    expect($('searchBox').classList.contains('hidden')).toBe(true);
  });

  it('lists the snapshots in order with a relative saved time and a number key', async () => {
    await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z'), second: snap('2024-02-02T00:00:00.000Z') } });
    await loadPopup('https://example.com/');

    expect(rowNames()).toEqual(['first', 'second']);
    expect($('emptyState').classList.contains('hidden')).toBe(true);
    expect(row('first').querySelector('.snapshot__meta').title).toContain('2024');
    expect(row('second').querySelector('.snapshot__key').textContent).toBe('2');
  });

  it('shows the search box from five snapshots and filters the list by name', async () => {
    const many = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'admin'].map(n => [n, snap('2024-01-01T00:00:00.000Z')]));
    await setSnapshots({ 'example.com': many });
    await loadPopup('https://example.com/');

    expect($('searchBox').classList.contains('hidden')).toBe(false);

    $('searchInput').value = 'AD';
    $('searchInput').dispatchEvent(new Event('input'));
    expect(rowNames()).toEqual(['admin']);

    $('searchInput').value = 'zzz';
    $('searchInput').dispatchEvent(new Event('input'));
    expect(rows()).toHaveLength(0);
    expect($('noMatch').classList.contains('hidden')).toBe(false);
  });

  it('marks the active snapshot, and flags it when the page data has changed since', async () => {
    await setSnapshots({ 'example.com': {
      first:  snap('2024-01-01T00:00:00.000Z', { localStorage: { current: '1' } }),
      second: snap('2024-01-01T00:00:00.000Z'),
    } });
    await setActiveSnapshots({ 'example.com': 'first' });
    await loadPopup('https://example.com/');

    expect(row('first').classList.contains('is-active')).toBe(true);
    expect(row('first').querySelector('.badge--active').classList.contains('hidden')).toBe(false);
    expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
    expect(row('second').querySelector('.badge--active').classList.contains('hidden')).toBe(true);

    pageData = { localStorage: { current: 'changed' } };
    await loadPopup('https://example.com/');
    expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(false);
  });

  it('discards a change check that finishes after a load started', async () => {
    await setSnapshots({ 'example.com': {
      first:  snap('2024-01-01T00:00:00.000Z', { localStorage: { current: '1' } }),
      second: snap('2024-01-01T00:00:00.000Z', { localStorage: { b: '2' } }),
    } });
    await setActiveSnapshots({ 'example.com': 'first' });
    let releaseCheck;
    const plain = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = vi.fn((tabId, message) => {
      if (message.digest) return new Promise(resolve => { releaseCheck = () => resolve({ localStorage: { stale: 'x' } }); });
      return plain(tabId, message);
    });
    await loadPopup('https://example.com/');

    row('second').querySelector('.snapshot__main').click();
    await settle();
    releaseCheck();
    await settle();

    expect(row('second').classList.contains('is-active')).toBe(true);
    expect(row('second').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
  });

  it('settings button opens the options page', async () => {
    await loadPopup('https://example.com/');
    chrome.runtime.openOptionsPage = vi.fn();

    $('settingsBtn').click();

    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });

  describe('saving the current state', () => {
    it('shows an error and does not save when the name is empty', async () => {
      await loadPopup('https://example.com/');
      $('saveBtn').click();
      $('confirmSaveBtn').click();
      await settle();

      expect($('statusMsg').className).toContain('error');
      expect(await getSnapshots()).toEqual({});
    });

    it('saves under the entered name and makes it the active snapshot', async () => {
      await loadPopup('https://example.com/');

      $('saveBtn').click();
      expect($('saveForm').classList.contains('hidden')).toBe(false);
      $('newSnapshotName').value = 'my snapshot';
      $('confirmSaveBtn').click();
      await settle();

      const snapshots = await getSnapshots();
      expect(snapshots['example.com']['my snapshot'].localStorage).toEqual({ current: '1' });
      expect((await getActiveSnapshots())['example.com']).toBe('my snapshot');
      expect(row('my snapshot').classList.contains('is-active')).toBe(true);
      expect($('saveForm').classList.contains('hidden')).toBe(true);
      expect($('statusMsg').className).toContain('success');
    });

    it('asks before overwriting a snapshot that has the entered name', async () => {
      await setSnapshots({ 'example.com': { existing: snap('2024-01-01T00:00:00.000Z', { localStorage: { old: '1' } }) } });
      await loadPopup('https://example.com/');

      $('saveBtn').click();
      $('newSnapshotName').value = 'existing';
      $('confirmSaveBtn').click();
      await settle();
      document.querySelector('.tk3-btn-cancel').click();
      await settle();
      expect((await getSnapshots())['example.com'].existing.localStorage).toEqual({ old: '1' });

      $('confirmSaveBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();
      expect((await getSnapshots())['example.com'].existing.localStorage).toEqual({ current: '1' });
    });

    it('overwrites from the row menu after confirming', async () => {
      await setSnapshots({ 'example.com': { existing: snap('2024-01-01T00:00:00.000Z', { localStorage: { old: '1' } }) } });
      await loadPopup('https://example.com/');

      row('existing').querySelector('[data-action="overwrite"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await getSnapshots())['example.com'].existing.localStorage).toEqual({ current: '1' });
    });
  });

  describe('loading a snapshot', () => {
    beforeEach(async () => {
      await setSnapshots({ 'example.com': {
        first:  snap('2024-01-01T00:00:00.000Z', { localStorage: { a: '1' } }),
        second: snap('2024-01-01T00:00:00.000Z', { localStorage: { b: '2' } }),
      } });
    });

    it('applies the snapshot on click, backs up the previous state, marks it active and reloads the tab', async () => {
      await loadPopup('https://example.com/');

      row('first').querySelector('.snapshot__main').click();
      await settle();

      expect(document.querySelector('dialog')).toBeNull();
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'setStorageData',
        data: { localStorage: { a: '1' } },
      }));
      expect((await getBackups())['example.com'].localStorage).toEqual({ current: '1' });
      expect((await getActiveSnapshots())['example.com']).toBe('first');
      expect(chrome._state.reloadedTabs).toEqual([1]);
      expect(row('first').classList.contains('is-active')).toBe(true);
      expect($('undoBar').classList.contains('hidden')).toBe(false);
      expect($('statusMsg').className).toContain('success');
    });

    it('still loads, and says so, when there is no room left to keep the backup', async () => {
      await loadPopup('https://example.com/');
      const set = chrome.storage.local.set;
      chrome.storage.local.set = async items => {
        if ('backups' in items) throw new Error('QUOTA_BYTES quota exceeded');
        return set(items);
      };

      row('first').querySelector('.snapshot__main').click();
      await settle();

      expect(pageData.localStorage).toEqual({ a: '1' });
      expect((await getActiveSnapshots())['example.com']).toBe('first');
      expect(await getBackups()).toEqual({});
      expect($('statusMsg').className).toContain('success');
      expect($('statusMsg').textContent).toContain('切り替え前の状態は残せませんでした');
    });

    it('restores the backed-up state with the undo button, and can swap back', async () => {
      await loadPopup('https://example.com/');
      row('first').querySelector('.snapshot__main').click();
      await settle();

      $('undoBtn').click();
      await settle();
      expect(pageData.localStorage).toEqual({ current: '1' });
      expect(document.activeElement).toBe($('undoBtn'));
      expect((await getActiveSnapshots())['example.com']).toBeUndefined();

      $('undoBtn').click();
      await settle();
      expect(pageData.localStorage).toEqual({ a: '1' });
      expect((await getActiveSnapshots())['example.com']).toBe('first');
    });

    it('asks first, and keeps no backup, when automatic backup is off', async () => {
      await setSettings({ ...(await getSettings()), autoBackup: false });
      await loadPopup('https://example.com/');

      row('first').querySelector('.snapshot__main').click();
      await settle();
      document.querySelector('.tk3-btn-cancel').click();
      await settle();
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'setStorageData' }));

      row('first').querySelector('.snapshot__main').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();
      expect(pageData.localStorage).toEqual({ a: '1' });
      expect(await getBackups()).toEqual({});
      expect($('undoBar').classList.contains('hidden')).toBe(true);
    });

    it('does not reload the tab when automatic reload is off', async () => {
      await setSettings({ ...(await getSettings()), autoReload: false });
      await loadPopup('https://example.com/');

      row('first').querySelector('.snapshot__main').click();
      await settle();

      expect(pageData.localStorage).toEqual({ a: '1' });
      expect(chrome._state.reloadedTabs).toEqual([]);
    });

    it('loads the nth snapshot with a number key, and moves between rows with the arrow keys', async () => {
      await loadPopup('https://example.com/');

      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      await settle();
      expect(pageData.localStorage).toEqual({ b: '2' });

      const firstMain = row('first').querySelector('.snapshot__main');
      firstMain.focus();
      firstMain.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(row('second').querySelector('.snapshot__main'));
    });
  });

  describe('cookies', () => {
    const sid = value => ({ name: 'sid', value, domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' });

    beforeEach(async () => {
      chrome._state.grantedOrigins.add('*://example.com/*');
      await setSnapshots({ 'example.com': {
        first:  snap('2024-01-01T00:00:00.000Z', { cookies: [sid('account-a')], localStorage: { current: '1' } }),
        second: snap('2024-01-01T00:00:00.000Z', { cookies: [sid('account-b')] }),
      } });
      await setActiveSnapshots({ 'example.com': 'first' });
    });

    it('flags a changed cookie value and names it in the badge tooltip', async () => {
      chrome._state.cookies = [sid('account-b')];
      await loadPopup('https://example.com/');

      const badge = row('first').querySelector('.badge--modified');
      expect(badge.classList.contains('hidden')).toBe(false);
      expect(badge.title).toContain('Cookie: sid');
    });

    it('does not flag a cookie the site was seen rewriting by itself', async () => {
      chrome._state.cookies = [sid('account-b')];
      await chrome.storage.local.set({ volatileCookies: { 'example.com': { 'example.com|/|sid': 'value' } } });
      await loadPopup('https://example.com/');

      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
    });

    it('leaves cookies out of the check while the service worker is still learning after a load', async () => {
      chrome._state.cookies = [sid('account-b')];
      await chrome.storage.local.set({ cookieChecks: { 1: { domain: 'example.com', cookies: [sid('account-a')], until: Date.now() + 60_000 } } });
      await loadPopup('https://example.com/');

      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
    });

    it('stops comparing a cookie the user ignores from the changed menu', async () => {
      chrome._state.cookies = [sid('account-b')];
      await loadPopup('https://example.com/');

      const ignore = row('first').querySelector('.changes-menu [data-action="ignore"]');
      expect(ignore.textContent).toContain('sid');
      ignore.click();
      await settle();

      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
      expect((await chrome.storage.local.get('volatileCookies')).volatileCookies)
        .toEqual({ 'example.com': { 'example.com|/|sid': 'value' } });
      expect($('statusMsg').className).toContain('success');

      await loadPopup('https://example.com/');
      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
    });

    it('records the applied cookies for the service worker before reloading', async () => {
      await loadPopup('https://example.com/');

      row('second').querySelector('.snapshot__main').click();
      await settle();

      const { cookieChecks } = await chrome.storage.local.get('cookieChecks');
      expect(cookieChecks[1]).toMatchObject({ domain: 'example.com', cookies: [sid('account-b')] });
      expect(chrome._state.reloadedTabs).toEqual([1]);
    });
  });

  describe('clearing the site\'s data', () => {
    const sid = { name: 'sid', value: 'a', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' };

    let blockedIndexedDB = [];

    function mockContentScriptWithClear() {
      const base = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        if (message.type === 'clearStorageData') {
          pageData = {};
          return { success: true, blockedIndexedDB: blockedIndexedDB };
        }
        return base(tabId, message);
      });
    }

    beforeEach(async () => {
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z', { localStorage: { current: '1' } }) } });
      await setActiveSnapshots({ 'example.com': 'first' });
      chrome._state.cookies = [sid];
      blockedIndexedDB = [];
      mockContentScriptWithClear();
    });

    it('cancels a cookie check left from a recent load, so the cleared jar is not learned from', async () => {
      await chrome.storage.local.set({ cookieChecks: { 1: { domain: 'example.com', cookies: [sid], until: Date.now() + 60_000 } } });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual({});
    });

    it('touches nothing, and keeps the existing backup, when the page can\'t be reached', async () => {
      await chrome.storage.local.set({ backups: { 'example.com': { savedAt: '2024-01-01T00:00:00.000Z', activeName: null, localStorage: { earlier: '1' } } } });
      chrome.tabs.sendMessage = vi.fn(async () => {
        throw new Error('Receiving end does not exist.');
      });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect($('statusMsg').className).toContain('error');
      expect(chrome._state.cookies).toEqual([sid]);
      expect((await getBackups())['example.com'].localStorage).toEqual({ earlier: '1' });
      expect((await getActiveSnapshots())['example.com']).toBe('first');
    });

    it('says a reload is needed when the page keeps an IndexedDB open and automatic reload is off', async () => {
      blockedIndexedDB = ['app'];
      await setSettings({ ...(await getSettings()), autoReload: false });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect($('statusMsg').textContent).toContain('再読み込み');
      expect(chrome._state.reloadedTabs).toEqual([]);
    });

    it('hides the button when every data type is turned off', async () => {
      await setSettings({ ...(await getSettings()), enabledTypes: { cookies: false, localStorage: false, sessionStorage: false, indexedDB: false } });
      await loadPopup('https://example.com/');

      expect($('clearSiteBtn').classList.contains('hidden')).toBe(true);
    });

    it('does nothing when the confirmation is cancelled', async () => {
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      expect(document.querySelector('.tk3-dialog-msg').textContent).toContain('example.com');
      document.querySelector('.tk3-btn-cancel').click();
      await settle();

      expect(chrome._state.cookies).toEqual([sid]);
      expect(pageData.localStorage).toEqual({ current: '1' });
    });

    it('clears cookies and storage, backs up first, drops the active snapshot and reloads', async () => {
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect(chrome._state.cookies).toEqual([]);
      expect(pageData).toEqual({});
      const backup = (await getBackups())['example.com'];
      expect(backup.localStorage).toEqual({ current: '1' });
      expect(backup.cookies.map(c => c.value)).toEqual(['a']);
      expect(backup.activeName).toBe('first');
      expect((await getActiveSnapshots())['example.com']).toBeUndefined();
      expect(chrome._state.reloadedTabs).toEqual([1]);
      expect($('statusMsg').className).toContain('success');
      expect($('undoBar').classList.contains('hidden')).toBe(false);
    });

    it('can be undone with the undo bar', async () => {
      await loadPopup('https://example.com/');
      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      $('undoBtn').click();
      await settle();

      expect($('statusMsg').textContent).toBe('直前の状態に戻しました');
      expect(chrome._state.cookies.map(c => c.value)).toEqual(['a']);
      expect(pageData.localStorage).toEqual({ current: '1' });
      expect((await getActiveSnapshots())['example.com']).toBe('first');
    });

    it('only clears the data types turned on, and says it can\'t be undone without a backup', async () => {
      await setSettings({ ...(await getSettings()), autoBackup: false, enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: false } });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      const message = document.querySelector('.tk3-dialog-msg').textContent;
      expect(message).toContain('localStorage・sessionStorage');
      expect(message).not.toContain('Cookie');
      expect(message).toContain('元に戻せません');
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect(chrome._state.cookies).toEqual([sid]);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
        type: 'clearStorageData',
        types: { localStorage: true, sessionStorage: true, indexedDB: false },
      });
      expect(await getBackups()).toEqual({});
    });

    it('reports a failure, and keeps the cookies, when clearing the page\'s storage fails', async () => {
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (message.type === 'clearStorageData') return { error: 'SecurityError' };
        if (message.type === 'ping') return { ok: true };
        return structuredClone(pageData);
      });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect($('statusMsg').className).toContain('error');
      expect(chrome._state.cookies).toEqual([sid]);
      expect((await getActiveSnapshots())['example.com']).toBe('first');
    });
  });

  describe('row menu', () => {
    beforeEach(async () => {
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z'), second: snap('2024-01-01T00:00:00.000Z') } });
      await setActiveSnapshots({ 'example.com': 'first' });
    });

    it('deletes a snapshot after confirming', async () => {
      await loadPopup('https://example.com/');

      row('first').querySelector('[data-action="delete"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect(Object.keys((await getSnapshots())['example.com'])).toEqual(['second']);
      expect(rowNames()).toEqual(['second']);
      expect((await getActiveSnapshots())['example.com']).toBeUndefined();
      expect(document.activeElement).toBe(row('second').querySelector('.snapshot__main'));
    });

    it('renames a snapshot inline, keeping it active', async () => {
      await loadPopup('https://example.com/');

      row('first').querySelector('[data-action="rename"]').click();
      const input = row('first').querySelector('.snapshot__rename');
      expect(document.activeElement).toBe(input);
      expect(row('first').querySelector('.snapshot__more').disabled).toBe(true);
      row('first').querySelector('[data-action="rename"]').click();
      expect(row('first').querySelectorAll('.snapshot__rename')).toHaveLength(1);
      input.value = 'renamed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();

      expect(rowNames()).toEqual(['renamed', 'second']);
      expect((await getActiveSnapshots())['example.com']).toBe('renamed');
      expect(document.activeElement).toBe(row('renamed').querySelector('.snapshot__main'));
    });

    it('refuses to rename to an existing name, and Escape cancels', async () => {
      await loadPopup('https://example.com/');

      row('first').querySelector('[data-action="rename"]').click();
      const input = row('first').querySelector('.snapshot__rename');
      input.value = 'second';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect($('statusMsg').className).toContain('error');

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(rowNames()).toEqual(['first', 'second']);
      expect(row('first').querySelector('.snapshot__rename')).toBeNull();
    });
  });
});
