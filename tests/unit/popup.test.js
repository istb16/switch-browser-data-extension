import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setSnapshots } from '../../lib/storage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const popupHtml = readFileSync(path.join(repoRoot, 'popup/popup.html'), 'utf-8');
const bodyHtml = popupHtml.match(/<body>([\s\S]*)<\/body>/)[1];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function loadPopup(tabUrl) {
  document.body.innerHTML = bodyHtml;
  chrome.tabs.query = vi.fn().mockResolvedValue(tabUrl == null ? [] : [{ id: 1, url: tabUrl }]);
  vi.resetModules();
  await import('../../popup/popup.js');
  await flush();
}

describe('popup/popup.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the "unavailable" message for restricted URLs (chrome://, edge://, no tab)', async () => {
    await loadPopup('chrome://extensions/');

    expect(document.getElementById('unavailableMsg').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('mainContent').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('currentDomain').textContent).toBe('-');
  });

  it('shows the "unavailable" message when there is no active tab at all', async () => {
    await loadPopup(undefined);
    expect(document.getElementById('unavailableMsg').classList.contains('hidden')).toBe(false);
  });

  it('detects the domain from the active tab and reveals the main content', async () => {
    await loadPopup('https://example.com/some/path?x=1');

    expect(document.getElementById('currentDomain').textContent).toBe('example.com');
    expect(document.getElementById('mainContent').classList.contains('hidden')).toBe(false);
  });

  it('populates the snapshot dropdown with existing snapshots for the domain, load/delete disabled until one is picked', async () => {
    await setSnapshots({ 'example.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' }, second: { savedAt: '2024-02-02T00:00:00.000Z' } } });
    await loadPopup('https://example.com/');

    const options = [...document.getElementById('snapshotSelect').options].map(o => o.value);
    expect(options).toEqual(['', 'first', 'second']);
    expect(document.getElementById('loadBtn').disabled).toBe(true);
    expect(document.getElementById('deleteBtn').disabled).toBe(true);
  });

  it('enables load/delete and shows the saved-at date once a snapshot is selected', async () => {
    await setSnapshots({ 'example.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' } } });
    await loadPopup('https://example.com/');

    document.getElementById('snapshotSelect').value = 'first';
    document.getElementById('snapshotSelect').dispatchEvent(new Event('change'));

    expect(document.getElementById('loadBtn').disabled).toBe(false);
    expect(document.getElementById('deleteBtn').disabled).toBe(false);
    expect(document.getElementById('snapshotMeta').textContent).toContain('2024');
  });

  it('settings button opens the options page', async () => {
    await loadPopup('https://example.com/');
    chrome.runtime.openOptionsPage = vi.fn();

    document.getElementById('settingsBtn').click();

    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });

  describe('saving a new snapshot', () => {
    it('shows an error and does not save when the name is empty', async () => {
      await loadPopup('https://example.com/');
      document.getElementById('saveBtn').click();
      document.getElementById('confirmSaveBtn').click();
      await flush();

      expect(document.getElementById('statusMsg').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('statusMsg').className).toContain('error');
      expect(await import('../../lib/storage.js').then(m => m.getSnapshots())).toEqual({});
    });

    it('collects data and saves under the entered name, then selects it in the dropdown', async () => {
      await loadPopup('https://example.com/');
      chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ localStorage: { a: '1' } });

      document.getElementById('saveBtn').click();
      document.getElementById('newSnapshotName').value = 'my snapshot';
      document.getElementById('confirmSaveBtn').click();
      await flush();

      const { getSnapshots } = await import('../../lib/storage.js');
      const snapshots = await getSnapshots();
      expect(snapshots['example.com']['my snapshot'].localStorage).toEqual({ a: '1' });
      expect(document.getElementById('snapshotSelect').value).toBe('my snapshot');
      expect(document.getElementById('savePanel').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('statusMsg').className).toContain('success');
    });

    it('overwrites the selected snapshot in "overwrite" mode', async () => {
      await setSnapshots({ 'example.com': { existing: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { old: '1' } } } });
      await loadPopup('https://example.com/');
      chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ localStorage: { fresh: '2' } });

      document.getElementById('saveBtn').click();
      document.querySelector('input[name="saveMode"][value="overwrite"]').click();
      document.getElementById('overwriteSelect').value = 'existing';
      document.getElementById('confirmSaveBtn').click();
      await flush();

      const { getSnapshots } = await import('../../lib/storage.js');
      const snapshots = await getSnapshots();
      expect(snapshots['example.com'].existing.localStorage).toEqual({ fresh: '2' });
    });
  });

  describe('loading a snapshot', () => {
    it('does nothing when the user cancels the confirmation dialog', async () => {
      await setSnapshots({ 'example.com': { first: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { a: '1' } } } });
      await loadPopup('https://example.com/');
      chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });

      document.getElementById('snapshotSelect').value = 'first';
      document.getElementById('snapshotSelect').dispatchEvent(new Event('change'));
      document.getElementById('loadBtn').click();
      await flush();

      document.querySelector('.tk3-btn-cancel').click();
      await flush();

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it('applies the snapshot data after confirming', async () => {
      await setSnapshots({ 'example.com': { first: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { a: '1' } } } });
      await loadPopup('https://example.com/');
      chrome.tabs.sendMessage = vi.fn().mockResolvedValue({ success: true });

      document.getElementById('snapshotSelect').value = 'first';
      document.getElementById('snapshotSelect').dispatchEvent(new Event('change'));
      document.getElementById('loadBtn').click();
      await flush();

      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'setStorageData',
        data: { localStorage: { a: '1' } },
      }));
      expect(document.getElementById('statusMsg').className).toContain('success');
    });
  });

  describe('deleting a snapshot', () => {
    it('removes the snapshot and refreshes the dropdown after confirming', async () => {
      await setSnapshots({ 'example.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadPopup('https://example.com/');

      document.getElementById('snapshotSelect').value = 'first';
      document.getElementById('snapshotSelect').dispatchEvent(new Event('change'));
      document.getElementById('deleteBtn').click();
      await flush();

      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      const { getSnapshots } = await import('../../lib/storage.js');
      expect(await getSnapshots()).toEqual({});
      const options = [...document.getElementById('snapshotSelect').options].map(o => o.value);
      expect(options).toEqual(['']);
    });
  });
});
