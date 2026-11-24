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
  // chrome.tabs.get reads the active tab from here when it is loaded again.
  chrome._state.tabs = tabUrl == null ? [] : [{ id: 1, url: tabUrl }];
  chrome.tabs.query = vi.fn().mockResolvedValue(structuredClone(chrome._state.tabs));
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

  it.each(['ja', 'en-US'])('the empty state names the save button that follows it (%s)', async language => {
    chrome._state.uiLanguage = language;
    await loadPopup('https://example.com/');

    const body = document.querySelector('#emptyState .empty-state__body').textContent;
    const label = $('saveBtn').querySelector('[data-i18n="btn_save_current"]').textContent;
    expect(label).not.toBe('');
    expect(body).toContain(label);
    expect($('emptyState').compareDocumentPosition($('saveBtn')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the popup.html fallback equals the ja empty_body', async () => {
    const { MESSAGES } = await import('../../lib/i18n.js');
    const fallback = popupHtml.match(/class="empty-state__body"[^>]*>([^<]*)</)[1];
    expect(fallback).toBe(MESSAGES.ja.empty_body);
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

    it('loads the tab again by navigating to its current URL, so a form POST is not sent again', async () => {
      await loadPopup('https://example.com/');
      chrome._state.tabs[0].url = 'https://example.com/post/submit';
      const reload = vi.spyOn(chrome.tabs, 'reload');

      row('first').querySelector('.snapshot__main').click();
      await settle();

      expect(chrome._state.navigatedTabs).toEqual([{ tabId: 1, url: 'https://example.com/post/submit' }]);
      expect(reload).not.toHaveBeenCalled();
    });

    it('reloads the tab when its URL has a fragment, since navigating there would only scroll', async () => {
      await loadPopup('https://example.com/#top');

      row('first').querySelector('.snapshot__main').click();
      await settle();

      expect(chrome._state.navigatedTabs).toEqual([]);
      expect(chrome._state.reloadedTabs).toEqual([1]);
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
    const storedReloadIds = async () => (await storedCheck()).reloadTabs.map(entry => entry.id);

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
        expect((await storedCheck()).reloadTabs).toEqual([
          { id: 2, origin: 'https://example.com' },
          { id: 3, origin: 'https://sub.example.com' },
          { id: 5, origin: 'http://example.com:8080' },
          { id: 6, origin: 'https://example.com' },
        ]);
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

      it('still reloads the other tabs and reports the load done when the active tab was closed meanwhile', async () => {
        await setReloadOtherTabs({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const get = chrome.tabs.get;
        vi.spyOn(chrome.tabs, 'get').mockImplementation(async id => {
          if (id === 1) throw new Error('No tab with id: 1.');
          return get(id);
        });
        await clickLoad('first');

        expect(chrome._state.reloadedTabs).toEqual([2, 6]);
        expect(error).toHaveBeenCalled();
        expect($('statusMsg').className).toContain('success');
        expect($('statusMsg').textContent).toBe(LOADED + suffix(2));
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

      // No cookie was cleared, so the subdomain's tab sees an unchanged jar.
      it('with cookies on but the host permission denied, keeps the cookies and reloads only the same-origin tabs', async () => {
        await setReloadOtherTabs();
        await loadPopupWithTabs(APP, APP_OTHERS);
        vi.spyOn(chrome.permissions, 'contains').mockResolvedValue(false);
        vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);
        await clearSite();

        expect(chrome._state.cookies).toEqual([sid('a', 'app.example.com')]);
        expect(chrome._state.reloadedTabs).toEqual([1, 2]);
        expect($('statusMsg').textContent).toBe(CLEARED + suffix(1));
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

        expect(await storedReloadIds()).toEqual([3, 4]);
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

        expect(await storedReloadIds()).toEqual([2, 3, 5, 6]);
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

        expect(await storedReloadIds()).toEqual([2, 3, 5]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
      });

      const UNDONE = '直前の状態に戻しました';
      const backupWith = data => setBackups({ 'example.com': { savedAt: '2024-01-01T00:00:00.000Z', activeName: null, ...data } });

      it('with only sessionStorage restored, reloads no other tab', async () => {
        await backupWith({ sessionStorage: { s: '0' } });
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS);
        $('undoBtn').click();
        await settle();

        expect(pageData.sessionStorage).toEqual({ s: '0' });
        expect(await storedCheck()).toBeUndefined();
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').textContent).toBe(UNDONE);
      });

      it('with the setting off, hands over and reloads no other tab', async () => {
        await backupWith({ cookies: [sid('previous')], localStorage: { a: '0' } });
        await setReloadOtherTabs({ reloadOtherTabs: false });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        $('undoBtn').click();
        await settle();

        expect(await storedReloadIds()).toEqual([]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').textContent).toBe(UNDONE);
      });

      it('with automatic reload off, reloads no tab at all', async () => {
        await backupWith({ cookies: [sid('previous')], localStorage: { a: '0' } });
        await setReloadOtherTabs({ autoReload: false });
        await loadPopupWithTabs(ACTIVE, OTHERS);
        $('undoBtn').click();
        await settle();

        expect(await storedReloadIds()).toEqual([]);
        expect(chrome._state.reloadedTabs).toEqual([]);
        expect($('statusMsg').textContent).toBe(UNDONE);
      });

      it('still restores and reloads the active tab when listing the tabs fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await backupWith({ cookies: [sid('previous')], localStorage: { a: '0' } });
        await setReloadOtherTabs();
        await loadPopupWithTabs(ACTIVE, OTHERS, async () => {
          throw new Error('query failed');
        });
        $('undoBtn').click();
        await settle();

        expect(pageData.localStorage).toEqual({ a: '0' });
        expect(await storedReloadIds()).toEqual([]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
        expect($('statusMsg').className).toContain('success');
        expect($('statusMsg').textContent).toBe(UNDONE);
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

    it('row menu "中身を見る" opens the viewer with host, name and tab id', async () => {
      await setSnapshots({
        'www.example.com': { mine: snap('2024-01-01T00:00:00.000Z') },
        'app.example.com': { theirs: snap('2024-01-01T00:00:00.000Z') },
      });
      await loadPopup('https://www.example.com/');

      const view = row('mine').querySelector('.actions-menu [data-action="view"]');
      expect(view.textContent).toBe('中身を見る');
      expect(view.nextElementSibling.tagName).toBe('HR');
      view.click();
      row('theirs').querySelector('.actions-menu [data-action="view"]').click();
      await settle();

      const opened = chrome._state.createdTabs.map(({ url }) => {
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/viewer/viewer.html');
        return Object.fromEntries(parsed.searchParams);
      });
      expect(opened).toEqual([
        { host: 'www.example.com', name: 'mine', tab: '1' },
        { host: 'app.example.com', name: 'theirs', tab: '1' },
      ]);
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

  describe('overwriting from the changed menu', () => {
    beforeEach(async () => {
      await setSnapshots({ 'example.com': { first: snap('2024-01-01T00:00:00.000Z', { localStorage: { old: '1' } }) } });
      await setActiveSnapshots({ 'example.com': 'first' });
    });

    it('overwrites the active snapshot from the changed menu and clears the badge', async () => {
      await loadPopup('https://example.com/');
      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(false);

      row('first').querySelector('.changes-menu [data-action="overwrite"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await getSnapshots())['example.com'].first.localStorage).toEqual({ current: '1' });
      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
      await loadPopup('https://example.com/');
      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(true);
    });

    it('keeps the snapshot when the overwrite from the changed menu is cancelled', async () => {
      await loadPopup('https://example.com/');

      row('first').querySelector('.changes-menu [data-action="overwrite"]').click();
      await settle();
      document.querySelector('.tk3-btn-cancel').click();
      await settle();

      expect((await getSnapshots())['example.com'].first.localStorage).toEqual({ old: '1' });
      expect(row('first').querySelector('.badge--modified').classList.contains('hidden')).toBe(false);
    });
  });

  describe('loading only some types', () => {
    const sid = (value, domain = 'example.com') => ({ name: 'sid', value, domain, path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    const isHidden = el => el.classList.contains('hidden');
    const SAVED_AT = '2024-01-01T00:00:00.000Z';
    const full = (value, more = {}) => snap(SAVED_AT, {
      cookies: [sid(value)], localStorage: { ls: value }, sessionStorage: { ss: value }, ...more,
    });
    const ALL_ON = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };
    const partial = (name, types, host = 'example.com') => ({ host, name, types });
    const active = async (key = 'example.com') => (await getActiveSnapshots())[key];
    const activeBadge = name => row(name).querySelector('.badge--active');
    const modifiedBadge = name => row(name).querySelector('.badge--modified');
    const storageWrites = () => chrome.tabs.sendMessage.mock.calls.filter(([, message]) => message.type === 'setStorageData');
    const pending = () => ({ cookieChecks: { 1: { domain: 'example.com', cookies: [sid('a')], origins: ['*://example.com/*'], cookieDomain: 'example.com', until: Date.now() + 60_000 } } });

    async function enable(types) {
      await setSettings({ ...(await getSettings()), enabledTypes: { ...ALL_ON, ...types } });
    }

    async function openPicker(name) {
      row(name).querySelector('.actions-menu [data-action="load-partial"]').click();
      await settle();
      return document.querySelector('dialog');
    }

    const boxes = dialog => [...dialog.querySelectorAll('.type-picker input[type="checkbox"]')];

    async function confirmDialog() {
      document.querySelector('dialog .tk3-btn-confirm').click();
      await settle();
    }

    async function loadPartly(name, types) {
      const dialog = await openPicker(name);
      for (const box of boxes(dialog)) box.checked = types.includes(box.value);
      await confirmDialog();
    }

    async function loadPopupWithTabs(active, others) {
      document.body.innerHTML = bodyHtml;
      chrome._state.tabs = [active, ...others];
      chrome.tabs.query = vi.fn(async (info = {}) => (info.active ? [active] : [active, ...others]));
      vi.resetModules();
      await import('../../popup/popup.js');
      await settle();
    }

    const tab = (id, url) => ({ id, url, status: 'complete' });

    beforeEach(async () => {
      pageData = { localStorage: { ls: 'page' }, sessionStorage: { ss: 'page' } };
      chrome._state.cookies = [sid('page')];
      await setSnapshots({ 'example.com': { first: full('a'), second: full('b') } });
    });

    describe('overwrite with a partial record', () => {
      const STORED = () => full('a', { indexedDB: { app: { stored: true } }, indexedDBDigest: 'stored-digest' });

      beforeEach(async () => {
        pageData = { ...pageData, indexedDB: { app: { page: true } } };
        await setSnapshots({ 'example.com': { first: STORED(), second: full('b') } });
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
      });

      const withoutTimes = ({ savedAt, bytes, ...rest }) => rest;

      it('overwriting a partly active snapshot from the changed menu replaces only the recorded types', async () => {
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);

        row('first').querySelector('.changes-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].first;
        expect(stored.cookies.map(c => c.value)).toEqual(['page']);
        expect(stored.localStorage).toEqual({ ls: 'a' });
        expect(stored.sessionStorage).toEqual({ ss: 'a' });
        expect(stored.indexedDB).toEqual({ app: { stored: true } });
        expect(stored.indexedDBDigest).toBe('stored-digest');
        expect(await active()).toEqual(partial('first', ['cookies']));

        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(true);
        expect(activeBadge('first').textContent).toBe('一部適用中');
      });

      it('the row-menu overwrite and the save form with the same name do the same', async () => {
        await loadPopup('https://example.com/');
        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();
        const fromMenu = withoutTimes((await getSnapshots())['example.com'].first);
        const menuRecord = await active();

        await setSnapshots({ 'example.com': { first: STORED(), second: full('b') } });
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');
        $('saveBtn').click();
        $('newSnapshotName').value = 'first';
        $('confirmSaveBtn').click();
        await settle();
        await confirmDialog();

        expect(withoutTimes((await getSnapshots())['example.com'].first)).toEqual(fromMenu);
        expect(await active()).toEqual(menuRecord);
        expect(menuRecord).toEqual(partial('first', ['cookies']));
      });

      it('the overwrite confirmation names the types that will be replaced', async () => {
        await loadPopup('https://example.com/');
        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();

        const message = document.querySelector('.tk3-dialog-msg').textContent;
        expect(message).toContain('Cookie');
        for (const other of ['localStorage', 'sessionStorage', 'IndexedDB']) expect(message).not.toContain(other);
        document.querySelector('.tk3-btn-cancel').click();
        await settle();
        expect((await getSnapshots())['example.com'].first.cookies.map(c => c.value)).toEqual(['a']);
      });

      it('a partial overwrite in a group stores the collected cookieDomain', async () => {
        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        chrome._state.cookies = [sid('page', '.example.com')];
        await setSnapshots({ 'www.example.com': { mine: full('a') } });
        await setActiveSnapshots({ 'example.com': partial('mine', ['cookies'], 'www.example.com') });
        await loadPopup('https://www.example.com/');

        row('mine').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        const stored = (await getSnapshots())['www.example.com'].mine;
        expect(stored.cookieDomain).toBe('example.com');
        expect(stored.cookies.map(c => c.value)).toEqual(['page']);
        expect(stored.localStorage).toEqual({ ls: 'a' });
        expect(await active()).toEqual(partial('mine', ['cookies'], 'www.example.com'));
      });

      it('a partial overwrite without cookies keeps the stored cookies and cookieDomain', async () => {
        await setSnapshots({ 'example.com': { first: { ...STORED(), cookieDomain: 'example.com' } } });
        await setActiveSnapshots({ 'example.com': partial('first', ['localStorage']) });
        await loadPopup('https://example.com/');

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].first;
        expect(stored.cookies.map(c => c.value)).toEqual(['a']);
        expect(stored.cookieDomain).toBe('example.com');
        expect(stored.localStorage).toEqual({ ls: 'page' });
        expect(stored.sessionStorage).toEqual({ ss: 'a' });
        expect(stored.indexedDBDigest).toBe('stored-digest');
        expect(await active()).toEqual(partial('first', ['localStorage']));
      });

      it('refuses the overwrite when no recorded type is enabled', async () => {
        await enable({ cookies: false });
        await loadPopup('https://example.com/');

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();

        expect(document.querySelector('dialog')).toBeNull();
        expect($('statusMsg').className).toContain('error');
        expect($('statusMsg').textContent).toBe('読み込んだ種類がどれも設定でオフになっているため、上書きできません');
        expect(withoutTimes((await getSnapshots())['example.com'].first)).toEqual(withoutTimes(STORED()));
      });

      it('replaces only the enabled recorded types, names only those, and keeps the disabled one in the record', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies', 'localStorage']) });
        await enable({ cookies: false });
        await loadPopup('https://example.com/');

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        const message = document.querySelector('.tk3-dialog-msg').textContent;
        expect(message).toContain('localStorage');
        expect(message).not.toContain('Cookie');
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].first;
        expect(stored.cookies.map(c => c.value)).toEqual(['a']);
        expect(stored.localStorage).toEqual({ ls: 'page' });
        expect(stored.sessionStorage).toEqual({ ss: 'a' });
        expect(await active()).toEqual(partial('first', ['cookies', 'localStorage']));
      });

      it('saves nothing and keeps the changes when no recorded type can be read', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
        vi.spyOn(chrome.permissions, 'contains').mockResolvedValue(false);
        vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        expect($('statusMsg').className).toContain('error');
        expect($('statusMsg').textContent).toBe('保存に失敗しました');
        expect(withoutTimes((await getSnapshots())['example.com'].first)).toEqual(withoutTimes(STORED()));
        expect(await active()).toEqual(partial('first', ['cookies']));
        expect(isHidden(modifiedBadge('first'))).toBe(false);
      });

      it('saves nothing when a storage-only record cannot reach the page', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await setActiveSnapshots({ 'example.com': partial('first', ['localStorage']) });
        await loadPopup('https://example.com/');
        chrome.tabs.sendMessage = vi.fn(async () => {
          throw new Error('Receiving end does not exist.');
        });

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        expect($('statusMsg').className).toContain('error');
        expect(withoutTimes((await getSnapshots())['example.com'].first)).toEqual(withoutTimes(STORED()));
        expect(await active()).toEqual(partial('first', ['localStorage']));
      });

      it('keeps a recorded type the page does not have, and drops a cookieDomain the collected cookies lack', async () => {
        await setSnapshots({ 'example.com': { first: { ...STORED(), cookieDomain: 'example.com' } } });
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies', 'sessionStorage', 'indexedDB']) });
        pageData = { localStorage: { ls: 'page' } };
        await loadPopup('https://example.com/');

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].first;
        expect(stored.cookies.map(c => c.value)).toEqual(['page']);
        expect('cookieDomain' in stored).toBe(false);
        expect(stored.sessionStorage).toEqual({ ss: 'a' });
        expect(stored.indexedDB).toEqual({ app: { stored: true } });
        expect(stored.indexedDBDigest).toBe('stored-digest');
        expect(stored.localStorage).toEqual({ ls: 'a' });
        expect(await active()).toEqual(partial('first', ['cookies', 'sessionStorage', 'indexedDB']));
      });

      it('replaces the indexedDB digest together with the indexedDB it collects', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['indexedDB']) });
        await loadPopup('https://example.com/');

        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].first;
        expect(stored.indexedDB).toEqual({ app: { page: true } });
        expect(stored.indexedDBDigest).toBe(globalThis.storageDigest.digest({ app: { page: true } }));
        expect(stored.cookies.map(c => c.value)).toEqual(['a']);
      });

      it('saves nothing when the snapshot was deleted after the confirmation', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await loadPopup('https://example.com/');
        row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        await setSnapshots({ 'example.com': { second: full('b') } });
        await confirmDialog();

        expect($('statusMsg').className).toContain('error');
        expect('first' in (await getSnapshots())['example.com']).toBe(false);
      });

      it('keeps the change of a recorded type the page could not give, and says what was saved', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies', 'sessionStorage']) });
        await loadPopup('https://example.com/');
        expect(modifiedBadge('first').title).toContain('sessionStorage');
        pageData = { localStorage: { ls: 'page' } };

        row('first').querySelector('.changes-menu [data-action="overwrite"]').click();
        await settle();
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].first;
        expect(stored.cookies.map(c => c.value)).toEqual(['page']);
        expect(stored.sessionStorage).toEqual({ ss: 'a' });
        expect($('statusMsg').textContent).toBe('"first" の Cookie を保存しました（読み込んだほかの種類はページから読み取れなかったので、保存したままです）');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
        expect(modifiedBadge('first').title).toContain('sessionStorage');
        expect(modifiedBadge('first').title).not.toContain('Cookie');
        expect(await active()).toEqual(partial('first', ['cookies', 'sessionStorage']));
      });

      it('overwriting another row while a partial record is active saves every type', async () => {
        await loadPopup('https://example.com/');

        row('second').querySelector('.actions-menu [data-action="overwrite"]').click();
        await settle();
        expect(document.querySelector('.tk3-dialog-msg').textContent).toBe('"second" を現在の状態で上書きしますか？');
        await confirmDialog();

        const stored = (await getSnapshots())['example.com'].second;
        expect(stored.cookies.map(c => c.value)).toEqual(['page']);
        expect(stored.localStorage).toEqual({ ls: 'page' });
        expect(stored.sessionStorage).toEqual({ ss: 'page' });
        expect(stored.indexedDB).toEqual({ app: { page: true } });
        expect(await active()).toBe('second');
      });
    });

    describe('menu and picker', () => {
      it('offers the partial load only when the snapshot has two or more loadable types', async () => {
        await setSnapshots({ 'example.com': { first: full('a'), lsOnly: snap(SAVED_AT, { localStorage: { ls: 'x' } }) } });
        await loadPopup('https://example.com/');
        expect(row('first').querySelector('[data-action="load-partial"]').textContent).toBe('一部だけ読み込む…');
        expect(row('lsOnly').querySelector('[data-action="load-partial"]')).toBeNull();

        await enable({ cookies: false, sessionStorage: false });
        await loadPopup('https://example.com/');
        expect(row('first').querySelector('[data-action="load-partial"]')).toBeNull();

        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        await enable({});
        await setSnapshots({ 'example.com': { first: full('a') }, 'app.example.com': { theirs: full('t') } });
        await loadPopup('https://example.com/');
        expect(row('first').querySelector('[data-action="load-partial"]')).not.toBeNull();
        expect(row('theirs').querySelector('[data-action="load-partial"]')).toBeNull();
      });

      it('loadPartial called on a foreign row or a one-type snapshot opens no dialog and writes nothing', async () => {
        await setSnapshots({ 'example.com': { first: full('a'), lsOnly: snap(SAVED_AT, { localStorage: { ls: 'x' } }) } });
        await setActiveSnapshots({ 'example.com': 'first' });
        await loadPopup('https://example.com/');
        const { handleLoadPartial } = await import('../../popup/actions.js');

        await handleLoadPartial({ host: 'www.example.com', name: 'first' });
        await handleLoadPartial({ host: 'example.com', name: 'lsOnly' });
        await settle();

        expect(document.querySelector('dialog')).toBeNull();
        expect(await getBackups()).toEqual({});
        expect(await active()).toBe('first');
        expect(storageWrites()).toEqual([]);
      });

      it('lists only the enabled types the snapshot has in the picker, with Cookie checked', async () => {
        await enable({ sessionStorage: false });
        await loadPopup('https://example.com/');

        const dialog = await openPicker('first');
        expect(dialog.querySelector('.tk3-dialog-title').textContent).toBe('"first" から読み込むもの');
        expect(boxes(dialog).map(box => box.value)).toEqual(['cookies', 'localStorage']);
        expect(boxes(dialog).map(box => box.checked)).toEqual([true, false]);
        expect([...dialog.querySelectorAll('.type-picker label')].map(label => label.textContent)).toEqual(['Cookie', 'localStorage']);
        expect(dialog.querySelector('.tk3-btn-confirm').textContent).toBe('読み込む');
      });

      it('picker has no box checked when Cookie is disabled or absent from the snapshot', async () => {
        await setSnapshots({ 'example.com': { noCookies: snap(SAVED_AT, { localStorage: { ls: 'x' }, sessionStorage: { ss: 'x' } }), first: full('a') } });
        await loadPopup('https://example.com/');
        let dialog = await openPicker('noCookies');
        expect(boxes(dialog).map(box => box.value)).toEqual(['localStorage', 'sessionStorage']);
        expect(boxes(dialog).some(box => box.checked)).toBe(false);
        await confirmDialog();
        expect(document.querySelector('dialog')).not.toBeNull();
        expect(document.querySelector('.tk3-dialog-error').hidden).toBe(false);
        document.querySelector('dialog .tk3-btn-cancel').click();
        await settle();

        await enable({ cookies: false });
        await loadPopup('https://example.com/');
        dialog = await openPicker('first');
        expect(boxes(dialog).map(box => box.value)).toEqual(['localStorage', 'sessionStorage']);
        expect(boxes(dialog).some(box => box.checked)).toBe(false);
        await confirmDialog();
        expect(document.querySelector('.tk3-dialog-error').hidden).toBe(false);
        expect(storageWrites()).toEqual([]);
      });

      it('asks for at least one type', async () => {
        await loadPopup('https://example.com/');
        const dialog = await openPicker('first');
        boxes(dialog)[0].checked = false;
        await confirmDialog();

        expect(document.querySelector('dialog')).toBe(dialog);
        expect(dialog.querySelector('.tk3-dialog-error').textContent).toBe('読み込む種類を1つ以上選んでください');
        expect(dialog.querySelector('.tk3-dialog-error').hidden).toBe(false);
      });

      it('warns in the picker that the load cannot be undone when the automatic backup is off', async () => {
        await setSettings({ ...(await getSettings()), autoBackup: false });
        await loadPopup('https://example.com/');

        const dialog = await openPicker('first');
        expect(dialog.querySelector('.type-picker__note').textContent).toBe('選んだ種類の今のデータは上書きされ、元に戻せません。');
        for (const box of boxes(dialog)) box.checked = box.value === 'localStorage';
        await confirmDialog();

        expect(document.querySelector('dialog')).toBeNull();
        expect(pageData.localStorage).toEqual({ ls: 'a' });
        expect($('statusMsg').textContent).toBe('"first" の localStorage を適用しました');
      });

      it('shows no warning in the picker when the automatic backup is on', async () => {
        await loadPopup('https://example.com/');
        const dialog = await openPicker('first');
        expect(dialog.querySelector('.type-picker__note')).toBeNull();
      });

      it('says the previous state could not be kept when the backup fails', async () => {
        await loadPopup('https://example.com/');
        const set = chrome.storage.local.set;
        chrome.storage.local.set = async items => {
          if ('backups/example.com' in items) throw new Error('QUOTA_BYTES quota exceeded');
          return set(items);
        };

        await loadPartly('first', ['cookies']);

        expect($('statusMsg').className).toContain('success');
        expect($('statusMsg').textContent).toBe('"first" の Cookie を適用しました（保存容量が足りず、切り替え前の状態は残せませんでした）');
      });

      it('cancelling the picker changes nothing', async () => {
        await setActiveSnapshots({ 'example.com': 'second' });
        await loadPopup('https://example.com/');
        await openPicker('first');
        document.querySelector('dialog .tk3-btn-cancel').click();
        await settle();

        expect(document.querySelector('dialog')).toBeNull();
        expect(await getBackups()).toEqual({});
        expect(chrome._state.cookies).toEqual([sid('page')]);
        expect(storageWrites()).toEqual([]);
        expect(await active()).toBe('second');
        expect(document.activeElement).toBe(row('first').querySelector('.snapshot__main'));
      });

      it('checking every type in the picker writes a record without types', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['cookies', 'localStorage', 'sessionStorage']);
        expect(await active()).toBe('first');
        expect(activeBadge('first').textContent).toBe('適用中');
        expect($('statusMsg').textContent).toBe('"first" を適用しました');

        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        await setSnapshots({ 'www.example.com': { mine: full('m') } });
        await loadPopup('https://www.example.com/');
        await loadPartly('mine', ['cookies', 'localStorage', 'sessionStorage']);
        expect(await active()).toEqual({ host: 'www.example.com', name: 'mine' });
      });
    });

    describe('what a partial load writes', () => {
      it('a localStorage-only load writes only localStorage', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage']);

        expect(storageWrites().map(([, message]) => message.data)).toEqual([{ localStorage: { ls: 'a' } }]);
        expect(pageData.sessionStorage).toEqual({ ss: 'page' });
        expect(chrome._state.cookies).toEqual([sid('page')]);
        expect($('statusMsg').textContent).toBe('"first" の localStorage を適用しました');
      });

      it('a localStorage-only load starts no cookie check', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage']);

        expect((await chrome.storage.local.get('cookieChecks')).cookieChecks ?? {}).toEqual({});
      });

      it('a localStorage-only load reloads a same-origin tab and none that shares only the cookie domain', async () => {
        await setSettings({ ...(await getSettings()), reloadOtherTabs: true });
        await loadPopupWithTabs(tab(1, 'https://example.com/'), [tab(2, 'https://example.com/other'), tab(3, 'http://example.com:8080/')]);
        await loadPartly('first', ['localStorage']);

        expect(chrome._state.reloadedTabs).toEqual([1, 2]);
      });

      it('a sessionStorage-only load reloads no other tab', async () => {
        await setSettings({ ...(await getSettings()), reloadOtherTabs: true });
        await loadPopupWithTabs(tab(1, 'https://example.com/'), [tab(2, 'https://example.com/other'), tab(3, 'http://example.com:8080/')]);
        await loadPartly('first', ['sessionStorage']);

        expect(pageData.sessionStorage).toEqual({ ss: 'a' });
        expect(chrome._state.reloadedTabs).toEqual([1]);
      });

      it('a cookies-only load sends no setStorageData', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['cookies']);

        expect(chrome._state.cookies.map(c => c.value)).toEqual(['a']);
        expect(storageWrites()).toEqual([]);
        expect(pageData.localStorage).toEqual({ ls: 'page' });
        expect($('statusMsg').textContent).toBe('"first" の Cookie を適用しました');
      });

      it('a cookies-only load starts a cookie check for the snapshot\'s cookies and reloads tabs sharing the cookie domain', async () => {
        await setSettings({ ...(await getSettings()), reloadOtherTabs: true });
        await loadPopupWithTabs(tab(1, 'https://example.com/'), [tab(3, 'http://example.com:8080/'), tab(4, 'https://other.com/')]);
        await loadPartly('first', ['cookies']);

        const check = (await chrome.storage.local.get('cookieChecks')).cookieChecks[1];
        expect(check.cookies).toEqual([sid('a')]);
        expect(check.reloadTabs.map(entry => entry.id)).toEqual([3]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
      });

      it('a cookies-only load reloads no tab that shares only the origin\'s storage', async () => {
        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        await setSnapshots({ 'app.example.com': { narrow: snap(SAVED_AT, {
          cookieDomain: 'auth.example.com', cookies: [sid('n', 'auth.example.com')], localStorage: { ls: 'n' },
        }) } });
        await setSettings({ ...(await getSettings()), reloadOtherTabs: true });
        await loadPopupWithTabs(tab(1, 'https://app.example.com/'), [tab(2, 'https://app.example.com/x'), tab(3, 'https://auth.example.com/')]);
        await loadPartly('narrow', ['cookies']);

        const check = (await chrome.storage.local.get('cookieChecks')).cookieChecks[1];
        expect(check.reloadTabs.map(entry => entry.id)).toEqual([3]);
        expect(chrome._state.reloadedTabs).toEqual([1]);
      });

      it('a cookies-only load on an unreachable page succeeds and sends no ping', async () => {
        chrome.tabs.sendMessage = vi.fn(async () => {
          throw new Error('Receiving end does not exist.');
        });
        await loadPopup('https://example.com/');
        await loadPartly('first', ['cookies']);

        expect($('statusMsg').className).toContain('success');
        expect(await active()).toEqual(partial('first', ['cookies']));
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, { type: 'ping' });
      });

      it('a partial load backs up every enabled type', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage']);

        const backup = (await getBackups())['example.com'];
        expect(backup.cookies.map(c => c.value)).toEqual(['page']);
        expect(backup.localStorage).toEqual({ ls: 'page' });
        expect(backup.sessionStorage).toEqual({ ss: 'page' });
      });

      it('a storage-only partial load on an unreachable page fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const earlier = { savedAt: SAVED_AT, activeName: null, localStorage: { earlier: '1' } };
        await setBackups({ 'example.com': earlier });
        await setActiveSnapshots({ 'example.com': 'second' });
        chrome.tabs.sendMessage = vi.fn(async () => {
          throw new Error('Receiving end does not exist.');
        });
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage']);

        expect($('statusMsg').className).toContain('error');
        expect((await getBackups())['example.com']).toEqual(earlier);
        expect(await active()).toBe('second');
      });

      it('every loadable type chosen without Cookie loads like a full load on an unreachable page', async () => {
        await enable({ cookies: false });
        chrome.tabs.sendMessage = vi.fn(async () => {
          throw new Error('Receiving end does not exist.');
        });
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage', 'sessionStorage']);

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, { type: 'ping' });
        expect($('statusMsg').className).toContain('success');
        expect($('statusMsg').textContent).toBe('"first" を適用しました');
        expect(await active()).toBe('first');
      });

      it('fails and keeps the record when the page answers but does not confirm the write', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await setActiveSnapshots({ 'example.com': 'second' });
        for (const reply of [{}, undefined, { success: false }]) {
          chrome.tabs.sendMessage = vi.fn(async (_tabId, message) => {
            if (message.type === 'ping') return { ok: true };
            if (message.type === 'getStorageData') return structuredClone(pageData);
            return reply;
          });
          await loadPopup('https://example.com/');
          await loadPartly('first', ['localStorage']);

          expect(storageWrites()).toHaveLength(1);
          expect($('statusMsg').className).toContain('error');
          expect($('statusMsg').textContent).toBe('読み込みに失敗しました');
          expect(await active()).toBe('second');
        }
      });

      it('cookies and storage chosen on an unreachable page records only cookies', async () => {
        chrome.tabs.sendMessage = vi.fn(async () => {
          throw new Error('Receiving end does not exist.');
        });
        await loadPopup('https://example.com/');
        await loadPartly('first', ['cookies', 'localStorage']);

        expect(await active()).toEqual(partial('first', ['cookies']));
        expect($('statusMsg').textContent).toBe('"first" の Cookie を適用しました');
      });

      it('a cookies-only load without the host permission fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await setActiveSnapshots({ 'example.com': 'second' });
        await loadPopup('https://example.com/');
        vi.spyOn(chrome.permissions, 'contains').mockResolvedValue(false);
        vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);
        await loadPartly('first', ['cookies']);

        expect($('statusMsg').className).toContain('error');
        expect(chrome._state.cookies).toEqual([sid('page')]);
        expect(await active()).toBe('second');
      });

      it('ignores a chosen type the snapshot does not hold', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await setSnapshots({ 'example.com': { first: snap(SAVED_AT, { cookies: [sid('a')], localStorage: { ls: 'a' } }) } });
        await loadPopup('https://example.com/');
        const { loadEntry } = await import('../../popup/actions.js');

        await loadEntry({ host: 'example.com', name: 'first' }, ['localStorage', 'sessionStorage']);
        expect(storageWrites().map(([, message]) => message.data)).toEqual([{ localStorage: { ls: 'a' } }]);
        expect(await active()).toEqual(partial('first', ['localStorage']));

        await loadEntry({ host: 'example.com', name: 'first' }, ['sessionStorage', 'bogus']);
        expect($('statusMsg').className).toContain('error');
        expect(storageWrites()).toHaveLength(1);
        expect(await active()).toEqual(partial('first', ['localStorage']));
      });
    });

    describe('the active record', () => {
      it('records the applied types and shows the partial badge', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage']);

        expect(await active()).toEqual(partial('first', ['localStorage']));
        expect(activeBadge('first').textContent).toBe('一部適用中');
        expect(activeBadge('first').title).toContain('localStorage');
        expect(isHidden(activeBadge('second'))).toBe(true);
      });

      it('partial load on a fully active row with a changed localStorage records only the loaded types', async () => {
        await setActiveSnapshots({ 'example.com': 'first' });
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);

        await loadPartly('first', ['cookies']);
        expect(await active()).toEqual(partial('first', ['cookies']));

        await chrome.storage.local.set({ cookieChecks: {} });
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(true);

        await setActiveSnapshots({ 'example.com': 'first' });
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
      });

      it('partial load of a different snapshot replaces the record, no union', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');
        await loadPartly('second', ['localStorage']);

        expect(await active()).toEqual(partial('second', ['localStorage']));
      });

      it('adds to the applied types when more of a partly active snapshot is loaded', async () => {
        await loadPopup('https://example.com/');
        await loadPartly('first', ['cookies']);
        expect(await active()).toEqual(partial('first', ['cookies']));

        await loadPartly('first', ['localStorage']);
        expect(await active()).toEqual(partial('first', ['cookies', 'localStorage']));

        await loadPartly('first', ['sessionStorage']);
        expect(await active()).toBe('first');
      });

      it('keeps the changes of a recorded type that a further partial load leaves alone', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['localStorage', 'sessionStorage']) });
        pageData.localStorage = { ls: 'x' };
        pageData.sessionStorage = { ss: 'x' };
        await loadPopup('https://example.com/');
        expect(modifiedBadge('first').title).toContain('localStorage');
        expect(modifiedBadge('first').title).toContain('sessionStorage');

        await loadPartly('first', ['sessionStorage']);

        expect(await active()).toEqual(partial('first', ['localStorage', 'sessionStorage']));
        expect(isHidden(modifiedBadge('first'))).toBe(false);
        expect(modifiedBadge('first').title).toContain('localStorage');
        expect(modifiedBadge('first').title).not.toContain('sessionStorage');
      });

      it('drops the changes of another snapshot after a partial load', async () => {
        await setActiveSnapshots({ 'example.com': partial('second', ['localStorage']) });
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('second'))).toBe(false);

        await loadPartly('first', ['sessionStorage']);

        expect(await active()).toEqual(partial('first', ['sessionStorage']));
        expect(isHidden(modifiedBadge('first'))).toBe(true);
        expect(isHidden(modifiedBadge('second'))).toBe(true);
      });

      it('union keeps a type that has since been disabled', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await enable({ cookies: false });
        await loadPopup('https://example.com/');
        await loadPartly('first', ['localStorage']);
        expect(await active()).toEqual(partial('first', ['cookies', 'localStorage']));

        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(true);

        pageData.localStorage = { ls: 'x' };
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
        expect(modifiedBadge('first').title).not.toContain('Cookie');
      });

      it('a full load after a partial load compares every type again', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');
        row('first').querySelector('.snapshot__main').click();
        await settle();
        expect(await active()).toBe('first');
        expect(activeBadge('first').textContent).toBe('適用中');

        pageData.localStorage = { ls: 'x' };
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
      });

      it('partial record in a group marks only its own row "一部適用中"', async () => {
        await setGroups(['example.com']);
        chrome._state.grantedOrigins.add('*://*.example.com/*');
        await setSnapshots({ 'www.example.com': { mine: full('m') }, 'app.example.com': { theirs: full('t') } });
        await loadPopup('https://www.example.com/');
        await loadPartly('mine', ['localStorage']);

        expect(await active()).toEqual(partial('mine', ['localStorage'], 'www.example.com'));
        expect(await active('www.example.com')).toBeUndefined();
        expect(activeBadge('mine').textContent).toBe('一部適用中');
        expect(isHidden(activeBadge('theirs'))).toBe(true);
      });
    });

    describe('the change check', () => {
      it('does not flag differences in types that were not loaded', async () => {
        chrome._state.cookies = [sid('a')];
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');

        expect(isHidden(modifiedBadge('first'))).toBe(true);
      });

      it('flags a change in a type that was loaded', async () => {
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');

        expect(isHidden(modifiedBadge('first'))).toBe(false);
        expect(modifiedBadge('first').title).toContain('Cookie: sid');
      });

      it('no changes while the cookie check is pending after a cookies-only load', async () => {
        await chrome.storage.local.set(pending());
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');

        expect(isHidden(modifiedBadge('first'))).toBe(true);
      });

      it('localStorage-only record still compares localStorage while learning', async () => {
        await chrome.storage.local.set(pending());
        await setActiveSnapshots({ 'example.com': partial('first', ['localStorage']) });
        await loadPopup('https://example.com/');

        expect(isHidden(modifiedBadge('first'))).toBe(false);
        expect(modifiedBadge('first').title).toContain('localStorage');
      });

      it('compares nothing when the only recorded type is disabled', async () => {
        await enable({ cookies: false });
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');

        expect(isHidden(modifiedBadge('first'))).toBe(true);
        expect(activeBadge('first').textContent).toBe('一部適用中');
      });

      it('reads a types value that is not an array as a full record', async () => {
        chrome._state.cookies = [sid('a')];
        await setActiveSnapshots({ 'example.com': { host: 'example.com', name: 'first', types: 'cookies' } });
        await loadPopup('https://example.com/');

        expect(activeBadge('first').textContent).toBe('適用中');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
      });

      it('reads an empty or all-unknown types array as a full record', async () => {
        chrome._state.cookies = [sid('a')];
        for (const types of [[], ['bogus']]) {
          await setActiveSnapshots({ 'example.com': partial('first', types) });
          await loadPopup('https://example.com/');

          expect(activeBadge('first').textContent).toBe('適用中');
          expect(isHidden(modifiedBadge('first'))).toBe(false);
        }
      });

      it('drops unknown names from the recorded types', async () => {
        chrome._state.cookies = [sid('a')];
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies', 'bogus']) });
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(true);
        expect(activeBadge('first').textContent).toBe('一部適用中');
        expect(activeBadge('first').title).not.toContain('bogus');

        chrome._state.cookies = [sid('changed')];
        await loadPopup('https://example.com/');
        expect(isHidden(modifiedBadge('first'))).toBe(false);
      });
    });

    describe('undo', () => {
      it('undo after a partial load restores the previous partial record', async () => {
        chrome._state.cookies = [sid('a')];
        await setActiveSnapshots({ 'example.com': partial('first', ['cookies']) });
        await loadPopup('https://example.com/');
        await loadPartly('second', ['localStorage']);
        expect((await getBackups())['example.com'].activeName).toEqual(partial('first', ['cookies']));

        $('undoBtn').click();
        await settle();

        expect(await active()).toEqual(partial('first', ['cookies']));
        expect(activeBadge('first').textContent).toBe('一部適用中');
        expect(isHidden(modifiedBadge('first'))).toBe(true);
      });

      it('undo of a partial load over a full or no active record restores a string or null', async () => {
        await setActiveSnapshots({ 'example.com': 'first' });
        await loadPopup('https://example.com/');
        await loadPartly('second', ['localStorage']);
        $('undoBtn').click();
        await settle();
        expect(await active()).toBe('first');

        await setActiveSnapshots({});
        await loadPopup('https://example.com/');
        await loadPartly('second', ['localStorage']);
        expect(await active()).toEqual(partial('second', ['localStorage']));
        $('undoBtn').click();
        await settle();
        expect(await active()).toBeUndefined();
      });
    });
  });

  describe('a notice left by the shortcut', () => {
    const WRITTEN = new Date('2024-01-01T00:00:00.000Z').getTime();
    const notice = (more = {}) => ({ tabId: 1, host: 'example.com', key: 'shortcut_no_previous', until: WRITTEN + 60_000, ...more });
    const stored = async () => (await chrome.storage.local.get('commandNotice')).commandNotice;
    const isShown = () => !$('statusMsg').classList.contains('hidden');

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a notice for this tab and removes it', async () => {
      await chrome.storage.local.set({ commandNotice: notice() });
      vi.setSystemTime(WRITTEN + 59_000);
      await loadPopup('https://example.com/');

      expect(isShown()).toBe(true);
      expect($('statusMsg').className).toContain('error');
      expect($('statusMsg').textContent).toBe('ショートカットで切り替える前のスナップショットがありません');
      expect(await stored()).toBeUndefined();
    });

    it('removes an expired notice without showing it', async () => {
      await chrome.storage.local.set({ commandNotice: notice() });
      vi.setSystemTime(WRITTEN + 61_000);
      await loadPopup('https://example.com/');

      expect(isShown()).toBe(false);
      expect(await stored()).toBeUndefined();
    });

    it('leaves another tab\'s valid notice in place', async () => {
      await chrome.storage.local.set({ commandNotice: notice({ tabId: 2 }) });
      vi.setSystemTime(WRITTEN + 1_000);
      await loadPopup('https://example.com/');

      expect(isShown()).toBe(false);
      expect(await stored()).toEqual(notice({ tabId: 2 }));
    });

    it('ignores a notice with an unknown key, and removes it', async () => {
      await chrome.storage.local.set({ commandNotice: notice({ key: 'status_loaded' }) });
      vi.setSystemTime(WRITTEN + 1_000);
      await loadPopup('https://example.com/');

      expect(isShown()).toBe(false);
      expect(await stored()).toBeUndefined();
    });

    it('shows the notice on a page the popup cannot serve, before choosing its panel', async () => {
      await chrome.storage.local.set({ commandNotice: notice({ key: 'unavailable', host: null }) });
      vi.setSystemTime(WRITTEN + 1_000);
      await loadPopup('chrome-extension://abcdefghijklmnop/options/options.html');

      expect($('permissionPanel').classList.contains('hidden')).toBe(false);
      expect(isShown()).toBe(true);
      expect($('statusMsg').textContent).toBe('このページでは使用できません');
    });

    it.each([
      'shortcut_needs_backup',
      'shortcut_no_previous',
      'shortcut_page_unreachable',
      'shortcut_backup_failed',
      'error_load_failed',
    ])('shows %s in its own words', async key => {
      const { MESSAGES } = await import('../../lib/i18n.js');
      await chrome.storage.local.set({ commandNotice: notice({ key }) });
      vi.setSystemTime(WRITTEN + 1_000);
      await loadPopup('https://example.com/');

      expect(MESSAGES.ja[key]).toEqual(expect.any(String));
      expect(isShown()).toBe(true);
      expect($('statusMsg').textContent).toBe(MESSAGES.ja[key]);
    });

    it('removes a notice for the site the tab has since left without showing it', async () => {
      await chrome.storage.local.set({ commandNotice: notice({ host: 'other.test' }) });
      vi.setSystemTime(WRITTEN + 1_000);
      await loadPopup('https://example.com/');

      expect(isShown()).toBe(false);
      expect(await stored()).toBeUndefined();
    });

    it('shows a notice on another page of the same site', async () => {
      await chrome.storage.local.set({ commandNotice: notice() });
      vi.setSystemTime(WRITTEN + 1_000);
      await loadPopup('http://example.com/elsewhere?x=1');

      expect(isShown()).toBe(true);
    });
  });

  describe('recording the previous snapshot', () => {
    const sid = value => ({ name: 'sid', value, domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    const previous = async () => (await chrome.storage.local.get('previousSnapshots')).previousSnapshots?.['example.com'];
    const ref = name => ({ host: 'example.com', name });

    beforeEach(async () => {
      chrome._state.cookies = [sid('page')];
      await setSnapshots({ 'example.com': {
        first:  snap('2024-01-01T00:00:00.000Z', { cookies: [sid('a')], localStorage: { a: '1' } }),
        second: snap('2024-01-01T00:00:00.000Z', { cookies: [sid('b')], localStorage: { b: '2' } }),
      } });
      await setActiveSnapshots({ 'example.com': 'first' });
    });

    it('a load, an undo and a save under a new name record the previous snapshot', async () => {
      await loadPopup('https://example.com/');

      row('second').querySelector('.snapshot__main').click();
      await settle();
      expect(await previous()).toEqual(ref('first'));

      $('undoBtn').click();
      await settle();
      expect((await getActiveSnapshots())['example.com']).toBe('first');
      expect(await previous()).toEqual(ref('second'));

      $('saveBtn').click();
      $('newSnapshotName').value = 'third';
      $('confirmSaveBtn').click();
      await settle();
      expect((await getActiveSnapshots())['example.com']).toBe('third');
      expect(await previous()).toEqual(ref('first'));
    });

    it('a partial load of another snapshot records the previous without types', async () => {
      await loadPopup('https://example.com/');

      row('second').querySelector('.actions-menu [data-action="load-partial"]').click();
      await settle();
      document.querySelector('dialog .tk3-btn-confirm').click();
      await settle();

      expect((await getActiveSnapshots())['example.com']).toEqual({ host: 'example.com', name: 'second', types: ['cookies'] });
      expect(await previous()).toEqual(ref('first'));
    });

    it('overwriting the active snapshot keeps previous', async () => {
      await chrome.storage.local.set({ previousSnapshots: { 'example.com': ref('second') } });
      await loadPopup('https://example.com/');

      row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await getSnapshots())['example.com'].first.localStorage).toEqual({ current: '1' });
      expect(await previous()).toEqual(ref('second'));
    });

    it('a partial overwrite of the partly active snapshot keeps previous', async () => {
      await setActiveSnapshots({ 'example.com': { host: 'example.com', name: 'first', types: ['cookies'] } });
      await chrome.storage.local.set({ previousSnapshots: { 'example.com': ref('second') } });
      await loadPopup('https://example.com/');

      row('first').querySelector('.actions-menu [data-action="overwrite"]').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();

      expect((await getSnapshots())['example.com'].first.cookies.map(c => c.value)).toEqual(['page']);
      expect(await previous()).toEqual(ref('second'));
    });

    it('clearing the site keeps previous, and so does undoing the clear', async () => {
      await chrome.storage.local.set({ previousSnapshots: { 'example.com': ref('second') } });
      const base = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        if (message.type === 'clearStorageData') {
          pageData = {};
          return { success: true, blockedIndexedDB: [] };
        }
        return base(tabId, message);
      });
      await loadPopup('https://example.com/');

      $('clearSiteBtn').click();
      await settle();
      document.querySelector('.tk3-btn-confirm').click();
      await settle();
      expect((await getActiveSnapshots())['example.com']).toBeUndefined();
      expect(await previous()).toEqual(ref('second'));

      $('undoBtn').click();
      await settle();
      expect((await getActiveSnapshots())['example.com']).toBe('first');
      expect(await previous()).toEqual(ref('second'));
    });
  });
});
