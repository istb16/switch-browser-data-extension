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
