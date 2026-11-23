import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  getSnapshots, setSettings, getSettings, setActiveSnapshots, getActiveSnapshots, setGroups,
} from '../../lib/storage.js';
import { setSnapshots, getBackups, setBackups } from '../support/storage-seed.js';
import { byteSize, formatBytes } from '../../lib/snapshot-summary.js';

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

  describe('memo, colour and preview', () => {
    const NOW = Date.UTC(2025, 0, 1);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('popup row shows chip, memo and preview', async () => {
      const tagged = snap('2024-01-01T00:00:00.000Z', {
        cookies: [{ name: 'a', value: '1', domain: 'example.com', path: '/' }, { name: 'b', value: '2', domain: 'example.com', path: '/' }],
        localStorage: { x: '1', y: '2', z: '3' },
        indexedDB: { db: {} },
        memo: 'admin account',
        color: 'green',
      });
      await setSnapshots({ 'example.com': { tagged, odd: snap('2024-01-01T00:00:00.000Z', { color: 'pink' }) } });
      await loadPopup('https://example.com/');

      const r = row('tagged');
      expect(r.querySelector('.snapshot__chip').classList.contains('snapshot__chip--green')).toBe(true);
      expect(r.querySelector('.snapshot__chip').classList.contains('hidden')).toBe(false);
      expect(r.querySelector('.snapshot__memo').textContent).toBe('admin account');
      const preview = r.querySelector('.snapshot__preview');
      expect(preview.textContent).toBe(`Cookie 2 · LS 3 · IDB 1 · ${formatBytes(byteSize(tagged))}`);
      expect(preview.title).toContain('localStorage');
      expect(preview.title).toContain('IndexedDB');

      expect(row('odd').querySelector('.snapshot__chip')).toBeNull();
      expect(row('odd').querySelector('.snapshot__memo')).toBeNull();
    });

    it('popup preview shows a zero count', async () => {
      await setSnapshots({ 'example.com': { empty: snap('2024-01-01T00:00:00.000Z', { localStorage: {} }) } });
      await loadPopup('https://example.com/');

      expect(row('empty').querySelector('.snapshot__preview').textContent).toMatch(/^LS 0 · \d+ B$/);
    });

    it('popup preview of a snapshot with no types is the size alone', async () => {
      const bare = snap('2024-01-01T00:00:00.000Z');
      await setSnapshots({ 'example.com': { bare } });
      await loadPopup('https://example.com/');

      const text = row('bare').querySelector('.snapshot__preview').textContent;
      expect(text).toBe(formatBytes(byteSize(bare)));
      expect(text).not.toContain('·');
    });

    it('popup row warns only with an expired cookie', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      await setSnapshots({ 'example.com': {
        expired: snap('2024-01-01T00:00:00.000Z', { cookies: [{ name: 'a', value: '1', domain: 'example.com', path: '/', expirationDate: NOW / 1000 }] }),
        fresh:   snap('2024-01-01T00:00:00.000Z', { cookies: [{ name: 'a', value: '1', domain: 'example.com', path: '/', expirationDate: NOW / 1000 + 1 }] }),
      } });
      await loadPopup('https://example.com/');

      const warning = row('expired').querySelector('.snapshot__warning');
      expect(warning.classList.contains('hidden')).toBe(false);
      expect(warning.getAttribute('aria-label')).toBeTruthy();
      expect(row('fresh').querySelector('.snapshot__warning')).toBeNull();
    });

    it('popup search matches memo', async () => {
      const many = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(n => [n, snap('2024-01-01T00:00:00.000Z')]));
      many.gamma.memo = 'Staging Admin';
      await setSnapshots({ 'example.com': many });
      await loadPopup('https://example.com/');

      $('searchInput').value = 'admin';
      $('searchInput').dispatchEvent(new Event('input'));
      expect(rowNames()).toEqual(['gamma']);
    });

    it('popup save form stores memo and colour; edit dialog updates them', async () => {
      await loadPopup('https://example.com/');

      $('saveBtn').click();
      $('newSnapshotName').value = 'tagged';
      $('newSnapshotMemo').value = 'first memo';
      $('saveForm').querySelector('input[name="newSnapshotColor"][value="red"]').checked = true;
      $('confirmSaveBtn').click();
      await settle();

      let stored = (await getSnapshots())['example.com'].tagged;
      expect(stored).toMatchObject({ memo: 'first memo', color: 'red' });
      expect(row('tagged').querySelector('.snapshot__memo').textContent).toBe('first memo');
      // Closing the form resets it for the next save.
      expect($('newSnapshotMemo').value).toBe('');
      expect($('saveForm').querySelector('input[name="newSnapshotColor"]:checked').value).toBe('');

      row('tagged').querySelector('[data-action="edit"]').click();
      await settle();
      const dialog = document.querySelector('dialog');
      const memoInput = dialog.querySelector('input[type="text"]');
      expect(memoInput.value).toBe('first memo');
      expect(memoInput.maxLength).toBe(100);
      expect(dialog.querySelector('input[type="radio"]:checked').value).toBe('red');
      memoInput.value = 'second memo';
      dialog.querySelector('input[type="radio"][value="blue"]').checked = true;
      dialog.querySelector('.tk3-btn-confirm').click();
      await settle();

      stored = (await getSnapshots())['example.com'].tagged;
      expect(stored).toMatchObject({ memo: 'second memo', color: 'blue' });
      expect(row('tagged').querySelector('.snapshot__chip--blue')).not.toBeNull();
      expect($('statusMsg').className).toContain('success');

      row('tagged').querySelector('[data-action="edit"]').click();
      await settle();
      document.querySelector('dialog').querySelector('.tk3-btn-cancel').click();
      await settle();
      expect((await getSnapshots())['example.com'].tagged).toMatchObject({ memo: 'second memo', color: 'blue' });
    });

    it('keeps the memo and colour when overwriting from the row menu', async () => {
      await setSnapshots({ 'example.com': { tagged: snap('2024-01-01T00:00:00.000Z', { memo: 'keep', color: 'amber' }) } });
      await loadPopup('https://example.com/');

      row('tagged').querySelector('.actions-menu [data-action="overwrite"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await getSnapshots())['example.com'].tagged).toMatchObject({ memo: 'keep', color: 'amber', localStorage: { current: '1' } });
    });
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
        if ('backups/example.com' in items) throw new Error('QUOTA_BYTES quota exceeded');
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
      await chrome.storage.local.set({ cookieChecks: { 1: { domain: 'example.com', cookies: [sid('account-a')], origins: ['*://example.com/*'], cookieDomain: 'example.com', until: Date.now() + 60_000 } } });
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
      await chrome.storage.local.set({ cookieChecks: { 1: { domain: 'example.com', cookies: [sid], origins: ['*://example.com/*'], cookieDomain: 'example.com', until: Date.now() + 60_000 } } });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual({});
    });

    it('keeps the pending cookie checks when the cookies type is turned off', async () => {
      const checks = { 1: { domain: 'example.com', cookies: [sid], origins: ['*://example.com/*'], cookieDomain: 'example.com', until: Date.now() + 60_000 } };
      await chrome.storage.local.set({ cookieChecks: checks });
      await setSettings({ ...(await getSettings()), enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect($('statusMsg').className).toContain('success');
      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual(checks);
    });

    it('keeps the pending cookie checks when the page can\'t be reached', async () => {
      const checks = { 1: { domain: 'example.com', cookies: [sid], origins: ['*://example.com/*'], cookieDomain: 'example.com', until: Date.now() + 60_000 } };
      await chrome.storage.local.set({ cookieChecks: checks });
      chrome.tabs.sendMessage = vi.fn(async () => {
        throw new Error('Receiving end does not exist.');
      });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect($('statusMsg').className).toContain('error');
      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual(checks);
    });

    it('keeps the pending cookie checks when clearing the page\'s storage fails before the cookies', async () => {
      const checks = { 1: { domain: 'example.com', cookies: [sid], origins: ['*://example.com/*'], cookieDomain: 'example.com', until: Date.now() + 60_000 } };
      await chrome.storage.local.set({ cookieChecks: checks });
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (message.type === 'clearStorageData') throw new Error('Receiving end does not exist.');
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
      expect((await chrome.storage.local.get('cookieChecks')).cookieChecks).toEqual(checks);
    });

    it('touches nothing, and keeps the existing backup, when the page can\'t be reached', async () => {
      await setBackups({ 'example.com': { savedAt: '2024-01-01T00:00:00.000Z', activeName: null, localStorage: { earlier: '1' } } });
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

  describe('reloading the other tabs of the site', () => {
    const sid = (value, domain = 'example.com') => ({ name: 'sid', value, domain, path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    const tab = (id, url) => ({ id, url, status: 'complete' });
    const ACTIVE = tab(1, 'https://example.com/');
    const OTHERS = [
      tab(2, 'https://example.com/other'),
      tab(3, 'https://sub.example.com/'),
      tab(4, 'https://other.com/'),
      tab(5, 'http://example.com:8080/'),
      tab(6, 'https://example.com/third'),
    ];
    const LOADED = '"first" を適用しました';
    const suffix = count => `（ほかの ${count} タブも再読み込み）`;

    // The popup asks for its own tab with { active, currentWindow } and for
    // every tab with {}; `all` answers the latter.
    async function loadPopupWithTabs(active, others, all = async () => [active, ...others]) {
      document.body.innerHTML = bodyHtml;
      chrome._state.tabs = [active, ...others];
      chrome.tabs.query = vi.fn(async (info = {}) => (info.active ? [active] : all()));
      vi.resetModules();
      await import('../../popup/popup.js');
      await settle();
    }

    async function setReloadOtherTabs(more = {}) {
      await setSettings({ ...(await getSettings()), reloadOtherTabs: true, ...more });
    }

    function recordOrder() {
      const events = [];
      const set = chrome.storage.local.set;
      vi.spyOn(chrome.storage.local, 'set').mockImplementation(async items => {
        if ('cookieChecks' in items) events.push('cookieChecks');
        return set(items);
      });
      const reload = chrome.tabs.reload;
      vi.spyOn(chrome.tabs, 'reload').mockImplementation(async id => {
        events.push(`reload ${id}`);
        return reload(id);
      });
      const update = chrome.tabs.update;
      vi.spyOn(chrome.tabs, 'update').mockImplementation(async (id, details) => {
        events.push(`reload ${id}`);
        return update(id, details);
      });
      return events;
    }

    const storedCheck = async (tabId = 1) => (await chrome.storage.local.get('cookieChecks')).cookieChecks?.[tabId];

    async function clickLoad(name) {
      row(name).querySelector('.snapshot__main').click();
      await settle();
    }

    async function clearSite() {
      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();
    }

    beforeEach(async () => {
      await setSnapshots({ 'example.com': {
        first: snap('2024-01-01T00:00:00.000Z', { cookies: [sid('account-a')], localStorage: { a: '1' } }),
      } });
      chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
        if (message.type === 'clearStorageData') {
          pageData = {};
          return { success: true, blockedIndexedDB: [] };
        }
        if (message.type === 'ping') return { ok: true };
        if (message.type === 'getStorageData') return structuredClone(pageData);
        if (message.type === 'setStorageData') {
          pageData = { ...pageData, ...structuredClone(message.data) };
          return { success: true };
        }
      });
    });

    it('is off by default: only the active tab reloads and the status has no suffix', async () => {
      await loadPopupWithTabs(ACTIVE, OTHERS);
      await clickLoad('first');

      expect(chrome._state.reloadedTabs).toEqual([1]);
      expect((await storedCheck()).reloadTabs).toEqual([]);
      expect($('statusMsg').textContent).toBe(LOADED);
    });

    it('is ignored while automatic reload is off', async () => {
      await setReloadOtherTabs({ autoReload: false });
      await loadPopupWithTabs(ACTIVE, OTHERS);
      await clickLoad('first');

      expect(chrome._state.reloadedTabs).toEqual([]);
      expect((await storedCheck()).reloadTabs).toEqual([]);
      expect($('statusMsg').textContent).toBe(LOADED);
    });

    describe('after a load that wrote cookies', () => {
      it('hands the other tabs to the service worker before reloading the active tab, and reloads none itself', async () => {
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS);
        const events = recordOrder();
        await clickLoad('first');

        expect(events).toEqual(['cookieChecks', 'reload 1']);
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect((await storedCheck()).reloadTabs).toEqual([2, 3, 5, 6]);
        expect($('statusMsg').textContent).toBe(LOADED + suffix(4));
      });

      it('still starts the check and reloads the active tab when listing the tabs fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS, async () => {
          throw new Error('query failed');
        });
        await clickLoad('first');

        expect((await storedCheck()).reloadTabs).toEqual([]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').className).toContain('success');
        expect($('statusMsg').textContent).toBe(LOADED);
      });
    });

    describe('reloading from the popup', () => {
      it('with cookies off, reloads the active tab first, then the same-origin tabs', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        const events = recordOrder();
        await clickLoad('first');

        expect(events).toEqual(['reload 1', 'reload 2', 'reload 6']);
        expect(await storedCheck()).toBeUndefined();
        expect($('statusMsg').textContent).toBe(LOADED + suffix(2));
      });

      it('with only sessionStorage written, reloads no other tab, since it belongs to the tab alone', async () => {
        await setSnapshots({ 'example.com': {
          first: snap('2024-01-01T00:00:00.000Z', { sessionStorage: { s: '1' } }),
        } });
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        await clickLoad('first');

        expect(pageData.sessionStorage).toEqual({ s: '1' });
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').textContent).toBe(LOADED);
      });

      it('counts only the tabs that did reload', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        const update = chrome.tabs.update;
        vi.spyOn(chrome.tabs, 'update').mockImplementation(async (id, details) => {
          if (id === 6) throw new Error('No tab with id: 6');
          return update(id, details);
        });
        await clickLoad('first');

        expect(chrome._state.reloadedTabs).toEqual([1, 2]);
        expect($('statusMsg').textContent).toBe(LOADED + suffix(1));
      });

      it('says "1 other tab" in English when one other tab reloaded', async () => {
        chrome._state.uiLanguage = 'en-US';
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(ACTIVE, [OTHERS[0]]);
        await clickLoad('first');

        expect($('statusMsg').textContent).toMatch(/ \(also reloading 1 other tab\)$/);
      });

      it('adds nothing when every other tab fails to reload', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        const update = chrome.tabs.update;
        vi.spyOn(chrome.tabs, 'update').mockImplementation(async (id, details) => {
          if (id !== 1) throw new Error(`No tab with id: ${id}`);
          return update(id, details);
        });
        await clickLoad('first');

        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').className).toContain('success');
        expect($('statusMsg').textContent).toBe(LOADED);
      });

      it('with the host permission denied, reloads only the same-origin tabs', async () => {
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS);
        vi.spyOn(chrome.permissions, 'contains').mockResolvedValue(false);
        vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);
        await clickLoad('first');

        expect(chrome._state.reloadedTabs).toEqual([1, 2, 6]);
        expect(await storedCheck()).toBeUndefined();
        expect($('statusMsg').textContent).toBe(LOADED + suffix(2));
      });
    });

    describe('clearing the site\'s data', () => {
      const APP = tab(1, 'https://app.example.com/');
      const APP_OTHERS = [
        tab(2, 'https://app.example.com/x'),
        tab(3, 'https://api.app.example.com/'),
        tab(4, 'https://www.example.com/'),
        tab(5, 'https://example.com/'),
        tab(6, 'https://notexample.com/'),
      ];
      const CLEARED = '"app.example.com" のデータを消去しました';

      beforeEach(() => {
        chrome._state.grantedOrigins.add('*://app.example.com/*');
        chrome._state.cookies = [sid('a', 'app.example.com')];
      });

      it('outside a group, reloads the host\'s and its subdomains\' tabs, not a sibling\'s or the parent\'s', async () => {
        await setReloadOtherTabs();
        await loadPopupWithTabs(APP, APP_OTHERS);
        const events = recordOrder();
        await clearSite();

        expect(events.filter(e => e.startsWith('reload'))).toEqual(['reload 1', 'reload 2', 'reload 3']);
        expect($('statusMsg').textContent).toBe(CLEARED + suffix(2));
      });

      it('in a group, reloads every tab within the base', async () => {
        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        await setReloadOtherTabs();
        await loadPopupWithTabs(APP, APP_OTHERS);
        await clearSite();

        expect(chrome._state.reloadedTabs).toEqual([1, 2, 3, 4, 5]);
        expect($('statusMsg').textContent).toContain(suffix(4));
      });

      it('with cookies off, reloads only the same-origin tabs', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(APP, APP_OTHERS);
        await clearSite();

        expect(chrome._state.reloadedTabs).toEqual([1, 2]);
        expect($('statusMsg').textContent).toBe(CLEARED + suffix(1));
      });

      it('with only IndexedDB on, reloads only the same-origin tabs and leaves the cookies', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: false, sessionStorage: false, indexedDB: true } });
        await loadPopupWithTabs(APP, APP_OTHERS);
        await clearSite();

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'clearStorageData', types: { localStorage: false, sessionStorage: false, indexedDB: true } });
        expect(chrome._state.cookies).toHaveLength(1);
        expect(chrome._state.reloadedTabs).toEqual([1, 2]);
        expect($('statusMsg').textContent).toBe(CLEARED + suffix(1));
      });

      it('with only sessionStorage on, reloads no other tab', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: false, sessionStorage: true, indexedDB: false } });
        await loadPopupWithTabs(APP, APP_OTHERS);
        await clearSite();

        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').textContent).toBe(CLEARED);
      });

      function blockIndexedDB() {
        const base = chrome.tabs.sendMessage;
        chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
          if (message.type === 'clearStorageData') return { success: true, blockedIndexedDB: ['app'] };
          return base(tabId, message);
        });
      }

      it('with a database the page keeps open, reloads the same-origin tabs too, so its deletion completes', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: false, sessionStorage: false, indexedDB: true } });
        await loadPopupWithTabs(APP, APP_OTHERS);
        blockIndexedDB();
        await clearSite();

        expect(chrome._state.reloadedTabs).toEqual([1, 2]);
        expect($('statusMsg').textContent).toBe(CLEARED + suffix(1));
      });

      it('with a database the page keeps open and automatic reload off, asks for a reload and reloads no tab', async () => {
        await setReloadOtherTabs({ autoReload: false, enabledTypes: { cookies: false, localStorage: false, sessionStorage: false, indexedDB: true } });
        await loadPopupWithTabs(APP, APP_OTHERS);
        blockIndexedDB();
        await clearSite();

        expect(chrome._state.reloadedTabs).toEqual([]);
        expect($('statusMsg').textContent).toBe('"app.example.com" のデータを消去しました。IndexedDB はページが使用中のため、ページを再読み込みすると消えます');
      });

      it('adds nothing when no other tab is of the site', async () => {
        await setReloadOtherTabs();
        await loadPopupWithTabs(APP, [tab(6, 'https://notexample.com/')]);
        await clearSite();

        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').textContent).toBe(CLEARED);
      });
    });

    describe('a load in a subdomain group', () => {
      beforeEach(async () => {
        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
      });

      it('of another host\'s snapshot from before the group reloads only that host\'s tabs', async () => {
        await setSnapshots({ 'www.example.com': {
          first: snap('2024-01-01T00:00:00.000Z', { cookies: [sid('b', 'www.example.com')], localStorage: { a: '1' } }),
        } });
        await setReloadOtherTabs();
        await loadPopupWithTabs(tab(1, 'https://app.example.com/'), [
          tab(2, 'https://app.example.com/other'),
          tab(3, 'https://www.example.com/'),
          tab(4, 'https://api.www.example.com/'),
          tab(5, 'https://example.com/'),
        ]);
        await clickLoad('first');

        expect((await storedCheck()).reloadTabs).toEqual([3, 4]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
      });
    });

    describe('undo', () => {
      it('outside a group, hands over the host\'s and its subdomains\' tabs', async () => {
        await setBackups({ 'example.com': { savedAt: '2024-01-01T00:00:00.000Z', activeName: null, cookies: [sid('previous')], localStorage: { a: '0' } } });
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS);
        $('undoBtn').click();
        await settle();

        expect((await storedCheck()).reloadTabs).toEqual([2, 3, 5, 6]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').textContent).toBe(`直前の状態に戻しました${suffix(4)}`);
      });

      it('with the host permission denied, starts no check and reloads the same-origin tabs itself', async () => {
        await setBackups({ 'example.com': { savedAt: '2024-01-01T00:00:00.000Z', activeName: null, cookies: [sid('previous')], localStorage: { a: '0' } } });
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS);
        vi.spyOn(chrome.permissions, 'contains').mockResolvedValue(false);
        vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);
        const events = recordOrder();
        $('undoBtn').click();
        await settle();

        expect(events).toEqual(['reload 1', 'reload 2', 'reload 6']);
        expect(await storedCheck()).toBeUndefined();
        expect(chrome._state.cookies.some(c => c.value === 'previous')).toBe(false);
        expect(pageData.localStorage).toEqual({ a: '0' });
        expect($('statusMsg').textContent).toBe(`直前の状態に戻しました${suffix(2)}`);
      });

      it('in a group, hands over every tab within the base', async () => {
        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        await setBackups({ 'app.example.com': {
          savedAt: '2024-01-01T00:00:00.000Z', activeName: null, cookieDomain: 'example.com',
          cookies: [sid('previous', '.example.com')], localStorage: { a: '0' },
        } });
        await setReloadOtherTabs();
        await loadPopupWithTabs(tab(1, 'https://app.example.com/'), [
          tab(2, 'https://www.example.com/'),
          tab(3, 'https://example.com/'),
          tab(4, 'https://notexample.com/'),
          tab(5, 'https://app.example.com/other'),
        ]);
        $('undoBtn').click();
        await settle();

        expect((await storedCheck()).reloadTabs).toEqual([2, 3, 5]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
      });
    });
  });

  describe('in a subdomain group', () => {
    const GROUP_ORIGINS = ['*://example.com/*', '*://*.example.com/*'];
    const cookie = (name, domain, value) => ({ name, value, domain, path: '/', secure: true, httpOnly: false, sameSite: 'lax' });
    const jar = () => chrome._state.cookies.map(c => `${c.domain}:${c.name}=${c.value}`).sort();
    const isHidden = el => el.classList.contains('hidden');

    beforeEach(async () => {
      await setGroups(['example.com']);
      chrome._state.grantedOrigins.add('*://*.example.com/*');
    });

    it('popup in a group lists the snapshots of every member host', async () => {
      await setSnapshots({
        'www.example.com': { mine: snap('2024-01-01T00:00:00.000Z') },
        'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z', { localStorage: { a: '1' } }) },
        'example.com':     { base: snap('2024-01-01T00:00:00.000Z') },
        'other.com':       { outside: snap('2024-01-01T00:00:00.000Z') },
      });
      await loadPopup('https://www.example.com/');

      expect($('currentDomain').textContent).toBe('www.example.com');
      expect(isHidden($('groupChip'))).toBe(false);
      expect($('groupChip').textContent).toContain('example.com');
      expect(rowNames()).toEqual(['mine', 'theirs', 'base']);
      expect(row('mine').querySelector('.snapshot__host')).toBeNull();
      expect(row('mine').querySelector('.actions-menu [data-action="overwrite"]')).not.toBeNull();
      expect(row('theirs').querySelector('.snapshot__host').textContent).toBe('app.example.com');
      expect(row('theirs').querySelector('.actions-menu [data-action="overwrite"]')).toBeNull();
      expect(row('base').querySelector('.snapshot__host').textContent).toBe('example.com');
    });

    it('popup in a group saves under the current host with cookieDomain set', async () => {
      chrome._state.cookies = [cookie('parent', '.example.com', 'p'), cookie('sibling', 'app.example.com', 's')];
      await loadPopup('https://www.example.com/');

      $('saveBtn').click();
      $('newSnapshotName').value = 'saved';
      $('confirmSaveBtn').click();
      await settle();

      const saved = (await getSnapshots())['www.example.com'].saved;
      expect(saved.cookieDomain).toBe('example.com');
      expect(saved.cookies.map(c => c.name).sort()).toEqual(['parent', 'sibling']);
      expect(saved.localStorage).toEqual({ current: '1' });
      expect((await getActiveSnapshots())['example.com']).toEqual({ host: 'www.example.com', name: 'saved' });
      expect(row('saved').classList.contains('is-active')).toBe(true);
    });

    it('popup permission panel asks for the group origins', async () => {
      chrome._state.grantedOrigins.clear();
      chrome._state.grantedOrigins.add('*://www.example.com/*');
      const request = vi.spyOn(chrome.permissions, 'request');
      await loadPopup('https://www.example.com/');

      expect(isHidden($('permissionPanel'))).toBe(false);
      expect($('permissionBody').textContent).toContain('example.com');
      $('grantPermissionBtn').click();
      await settle();
      expect(request).toHaveBeenCalledWith({ origins: GROUP_ORIGINS });
      expect(isHidden($('mainContent'))).toBe(false);
    });

    it('popup load of another host\'s row reports page data skipped and marks it active', async () => {
      chrome._state.cookies = [cookie('parent', '.example.com', 'before')];
      await setSnapshots({ 'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z', {
        cookieDomain: 'example.com', cookies: [cookie('parent', '.example.com', 'after')], localStorage: { a: '1' },
      }) } });
      await loadPopup('https://www.example.com/');

      row('theirs').querySelector('.snapshot__main').click();
      await settle();

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'setStorageData' }));
      expect(pageData.localStorage).toEqual({ current: '1' });
      expect(jar()).toEqual(['.example.com:parent=after']);
      expect($('statusMsg').className).toContain('success');
      expect($('statusMsg').textContent).toContain('app.example.com');
      expect((await getActiveSnapshots())['example.com']).toEqual({ host: 'app.example.com', name: 'theirs' });
      expect(row('theirs').classList.contains('is-active')).toBe(true);
      const { cookieChecks } = await chrome.storage.local.get('cookieChecks');
      expect(cookieChecks[1]).toMatchObject({ domain: 'example.com', origins: GROUP_ORIGINS, cookieDomain: 'example.com' });
    });

    it('popup load of a pre-group snapshot in a group leaves .base and sibling cookies in place', async () => {
      chrome._state.cookies = [
        cookie('parent', '.example.com', 'p'), cookie('sibling', 'www.example.com', 's'), cookie('own', 'app.example.com', 'old'),
      ];
      await setSnapshots({ 'app.example.com': { pre: snap('2024-01-01T00:00:00.000Z', { cookies: [cookie('own', 'app.example.com', 'new')] }) } });
      await loadPopup('https://app.example.com/');

      row('pre').querySelector('.snapshot__main').click();
      await settle();

      expect(jar()).toEqual(['.example.com:parent=p', 'app.example.com:own=new', 'www.example.com:sibling=s']);
      const { cookieChecks } = await chrome.storage.local.get('cookieChecks');
      expect(cookieChecks[1]).toMatchObject({ cookieDomain: 'app.example.com', cookies: [cookie('own', 'app.example.com', 'new')] });
    });

    it('popup in a group shows no "changed" for a pre-group snapshot when only sibling cookies differ', async () => {
      chrome._state.cookies = [
        cookie('own', 'app.example.com', '1'), cookie('sibling', 'www.example.com', 'x'), cookie('parent', '.example.com', 'y'),
      ];
      await setSnapshots({ 'app.example.com': { pre: snap('2024-01-01T00:00:00.000Z', { cookies: [cookie('own', 'app.example.com', '1')] }) } });
      await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'pre' } });
      await loadPopup('https://app.example.com/');

      expect(row('pre').classList.contains('is-active')).toBe(true);
      expect(isHidden(row('pre').querySelector('.badge--modified'))).toBe(true);
    });

    it('popup load of a pre-group snapshot on the base host leaves sibling-host cookies in place', async () => {
      chrome._state.cookies = [
        cookie('parent', '.example.com', 'old'), cookie('sibling', 'www.example.com', 's'), cookie('own', 'app.example.com', 'o'),
      ];
      await setSnapshots({ 'example.com': { pre: snap('2024-01-01T00:00:00.000Z', { cookies: [cookie('parent', '.example.com', 'new')] }) } });
      await loadPopup('https://example.com/');

      row('pre').querySelector('.snapshot__main').click();
      await settle();

      expect(jar()).toEqual(['.example.com:parent=new', 'app.example.com:own=o', 'www.example.com:sibling=s']);
      const { cookieChecks } = await chrome.storage.local.get('cookieChecks');
      expect(cookieChecks[1]).toMatchObject({ cookieDomain: 'example.com', cookieExact: true, cookies: [cookie('parent', '.example.com', 'new')] });
    });

    it('popup on the base host shows no "changed" for a pre-group snapshot when only sibling-host cookies exist', async () => {
      chrome._state.cookies = [
        cookie('parent', '.example.com', '1'), cookie('sibling', 'www.example.com', 'x'), cookie('own', 'app.example.com', 'y'),
      ];
      await setSnapshots({ 'example.com': { pre: snap('2024-01-01T00:00:00.000Z', { cookies: [cookie('parent', '.example.com', '1')] }) } });
      await setActiveSnapshots({ 'example.com': { host: 'example.com', name: 'pre' } });
      await loadPopup('https://example.com/');

      expect(row('pre').classList.contains('is-active')).toBe(true);
      expect(isHidden(row('pre').querySelector('.badge--modified'))).toBe(true);
    });

    it('clear-site in a group cancels the pending cookie checks of every member tab', async () => {
      const until = Date.now() + 60_000;
      await chrome.storage.local.set({ cookieChecks: {
        1: { domain: 'example.com', cookies: [], origins: ['*://example.com/*'], cookieDomain: 'example.com', until },
        2: { domain: 'example.com', cookies: [cookie('parent', '.example.com', 'p')], origins: ['*://example.com/*'], cookieDomain: 'example.com', until },
        3: { domain: 'other.com', cookies: [], origins: ['*://other.com/*'], cookieDomain: 'other.com', until },
      } });
      const base = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        if (message.type === 'clearStorageData') return { success: true, blockedIndexedDB: [] };
        return base(tabId, message);
      });
      await loadPopup('https://www.example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect(Object.keys((await chrome.storage.local.get('cookieChecks')).cookieChecks)).toEqual(['3']);
    });

    it('popup outside a group lists a group-saved snapshot on its host and compares only the host\'s cookies', async () => {
      await setGroups([]);
      chrome._state.grantedOrigins.add('*://app.example.com/*');
      chrome._state.cookies = [cookie('own', 'app.example.com', '1'), cookie('parent', '.example.com', 'changed')];
      await setSnapshots({ 'app.example.com': { grouped: snap('2024-01-01T00:00:00.000Z', {
        cookieDomain: 'example.com',
        cookies: [cookie('own', 'app.example.com', '1'), cookie('parent', '.example.com', 'old'), cookie('sibling', 'www.example.com', 's')],
      }) } });
      await setActiveSnapshots({ 'app.example.com': 'grouped' });
      await loadPopup('https://app.example.com/');

      expect(rowNames()).toEqual(['grouped']);
      expect(row('grouped').querySelector('.snapshot__host')).toBeNull();
      expect(row('grouped').classList.contains('is-active')).toBe(true);
      expect(isHidden(row('grouped').querySelector('.badge--modified'))).toBe(true);
      expect(row('grouped').querySelector('.snapshot__preview').textContent).toMatch(/^Cookie 1 · /);
    });

    it('detectChanges ignores localStorage differences for a row of another host', async () => {
      chrome._state.cookies = [cookie('parent', '.example.com', '1')];
      await setSnapshots({ 'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z', {
        cookieDomain: 'example.com', cookies: [cookie('parent', '.example.com', '1')], localStorage: { other: 'x' },
      }) } });
      await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'theirs' } });
      await loadPopup('https://www.example.com/');
      expect(isHidden(row('theirs').querySelector('.badge--modified'))).toBe(true);

      chrome._state.cookies = [cookie('parent', '.example.com', '2')];
      await loadPopup('https://www.example.com/');
      const badge = row('theirs').querySelector('.badge--modified');
      expect(isHidden(badge)).toBe(false);
      expect(badge.title).toContain('Cookie: parent');
      expect(badge.title).not.toContain('localStorage');
      expect(row('theirs').querySelector('.changes-menu [data-action="overwrite"]')).toBeNull();
      expect(row('theirs').querySelector('.changes-menu [data-action="ignore"]')).not.toBeNull();
    });

    it('undo in a group restores the current host\'s backup', async () => {
      chrome._state.cookies = [cookie('parent', '.example.com', 'before')];
      await setSnapshots({ 'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z', {
        cookieDomain: 'example.com', cookies: [cookie('parent', '.example.com', 'after')], localStorage: { a: '1' },
      }) } });
      await loadPopup('https://www.example.com/');
      row('theirs').querySelector('.snapshot__main').click();
      await settle();
      expect(jar()).toEqual(['.example.com:parent=after']);
      expect((await getBackups())['www.example.com'].localStorage).toEqual({ current: '1' });
      pageData.localStorage = { changed: '1' };

      $('undoBtn').click();
      await settle();

      expect(jar()).toEqual(['.example.com:parent=before']);
      expect(pageData.localStorage).toEqual({ current: '1' });
      expect((await getActiveSnapshots())['example.com']).toBeUndefined();

      $('undoBtn').click();
      await settle();
      expect((await getActiveSnapshots())['example.com']).toEqual({ host: 'app.example.com', name: 'theirs' });
    });

    it('clear-site in a group clears the group\'s cookies and only the current page\'s storage', async () => {
      chrome._state.cookies = [
        cookie('parent', '.example.com', 'p'), cookie('sibling', 'app.example.com', 's'), cookie('own', 'www.example.com', 'o'),
        cookie('other', 'other.com', 'x'),
      ];
      const base = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        if (message.type === 'clearStorageData') {
          pageData = {};
          return { success: true, blockedIndexedDB: [] };
        }
        return base(tabId, message);
      });
      await loadPopup('https://www.example.com/');

      $('clearSiteBtn').click();
      await settle();
      expect(document.querySelector('.tk3-dialog-msg').textContent).toContain('グループ example.com');
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect(jar()).toEqual(['other.com:other=x']);
      const clears = chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message.type === 'clearStorageData');
      expect(clears).toEqual([[1, { type: 'clearStorageData', types: { localStorage: true, sessionStorage: true, indexedDB: true } }]]);
      expect((await getBackups())['www.example.com'].cookies.map(c => c.name).sort()).toEqual(['own', 'parent', 'sibling']);
    });

    it('rename and delete in a group act on the row\'s own host key and keep the active reference right', async () => {
      await setSnapshots({
        'www.example.com': { mine: snap('2024-01-01T00:00:00.000Z') },
        'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z') },
      });
      await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'theirs' } });
      await loadPopup('https://www.example.com/');

      row('theirs').querySelector('[data-action="rename"]').click();
      const input = row('theirs').querySelector('.snapshot__rename');
      input.value = 'renamed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();

      expect(Object.keys((await getSnapshots())['app.example.com'])).toEqual(['renamed']);
      expect((await getActiveSnapshots())['example.com']).toEqual({ host: 'app.example.com', name: 'renamed' });
      expect(row('renamed').classList.contains('is-active')).toBe(true);
      expect(document.activeElement).toBe(row('renamed').querySelector('.snapshot__main'));

      row('renamed').querySelector('[data-action="delete"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      const stored = await getSnapshots();
      expect(stored['app.example.com']).toBeUndefined();
      expect(Object.keys(stored['www.example.com'])).toEqual(['mine']);
      expect((await getActiveSnapshots())['example.com']).toBeUndefined();
      expect(rowNames()).toEqual(['mine']);
    });
  });

  describe('reading on open', () => {
    const keysOf = call => [call[0]].flat();
    const storeReads = spy => spy.mock.calls.filter(call => call[0] !== 'language');

    it('opening on a site reads only that site\'s snapshot keys', async () => {
      await setSnapshots({
        'example.com': { mine: snap('2024-01-01T00:00:00.000Z') },
        'other.com':   { theirs: snap('2024-01-01T00:00:00.000Z') },
      });
      const get = vi.spyOn(chrome.storage.local, 'get');
      await loadPopup('https://example.com/');

      expect(rowNames()).toEqual(['mine']);
      expect(get.mock.calls.some(call => call[0] === null)).toBe(false);
      expect(get.mock.calls.flatMap(keysOf)).not.toContain('snapshots/other.com');
      expect(get.mock.calls.flatMap(keysOf)).toContain('snapshots/example.com');
      expect(storeReads(get).length).toBeLessThanOrEqual(3);
    });

    it('in a group, every member host\'s key is read', async () => {
      await setGroups(['example.com']);
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      await setSnapshots({
        'www.example.com': { mine: snap('2024-01-01T00:00:00.000Z') },
        'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z') },
        'other.com':       { outside: snap('2024-01-01T00:00:00.000Z') },
      });
      const get = vi.spyOn(chrome.storage.local, 'get');
      await loadPopup('https://www.example.com/');

      expect(rowNames()).toEqual(['mine', 'theirs']);
      const keys = get.mock.calls.flatMap(keysOf);
      expect(keys).toContain('snapshots/app.example.com');
      expect(keys).not.toContain('snapshots/other.com');
    });

    it('row size shows the recorded bytes', async () => {
      await setSnapshots({ 'example.com': { sized: snap('2024-01-01T00:00:00.000Z', { bytes: 12345 }) } });
      await loadPopup('https://example.com/');

      expect(row('sized').querySelector('.snapshot__preview').textContent).toBe(formatBytes(12345));
    });

    it('row size equals byteSize of the stored snapshot for a group-scoped entry', async () => {
      chrome._state.grantedOrigins.add('*://app.example.com/*');
      const cookie = (name, domain) => ({ name, value: '1', domain, path: '/' });
      const grouped = snap('2024-01-01T00:00:00.000Z', {
        cookieDomain: 'example.com',
        cookies: [cookie('own', 'app.example.com'), cookie('sibling', 'www.example.com')],
      });
      await setSnapshots({ 'app.example.com': { grouped } });
      await loadPopup('https://app.example.com/');

      expect(row('grouped').querySelector('.snapshot__preview').textContent).toBe(`Cookie 1 · ${formatBytes(byteSize(grouped))}`);
    });

    it('an open with no active snapshot sends no getStorageData', async () => {
      await setSnapshots({ 'example.com': { mine: snap('2024-01-01T00:00:00.000Z') } });
      await loadPopup('https://example.com/');

      expect(rowNames()).toEqual(['mine']);
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'getStorageData' }));
    });

    it('hides the undo bar without reading the backup when automatic backup is off', async () => {
      await setBackups({ 'example.com': { savedAt: '2024-01-04T00:00:00.000Z', activeName: null } });
      await setSettings({ ...await getSettings(), autoBackup: false });
      const get = vi.spyOn(chrome.storage.local, 'get');
      await loadPopup('https://example.com/');

      expect($('undoBar').classList.contains('hidden')).toBe(true);
      expect(get.mock.calls.flatMap(keysOf)).not.toContain('backups/example.com');
    });
  });

  describe('storage from an older version', () => {
    it('legacy data shows on the first open', async () => {
      await chrome.storage.local.set({
        snapshots: { 'example.com': {
          first:  snap('2024-01-01T00:00:00.000Z', { localStorage: { a: '1' } }),
          second: snap('2024-01-02T00:00:00.000Z'),
        }, 'other.com': { third: snap('2024-01-03T00:00:00.000Z') } },
        backups: { 'example.com': { savedAt: '2024-01-04T00:00:00.000Z', activeName: null, localStorage: { b: '2' } } },
        snapshotOrder: { 'example.com': ['second', 'first'] },
      });

      await loadPopup('https://example.com/');

      expect(rowNames()).toEqual(['second', 'first']);
      expect($('undoBar').classList.contains('hidden')).toBe(false);
      expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
      expect(Object.keys(await getSnapshots()).sort()).toEqual(['example.com', 'other.com']);
    });

    it('a failed migration still shows the list', async () => {
      await chrome.storage.local.set({ snapshots: { 'other.com': { third: snap('2024-01-03T00:00:00.000Z') } } });
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z') } });
      await chrome.storage.local.remove('schemaVersion');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const remove = vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('I/O error'));

      await loadPopup('https://example.com/');

      expect(logged).toHaveBeenCalled();
      expect(rowNames()).toEqual(['first']);
      expect(await chrome.storage.local.get('snapshots')).toHaveProperty('snapshots');
      remove.mockRestore();
      logged.mockRestore();
    });

    it('the next open retries the migration and keeps the per-host data', async () => {
      await chrome.storage.local.set({ snapshots: { 'other.com': { third: snap('2024-01-03T00:00:00.000Z') } } });
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z') } });
      await chrome.storage.local.remove('schemaVersion');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const remove = vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('I/O error'));
      await loadPopup('https://example.com/');
      remove.mockRestore();
      logged.mockRestore();
      const before = structuredClone(await getSnapshots());

      await loadPopup('https://example.com/');

      expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
      expect(await getSnapshots()).toEqual(before);
      expect(Object.keys(before).sort()).toEqual(['example.com', 'other.com']);
      expect(rowNames()).toEqual(['first']);
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
      expect(row('renamed').classList.contains('is-active')).toBe(true);
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
