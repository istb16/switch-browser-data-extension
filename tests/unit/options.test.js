import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setSnapshots, setSnapshotOrders, getSnapshots, getSnapshotOrders, setSettings, getSettings } from '../../lib/storage.js';
import { byteSize, formatBytes } from '../../lib/snapshot-summary.js';
import { encryptText, ENVELOPE_TAG, MIN_ITERATIONS } from '../../lib/crypto.js';
import { IMPORT_MAX_BYTES } from '../../lib/transfer.js';
import { MESSAGES } from '../../lib/i18n.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const optionsHtml = readFileSync(path.join(repoRoot, 'options/options.html'), 'utf-8');
const bodyHtml = optionsHtml.match(/<body>([\s\S]*)<\/body>/)[1];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function loadOptions() {
  document.body.innerHTML = bodyHtml;
  vi.resetModules();
  await import('../../options/options.js');
  await flush();
}

function domainItems() {
  return [...document.querySelectorAll('.domain-item')];
}

describe('options/options.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', location.pathname);
    // The chrome mock has no getBytesInUse; measure the mock's storage instead.
    chrome.storage.local.getBytesInUse = vi.fn(async keys => {
      const stored = chrome._state.storage;
      return keys == null ? byteSize(stored) : (keys in stored ? byteSize(stored[keys]) : 0);
    });
  });

  describe('navigation', () => {
    const visiblePanes = () => [...document.querySelectorAll('.pane')].filter(p => !p.hidden).map(p => p.dataset.pane);
    const currentLinks = () => [...document.querySelectorAll('.nav-link[aria-current="page"]')].map(a => a.dataset.pane);

    it('shows only the General pane when there is no hash', async () => {
      await loadOptions();
      expect(visiblePanes()).toEqual(['general']);
      expect(currentLinks()).toEqual(['general']);
    });

    it('opens the pane named by the hash and follows hash changes', async () => {
      history.replaceState(null, '', '#snapshots');
      await loadOptions();
      expect(visiblePanes()).toEqual(['snapshots']);
      expect(currentLinks()).toEqual(['snapshots']);

      history.replaceState(null, '', '#data');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(visiblePanes()).toEqual(['data']);
      expect(currentLinks()).toEqual(['data']);
    });

    it('falls back to General for an unknown hash', async () => {
      history.replaceState(null, '', '#nope');
      await loadOptions();
      expect(visiblePanes()).toEqual(['general']);
    });
  });

  describe('storage meter', () => {
    const segments = () => [...document.querySelectorAll('#meterBar .meter-segment')];

    it('six domains give five domain segments, backups and other', async () => {
      const snapshots = {};
      for (const [i, domain] of ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'].entries()) {
        snapshots[domain] = { s: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { k: 'x'.repeat((i + 1) * 100) } } };
      }
      await setSnapshots(snapshots);
      const total = 100_000;
      chrome.storage.local.getBytesInUse = vi.fn(async keys => (keys == null ? total : keys === 'backups' ? 2_000 : 0));
      await loadOptions();

      const segs = segments();
      expect(segs.map(s => s.className.replace('meter-segment ', ''))).toEqual([
        'meter-segment--domain-1', 'meter-segment--domain-2', 'meter-segment--domain-3',
        'meter-segment--domain-4', 'meter-segment--domain-5', 'meter-segment--backups', 'meter-segment--other',
      ]);
      expect(segs.reduce((sum, s) => sum + Number(s.dataset.bytes), 0)).toBe(total);
      expect(segs[0].title).toContain('f.com');
      expect(segs.slice(0, 5).some(s => s.title.includes('a.com'))).toBe(false);
      expect(Number(segs[5].dataset.bytes)).toBe(2_000);
      expect(document.getElementById('meterTotal').textContent).toBe(formatBytes(total));
      expect(document.querySelectorAll('#meterLegend li')).toHaveLength(7);
    });

    it('shows the advisory from 50 MB', async () => {
      const limit = 50 * 1024 * 1024;
      chrome.storage.local.getBytesInUse = vi.fn(async keys => (keys == null ? limit - 1 : 0));
      await loadOptions();
      expect(document.getElementById('meterAdvisory').classList.contains('hidden')).toBe(true);

      chrome.storage.local.getBytesInUse = vi.fn(async keys => (keys == null ? limit : 0));
      await loadOptions();
      expect(document.getElementById('meterAdvisory').classList.contains('hidden')).toBe(false);
    });

    it('deleting a snapshot refreshes the meter and the domain size', async () => {
      await setSnapshots({ 'a.com': {
        big:   { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { k: 'x'.repeat(5000) } },
        small: { savedAt: '2024-01-01T00:00:00.000Z' },
      } });
      await loadOptions();
      const before = document.getElementById('meterTotal').textContent;

      document.querySelector('.snapshot-row[data-name="big"] .btn-icon').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(document.getElementById('meterTotal').textContent).not.toBe(before);
      expect(document.querySelector('.domain-size').textContent)
        .toBe(formatBytes(byteSize({ savedAt: '2024-01-01T00:00:00.000Z' })));
    });
  });

  describe('rows and sorting', () => {
    it('a row shows its colour chip, memo and size', async () => {
      const snapshot = { savedAt: '2024-01-01T00:00:00.000Z', memo: 'work account', color: 'green' };
      await setSnapshots({ 'a.com': { x: snapshot, y: { savedAt: '2024-01-01T00:00:00.000Z', color: 'pink' } } });
      await loadOptions();

      const row = document.querySelector('.snapshot-row[data-name="x"]');
      expect(row.querySelector('.snapshot-chip').classList.contains('snapshot-chip--green')).toBe(true);
      expect(row.querySelector('.snapshot-chip').getAttribute('aria-label')).toBe('色: 緑');
      expect(row.querySelector('.snapshot-memo').textContent).toBe('work account');
      expect(row.querySelector('.snapshot-size').textContent).toBe(formatBytes(byteSize(snapshot)));
      expect(document.querySelector('.domain-size').textContent).not.toBe('');

      const plain = document.querySelector('.snapshot-row[data-name="y"]');
      expect(plain.querySelector('.snapshot-chip')).toBeNull();
      expect(plain.querySelector('.snapshot-memo')).toBeNull();
    });

    it('size sort orders domains and rows by size and disables drag', async () => {
      await setSnapshots({
        'a.com': { s: { savedAt: '2024-01-01T00:00:00.000Z' } },
        'b.com': {
          aa: { savedAt: '2024-01-01T00:00:00.000Z' },
          zz: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { k: 'x'.repeat(500) } },
        },
      });
      await setSnapshotOrders({ 'b.com': ['aa', 'zz'] });
      await loadOptions();

      expect(domainItems().map(i => i.querySelector('.domain-name').textContent)).toEqual(['a.com', 'b.com']);
      expect(document.querySelector('.snapshot-row').draggable).toBe(true);

      const select = document.getElementById('sortSelect');
      select.value = 'size';
      select.dispatchEvent(new Event('change'));
      await flush();

      const items = domainItems();
      expect(items.map(i => i.querySelector('.domain-name').textContent)).toEqual(['b.com', 'a.com']);
      const rows = [...items[0].querySelectorAll('.snapshot-row')];
      expect(rows.map(r => r.dataset.name)).toEqual(['zz', 'aa']);
      expect(rows.every(r => !r.draggable && !r.querySelector('.drag-handle'))).toBe(true);

      items[0].querySelector('.domain-snapshots').dispatchEvent(new Event('drop', { bubbles: true }));
      await flush();
      expect((await getSnapshotOrders())['b.com']).toEqual(['aa', 'zz']);
    });
  });

  it('shows the manifest version in the footer', async () => {
    chrome._state.manifest.version = '9.9.9';
    await loadOptions();
    expect(document.getElementById('versionFooter').textContent).toBe('バージョン: 9.9.9');
  });

  it('shows the empty state when there are no snapshots', async () => {
    await loadOptions();
    expect(document.querySelector('.empty-state')).not.toBeNull();
    expect(domainItems()).toHaveLength(0);
  });

  it('renders one collapsed domain-item per domain, sorted, with ordered snapshot rows', async () => {
    await setSnapshots({
      'b.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } },
      'a.com': { second: { savedAt: '2024-01-01T00:00:00.000Z' }, first: { savedAt: '2024-01-01T00:00:00.000Z' } },
    });
    await setSnapshotOrders({ 'a.com': ['first', 'second'] });
    await loadOptions();

    const items = domainItems();
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.domain-name').textContent).toBe('a.com');
    expect(items[1].querySelector('.domain-name').textContent).toBe('b.com');
    expect(items[0].classList.contains('open')).toBe(false);

    const names = [...items[0].querySelectorAll('.snapshot-name')].map(n => n.textContent);
    expect(names).toEqual(['first', 'second']);
    expect(items[0].querySelector('.domain-count').textContent).toBe('2 件');
  });

  it('toggles a domain open/closed when its header is clicked', async () => {
    await setSnapshots({ 'a.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } } });
    await loadOptions();

    const item = domainItems()[0];
    item.querySelector('.domain-header').click();
    expect(item.classList.contains('open')).toBe(true);
    item.querySelector('.domain-header').click();
    expect(item.classList.contains('open')).toBe(false);
  });

  it('reflects saved settings in the toggles and saves a change as soon as a toggle changes', async () => {
    await setSettings({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: false, indexedDB: true }, autoReload: false });
    await loadOptions();

    expect(document.getElementById('toggleCookies').checked).toBe(false);
    expect(document.getElementById('toggleLocalStorage').checked).toBe(true);
    expect(document.getElementById('toggleAutoBackup').checked).toBe(true);
    expect(document.getElementById('toggleAutoReload').checked).toBe(false);
    expect(document.getElementById('toggleShowBadge').checked).toBe(true);

    document.getElementById('toggleCookies').click();
    await flush();
    document.getElementById('toggleShowBadge').click();
    await flush();

    const { getSettings } = await import('../../lib/storage.js');
    const settings = await getSettings();
    expect(settings.enabledTypes.cookies).toBe(true);
    expect(settings.showBadge).toBe(false);
    expect(settings.autoReload).toBe(false);
    expect(document.getElementById('statusMsg').className).toContain('success');
  });

  it('switching language re-renders text and the domain list', async () => {
    await setSnapshots({ 'a.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } } });
    await loadOptions();

    document.getElementById('langSelect').value = 'en';
    document.getElementById('langSelect').dispatchEvent(new Event('change'));
    await flush();

    expect(document.querySelector('h1').textContent).toBe('Settings');
    expect(document.getElementById('versionFooter').textContent).toMatch(/^Version: /);
  });

  describe('renaming a snapshot', () => {
    async function setUpTwoOpenDomains() {
      await setSnapshots({
        'a.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' } },
        'b.com': { other: { savedAt: '2024-01-01T00:00:00.000Z' } },
      });
      await setSnapshotOrders({ 'a.com': ['first'], 'b.com': ['other'] });
      await loadOptions();
      const [itemA, itemB] = domainItems();
      itemA.querySelector('.domain-header').click();
      itemB.querySelector('.domain-header').click();
      return { itemA, itemB };
    }

    it('renames in place without collapsing other open domains or rebuilding the DOM', async () => {
      const { itemA, itemB } = await setUpTwoOpenDomains();
      const row = itemA.querySelector('.snapshot-row');

      row.querySelector('.snapshot-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.snapshot-name-input');
      input.value = 'renamed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();

      expect(row.dataset.name).toBe('renamed');
      expect(row.querySelector('.snapshot-name').textContent).toBe('renamed');
      expect(itemB.classList.contains('open')).toBe(true);
      expect(domainItems()[0]).toBe(itemA);
      expect(domainItems()[0].querySelector('.snapshot-row')).toBe(row);

      const orders = await getSnapshotOrders();
      expect(orders['a.com']).toEqual(['renamed']);
    });

    it('shows an error and keeps editing when the new name is empty', async () => {
      const { itemA } = await setUpTwoOpenDomains();
      const row = itemA.querySelector('.snapshot-row');
      row.querySelector('.snapshot-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.snapshot-name-input');
      input.value = '  ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();

      expect(row.querySelector('.rename-error')).not.toBeNull();
      expect(row.querySelector('.snapshot-name-input')).not.toBeNull();
      expect(row.dataset.name).toBe('first');
    });

    it('shows an error when the new name already exists in the same domain', async () => {
      await setSnapshots({ 'a.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' }, second: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();
      const row = document.querySelector('.snapshot-row[data-name="first"]');
      row.querySelector('.snapshot-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.snapshot-name-input');
      input.value = 'second';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();

      expect(row.querySelector('.rename-error').textContent).toContain('second');
      expect(row.dataset.name).toBe('first');
    });

    it('Escape cancels the rename and restores the original name', async () => {
      const { itemA } = await setUpTwoOpenDomains();
      const row = itemA.querySelector('.snapshot-row');
      row.querySelector('.snapshot-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.snapshot-name-input');
      input.value = 'changed-my-mind';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(row.querySelector('.snapshot-name-input')).toBeNull();
      expect(row.querySelector('.snapshot-name').textContent).toBe('first');
      expect(row.dataset.name).toBe('first');
    });

    it('committing the same name as before is a no-op cancel', async () => {
      const { itemA } = await setUpTwoOpenDomains();
      const row = itemA.querySelector('.snapshot-row');
      row.querySelector('.snapshot-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.snapshot-name-input');
      input.value = 'first';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();

      expect(row.querySelector('.snapshot-name-input')).toBeNull();
      expect(row.dataset.name).toBe('first');
    });
  });

  describe('deleting a snapshot', () => {
    it('removes just the row and updates the count badge without collapsing other open domains', async () => {
      await setSnapshots({
        'a.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' }, second: { savedAt: '2024-01-01T00:00:00.000Z' } },
        'b.com': { other: { savedAt: '2024-01-01T00:00:00.000Z' } },
      });
      await loadOptions();
      const [itemA, itemB] = domainItems();
      itemA.querySelector('.domain-header').click();
      itemB.querySelector('.domain-header').click();

      const row = itemA.querySelector('.snapshot-row[data-name="first"]');
      row.querySelector('.btn-icon').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(itemA.querySelector('.snapshot-row[data-name="first"]')).toBeNull();
      expect(itemA.querySelectorAll('.snapshot-row')).toHaveLength(1);
      expect(itemA.querySelector('.domain-count').textContent).toBe('1 件');
      expect(itemB.classList.contains('open')).toBe(true);
      expect(domainItems()).toHaveLength(2);
    });

    it('keeps the domain-item visible even after deleting its last snapshot', async () => {
      await setSnapshots({ 'a.com': { only: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      document.querySelector('.btn-icon').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(domainItems()).toHaveLength(1);
      expect(document.querySelector('.domain-count').textContent).toBe('0 件');
      expect(document.querySelectorAll('.snapshot-row')).toHaveLength(0);
    });

    it('does nothing when the user cancels the delete confirmation', async () => {
      await setSnapshots({ 'a.com': { first: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      document.querySelector('.btn-icon').click();
      await flush();
      document.querySelector('.tk3-btn-cancel').click();
      await flush();

      expect(document.querySelectorAll('.snapshot-row')).toHaveLength(1);
    });
  });

  it('reordering via drag-and-drop persists the new snapshotOrder', async () => {
    await setSnapshots({ 'a.com': { first: {}, second: {} } });
    await setSnapshotOrders({ 'a.com': ['first', 'second'] });
    await loadOptions();

    const list = document.querySelector('.domain-snapshots');
    const [firstRow, secondRow] = [...list.querySelectorAll('.snapshot-row')];
    list.insertBefore(secondRow, firstRow);
    list.dispatchEvent(new Event('drop', { bubbles: true }));
    await flush();

    expect((await getSnapshotOrders())['a.com']).toEqual(['second', 'first']);
  });

  it('exports all snapshots as a downloadable JSON blob', async () => {
    await setSnapshots({ 'a.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } } });
    await loadOptions();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    document.getElementById('exportBtn').click();
    await flush();

    expect(clickSpy).toHaveBeenCalled();
    expect(document.getElementById('statusMsg').className).toContain('success');
    clickSpy.mockRestore();
  });

  describe('importing snapshots', () => {
    // jsdom's File/Blob implementation doesn't provide .text(), which is all
    // handleImport() actually calls — a plain object with that method is a
    // faithful enough stand-in for `e.target.files[0]`.
    function setInputFiles(input, text) {
      Object.defineProperty(input, 'files', { value: [{ text: async () => text }], configurable: true });
    }

    it('merges imported snapshots into existing storage per domain', async () => {
      await setSnapshots({ 'a.com': { existing: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      setInputFiles(document.getElementById('importFile'), JSON.stringify({ 'a.com': { imported: { savedAt: '2024-02-02T00:00:00.000Z' } } }));
      document.getElementById('importFile').dispatchEvent(new Event('change'));
      await flush();

      const snapshots = await getSnapshots();
      expect(Object.keys(snapshots['a.com']).sort()).toEqual(['existing', 'imported']);
      expect(document.getElementById('statusMsg').className).toContain('success');
    });

    it('shows an error for malformed JSON and does not touch existing data', async () => {
      await setSnapshots({ 'a.com': { existing: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      setInputFiles(document.getElementById('importFile'), 'not json');
      document.getElementById('importFile').dispatchEvent(new Event('change'));
      await flush();

      expect(document.getElementById('statusMsg').className).toContain('error');
      expect(await getSnapshots()).toEqual({ 'a.com': { existing: { savedAt: '2024-01-01T00:00:00.000Z' } } });
    });
  });

  describe('scoped export, encryption and checked import', () => {
    const SAVED = '2024-01-01T00:00:00.000Z';
    let downloads;
    let restoreDownloads;

    beforeEach(() => {
      downloads = [];
      const { createObjectURL, revokeObjectURL } = URL;
      URL.createObjectURL = vi.fn(blob => { downloads.push(blob); return 'blob:test'; });
      URL.revokeObjectURL = vi.fn();
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      restoreDownloads = () => {
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
        click.mockRestore();
      };
    });

    afterEach(() => restoreDownloads());

    const readBlob = blob => (typeof blob.text === 'function'
      ? blob.text()
      : new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsText(blob);
      }));

    const dialog = () => document.querySelector('.tk3-dialog');
    const status = () => document.getElementById('statusMsg');
    const waitFor = (check, timeout = 10_000) => vi.waitFor(() => { if (!check()) throw new Error('not yet'); }, { timeout, interval: 20 });

    function importFile(file) {
      const input = document.getElementById('importFile');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
    }

    async function submitDialog(...values) {
      await waitFor(() => dialog());
      const inputs = dialog().querySelectorAll('input[type="password"]');
      values.forEach((value, i) => { inputs[i].value = value; });
      dialog().querySelector('.tk3-btn-confirm').click();
      await flush();
    }

    it('exports one domain from its header and one snapshot from its row', async () => {
      const x = { savedAt: SAVED, localStorage: { a: '1' } };
      await setSnapshots({ 'a.com': { x, y: { savedAt: SAVED } }, 'b.com': { z: { savedAt: SAVED } } });
      await loadOptions();

      const item = domainItems()[0];
      item.querySelector('.domain-header .btn-export').click();
      await flush();
      expect(item.classList.contains('open')).toBe(false);
      expect(JSON.parse(await readBlob(downloads[0]))).toEqual({ 'a.com': { x, y: { savedAt: SAVED } } });

      item.querySelector('.snapshot-row[data-name="x"] .btn-export').click();
      await flush();
      expect(JSON.parse(await readBlob(downloads[1]))).toEqual({ 'a.com': { x } });
    });

    it('a plain export shows the session warning, which the hint by the toggle also gives', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();

      document.getElementById('exportBtn').click();
      await flush();

      expect(downloads).toHaveLength(1);
      expect(status().textContent).toBe(MESSAGES.ja.status_exported_plain);
      expect(document.getElementById('exportSessionHint').textContent).toBe(MESSAGES.ja.hint_export_sessions);
      expect(document.getElementById('toggleEncryptExports').checked).toBe(false);
    });

    it('the encryption toggle reflects and saves settings.encryptExports', async () => {
      await setSettings({ encryptExports: true });
      await loadOptions();
      const toggle = document.getElementById('toggleEncryptExports');
      expect(toggle.checked).toBe(true);

      toggle.click();
      await flush();
      expect((await getSettings()).encryptExports).toBe(false);
    });

    it('an encrypted export keeps the dialog open until the passphrase is valid and downloads nothing meanwhile', async () => {
      await setSettings({ encryptExports: true });
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();

      document.getElementById('exportBtn').click();
      await waitFor(() => dialog());
      expect(dialog().textContent).toContain(MESSAGES.ja.hint_passphrase_unrecoverable);
      const error = () => dialog().querySelector('.tk3-dialog-error');

      for (const [first, second, message] of [
        ['', '', MESSAGES.ja.error_passphrase_short.replace('{n}', '8')],
        ['1234567', '1234567', MESSAGES.ja.error_passphrase_short.replace('{n}', '8')],
        ['12345678', '12345679', MESSAGES.ja.error_passphrase_mismatch],
      ]) {
        await submitDialog(first, second);
        expect(dialog()).not.toBeNull();
        expect(error().hidden).toBe(false);
        expect(error().textContent).toBe(message);
      }
      expect(downloads).toHaveLength(0);

      dialog().querySelector('.tk3-btn-cancel').click();
      await flush();
      expect(dialog()).toBeNull();
      expect(downloads).toHaveLength(0);
    });

    it('an encrypted export imports back through the real handlers', async () => {
      const snapshot = { savedAt: SAVED, localStorage: { k: 'v' }, memo: 'work', color: 'blue' };
      await setSettings({ encryptExports: true });
      await setSnapshots({ 'a.com': { x: snapshot } });
      await loadOptions();

      document.getElementById('exportBtn').click();
      await submitDialog('correct horse', 'correct horse');
      await waitFor(() => downloads.length === 1);
      const text = await readBlob(downloads[0]);
      const envelope = JSON.parse(text);
      expect(Array.isArray(envelope)).toBe(true);
      expect(envelope[0]).toBe(ENVELOPE_TAG);
      expect(text).not.toContain('a.com');
      expect(status().textContent).toBe(MESSAGES.ja.status_exported);

      await setSnapshots({});
      importFile({ size: downloads[0].size, text: () => Promise.resolve(text) });
      await submitDialog('correct horse');
      await waitFor(() => status().textContent.startsWith('インポートしました'));

      expect(await getSnapshots()).toEqual({ 'a.com': { x: snapshot } });
      expect(status().className).toContain('success');
    }, 15_000);

    it('an encrypted import with a wrong passphrase shows the error and changes nothing', async () => {
      const before = { 'a.com': { existing: { savedAt: SAVED } } };
      await setSnapshots(before);
      await loadOptions();
      const envelope = await encryptText(JSON.stringify({ 'b.com': { x: { savedAt: SAVED } } }), 'right-passphrase', MIN_ITERATIONS);

      importFile({ size: 1000, text: () => Promise.resolve(JSON.stringify(envelope)) });
      await submitDialog('wrong-passphrase');
      await waitFor(() => status().textContent === MESSAGES.ja.error_wrong_passphrase);

      expect(status().className).toContain('error');
      expect(await getSnapshots()).toEqual(before);
    });

    describe('conflicts', () => {
      const old = { savedAt: SAVED };
      const fresh = { savedAt: '2024-02-02T00:00:00.000Z' };
      const extra = { savedAt: '2024-03-03T00:00:00.000Z' };

      async function importWithConflict(choiceIndex) {
        await setSnapshots({ 'a.com': { x: old } });
        await setSnapshotOrders({ 'a.com': ['x'] });
        await loadOptions();
        importFile({ size: 100, text: () => Promise.resolve(JSON.stringify({ 'a.com': { x: fresh, y: extra } })) });
        await waitFor(() => dialog());
        expect(dialog().textContent).toContain('a.com / x');
        const buttons = dialog().querySelectorAll('button');
        // overwrite, skip, keep both, cancel
        buttons[choiceIndex].click();
        await flush();
        await flush();
      }

      it('overwrite replaces the same name in place and appends the new one', async () => {
        await importWithConflict(0);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: fresh, y: extra } });
        expect((await getSnapshotOrders())['a.com']).toEqual(['x', 'y']);
        expect(status().textContent).toBe('インポートしました（追加 1 件・上書き 1 件・別名で追加 0 件・スキップ 0 件）');
      });

      it('skip keeps the existing snapshot', async () => {
        await importWithConflict(1);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: old, y: extra } });
      });

      it('keep both adds the imported one under a new name', async () => {
        await importWithConflict(2);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: old, 'x (2)': fresh, y: extra } });
        expect((await getSnapshotOrders())['a.com']).toEqual(['x', 'x (2)', 'y']);
      });

      it('cancel changes nothing', async () => {
        await importWithConflict(3);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: old } });
        expect((await getSnapshotOrders())['a.com']).toEqual(['x']);
      });
    });

    it.each([
      ['a reserved key', '{"__proto__": {"x": {"savedAt": "2024-01-01T00:00:00.000Z"}}}'],
      ['malformed cookies', JSON.stringify({ 'b.com': { x: { savedAt: SAVED, cookies: 'nope' } } })],
    ])('refuses a file with %s', async (_, text) => {
      const before = { 'a.com': { existing: { savedAt: SAVED } } };
      await setSnapshots(before);
      await loadOptions();

      importFile({ size: text.length, text: () => Promise.resolve(text) });
      await flush();

      expect(status().className).toContain('error');
      expect(await getSnapshots()).toEqual(before);
      expect(Object.prototype).not.toHaveProperty('x');
    });

    it('refuses a file over the size limit without reading it', async () => {
      await loadOptions();
      const text = vi.fn(async () => '{}');

      importFile({ size: IMPORT_MAX_BYTES + 1, text });
      await flush();

      expect(text).not.toHaveBeenCalled();
      expect(status().className).toContain('error');
      expect(status().textContent).toBe(MESSAGES.ja.error_import_too_large.replace('{size}', formatBytes(IMPORT_MAX_BYTES)));
    });
  });

  describe('subdomain groups', () => {
    const SAVED = '2024-01-01T00:00:00.000Z';
    const status = () => document.getElementById('statusMsg');
    const groupNames = () => [...document.querySelectorAll('#groupList .group-item')].map(li => li.dataset.group);

    async function submitGroup(value) {
      document.getElementById('groupInput').value = value;
      document.getElementById('groupForm').requestSubmit();
      await flush();
    }

    async function answer(confirm) {
      document.querySelector(confirm ? '.tk3-btn-confirm' : '.tk3-btn-cancel').click();
      await flush();
      await flush();
    }

    it.each([
      ['co.jp', 'error_group_registry'],
      ['github.io', 'error_group_shared'],
      ['localhost', 'error_group_single_label'],
      ['192.168.0.1', 'error_group_ip'],
    ])('refuses %s without a confirm or a permission request', async (input, key) => {
      await loadOptions();
      const request = vi.spyOn(chrome.permissions, 'request');

      await submitGroup(input);

      expect(document.querySelector('.tk3-dialog')).toBeNull();
      expect(status().className).toContain('error');
      expect(status().textContent).toBe(MESSAGES.ja[key].replace('{group}', input));
      expect(request).not.toHaveBeenCalled();
      expect((await chrome.storage.local.get('groups')).groups ?? []).toEqual([]);
    });

    it('refuses a duplicate and a nested group', async () => {
      await chrome.storage.local.set({ groups: ['example.com'] });
      await loadOptions();

      await submitGroup('example.com');
      expect(status().textContent).toBe(MESSAGES.ja.error_group_duplicate.replace('{group}', 'example.com'));
      await submitGroup('app.example.com');
      expect(status().textContent).toBe(MESSAGES.ja.error_group_nested.replace('{group}', 'app.example.com'));
      expect((await chrome.storage.local.get('groups')).groups).toEqual(['example.com']);
    });

    it('confirms the exact scope with the shared-domain warning; cancel adds and requests nothing', async () => {
      await loadOptions();
      const request = vi.spyOn(chrome.permissions, 'request');

      await submitGroup('https://Example.com/path');
      const message = document.querySelector('.tk3-dialog-msg').textContent;
      expect(message).toContain('example.com');
      expect(message).toContain('*.example.com');
      expect(message).toContain('無関係なサイトが共有するドメイン');

      await answer(false);
      expect(request).not.toHaveBeenCalled();
      expect((await chrome.storage.local.get('groups')).groups ?? []).toEqual([]);
      expect(groupNames()).toEqual([]);
      expect(document.querySelector('#groupList .group-empty')).not.toBeNull();
    });

    it('adds the group on OK, requests both group origins and lists it', async () => {
      await loadOptions();

      await submitGroup('example.com');
      await answer(true);

      expect((await chrome.storage.local.get('groups')).groups).toEqual(['example.com']);
      expect([...chrome._state.grantedOrigins].sort()).toEqual(['*://*.example.com/*', '*://example.com/*']);
      expect(groupNames()).toEqual(['example.com']);
      expect(document.getElementById('groupInput').value).toBe('');
      expect(status().textContent).toBe(MESSAGES.ja.status_group_added.replace('{group}', 'example.com'));
    });

    it('does not request permission when cookies are turned off', async () => {
      await setSettings({ ...(await getSettings()), enabledTypes: { cookies: false, localStorage: true, sessionStorage: true, indexedDB: true } });
      await loadOptions();
      const request = vi.spyOn(chrome.permissions, 'request');

      await submitGroup('example.com');
      await answer(true);

      expect(request).not.toHaveBeenCalled();
      expect((await chrome.storage.local.get('groups')).groups).toEqual(['example.com']);
    });

    it('changes no snapshot, order or backup when adding a group', async () => {
      await setSnapshots({
        'app.example.com': { a: { savedAt: SAVED, localStorage: { k: '1' } } },
        'www.example.com': { w: { savedAt: SAVED } },
      });
      await setSnapshotOrders({ 'app.example.com': ['a'], 'www.example.com': ['w'] });
      await chrome.storage.local.set({ backups: { 'app.example.com': { savedAt: SAVED, activeName: null } } });
      const before = await chrome.storage.local.get(['snapshots', 'snapshotOrder', 'backups']);
      await loadOptions();

      await submitGroup('example.com');
      await answer(true);

      expect(await chrome.storage.local.get(['snapshots', 'snapshotOrder', 'backups'])).toEqual(before);
    });

    it('shows a group chip on member hosts only', async () => {
      await chrome.storage.local.set({ groups: ['example.com'] });
      await setSnapshots({
        'app.example.com': { a: { savedAt: SAVED } },
        'notexample.com':  { n: { savedAt: SAVED } },
      });
      await loadOptions();

      const chips = Object.fromEntries(domainItems().map(item => [
        item.querySelector('.domain-name').textContent,
        item.querySelector('.group-chip')?.textContent ?? null,
      ]));
      expect(chips).toEqual({ 'app.example.com': 'グループ: example.com', 'notexample.com': null });
    });

    it('delete removes only the wildcard permission and changes no snapshot', async () => {
      await chrome.storage.local.set({ groups: ['example.com'] });
      await setSnapshots({ 'app.example.com': { a: { savedAt: SAVED } } });
      chrome._state.grantedOrigins.add('*://example.com/*');
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      const before = await getSnapshots();
      await loadOptions();

      document.querySelector('#groupList .group-item[data-group="example.com"] .btn-icon').click();
      await flush();
      await answer(true);

      expect((await chrome.storage.local.get('groups')).groups).toEqual([]);
      expect([...chrome._state.grantedOrigins]).toEqual(['*://example.com/*']);
      expect(await getSnapshots()).toEqual(before);
      expect(groupNames()).toEqual([]);
      expect(document.querySelector('.group-chip')).toBeNull();
    });

    it('delete does nothing when cancelled', async () => {
      await chrome.storage.local.set({ groups: ['example.com'] });
      chrome._state.grantedOrigins.add('*://*.example.com/*');
      await loadOptions();

      document.querySelector('#groupList .group-item .btn-icon').click();
      await flush();
      await answer(false);

      expect((await chrome.storage.local.get('groups')).groups).toEqual(['example.com']);
      expect([...chrome._state.grantedOrigins]).toEqual(['*://*.example.com/*']);
    });
  });

  describe('clearing all data', () => {
    it('deletes everything after confirming', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      document.getElementById('clearAllBtn').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(await getSnapshots()).toEqual({});
      expect(await chrome.storage.local.get(['snapshotOrder', 'activeSnapshots', 'backups']))
        .toEqual({ snapshotOrder: {}, activeSnapshots: {}, backups: {} });
      expect(document.querySelector('.empty-state')).not.toBeNull();
    });

    it('does nothing when cancelled', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      document.getElementById('clearAllBtn').click();
      await flush();
      document.querySelector('.tk3-btn-cancel').click();
      await flush();

      expect(await getSnapshots()).not.toEqual({});
    });
  });
});
