import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  setSnapshots, setSnapshotOrders, getSnapshots, getSnapshotOrders, setSettings, getSettings, getBackups, setBackups,
  setSnapshotsFor, setBackup, getSnapshotHosts,
} from '../../lib/storage.js';
import { byteSize, formatBytes } from '../../lib/snapshot-summary.js';
import { encryptText, ENVELOPE_TAG, MIN_ITERATIONS } from '../../lib/crypto.js';
import { IMPORT_MAX_BYTES } from '../../lib/transfer.js';
import { MESSAGES } from '../../lib/i18n.js';

// The UI derives keys at the minimum accepted iteration count here: the default
// count is slow enough to time out on a busy runner, and is covered once in
// crypto.test.js.
vi.mock('../../lib/crypto.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    encryptText: (text, passphrase, iterations = actual.MIN_ITERATIONS) => actual.encryptText(text, passphrase, iterations),
  };
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const optionsHtml = readFileSync(path.join(repoRoot, 'options/options.html'), 'utf-8');
const bodyHtml = optionsHtml.match(/<body>([\s\S]*)<\/body>/)[1];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// Import records each snapshot's size.
const sized = snapshot => ({ ...snapshot, bytes: byteSize(snapshot) });

async function loadOptions() {
  document.body.innerHTML = bodyHtml;
  vi.resetModules();
  await import('../../options/options.js');
  await flush();
}

function domainItems() {
  return [...document.querySelectorAll('.domain-item')];
}

function domainNames() {
  return domainItems().map(item => item.querySelector('.domain-name').textContent);
}

function rowNames(item) {
  return [...item.querySelectorAll('.snapshot-row')].map(row => row.dataset.name);
}

// The `get` calls (by their key lists) that touch a snapshot key or the snapshot index.
function snapshotReads(getSpy) {
  return getSpy.mock.calls.map(([keys]) => keys)
    .filter(keys => keys == null || [keys].flat().some(key => key.startsWith('snapshots/') || key === 'snapshotHosts'));
}

async function setSort(value) {
  const select = document.getElementById('sortSelect');
  select.value = value;
  select.dispatchEvent(new Event('change'));
  await flush();
}

describe('options/options.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', location.pathname);
    // The chrome mock has no getBytesInUse; measure the mock's storage instead.
    chrome.storage.local.getBytesInUse = vi.fn(async keys => {
      const stored = chrome._state.storage;
      if (keys == null) return byteSize(stored);
      return [keys].flat().reduce((sum, key) => sum + (key in stored ? byteSize(stored[key]) : 0), 0);
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
      await setBackups({ 'a.com': { savedAt: '2024-01-01T00:00:00.000Z' } });
      const total = 100_000;
      chrome.storage.local.getBytesInUse = vi.fn(async keys => (keys == null ? total : keys.includes('backups/a.com') ? 2_000 : 0));
      await loadOptions();

      const segs = segments();
      expect(segs.map(s => s.className.replace('meter-segment ', ''))).toEqual([
        'meter-segment--domain-1', 'meter-segment--domain-2', 'meter-segment--domain-3',
        'meter-segment--domain-4', 'meter-segment--domain-5', 'meter-segment--backups', 'meter-segment--other',
      ]);
      expect(segs.reduce((sum, s) => sum + Number(s.dataset.bytes), 0)).toBe(total);
      expect(segs[0].title).toContain('f.com');
      expect(segs.slice(0, 5).map(s => s.title.split(': ')[0])).not.toContain('a.com');
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

    // A real reorder: drag `from` over the top half of `to`, then drop.
    async function dragRow(list, from, to) {
      const fire = (target, type, extra = {}) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', setData() {} } });
        for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
        target.dispatchEvent(event);
      };
      const row = name => list.querySelector(`.snapshot-row[data-name="${name}"]`);
      fire(row(from), 'dragstart');
      fire(row(to), 'dragover', { clientY: -1 });
      fire(row(from), 'drop');
      fire(row(from), 'dragend');
      await flush();
    }

    it('size sort orders domains and rows by size and disables drag', async () => {
      await setSnapshots({
        'a.com': { s: { savedAt: '2024-01-01T00:00:00.000Z' } },
        'b.com': {
          aa: { savedAt: '2024-01-01T00:00:00.000Z' },
          zz: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { k: 'x'.repeat(500) } },
        },
      });
      // The saved order matches what size sort shows, so a drag that got through
      // would show up as a change.
      await setSnapshotOrders({ 'b.com': ['zz', 'aa'] });
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

      const sizeList = items[0].querySelector('.domain-snapshots');
      await dragRow(sizeList, 'aa', 'zz');
      expect([...sizeList.querySelectorAll('.snapshot-row')].map(r => r.dataset.name)).toEqual(['zz', 'aa']);
      expect((await getSnapshotOrders())['b.com']).toEqual(['zz', 'aa']);

      select.value = 'name';
      select.dispatchEvent(new Event('change'));
      await flush();

      const nameList = domainItems().find(i => i.querySelector('.domain-name').textContent === 'b.com')
        .querySelector('.domain-snapshots');
      await dragRow(nameList, 'aa', 'zz');
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
      expect(document.querySelector('.domain-size').textContent).toBe(formatBytes(0));
      expect(document.querySelectorAll('.snapshot-row')).toHaveLength(0);
    });

    it('deleting one of two snapshots updates the domain size and meter without reading another host', async () => {
      const small = { savedAt: '2024-01-01T00:00:00.000Z' };
      await setSnapshots({
        'a.com': { big: { savedAt: '2024-01-01T00:00:00.000Z', localStorage: { k: 'x'.repeat(5000) } }, small },
        'b.com': { other: { savedAt: '2024-01-01T00:00:00.000Z' } },
      });
      await loadOptions();
      const get = vi.spyOn(chrome.storage.local, 'get');

      document.querySelector('.snapshot-row[data-name="big"] .btn-icon').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(domainItems()[0].querySelector('.domain-size').textContent).toBe(formatBytes(byteSize(small)));
      const segment = [...document.querySelectorAll('#meterBar .meter-segment')].find(s => s.title.startsWith('a.com: '));
      expect(Number(segment.dataset.bytes)).toBe(byteSize(small));
      expect(get.mock.calls.some(([keys]) => keys == null || [keys].flat().includes('snapshots/b.com'))).toBe(false);
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
      expect(envelope[1].iterations).toBe(MIN_ITERATIONS);
      expect(text).not.toContain('a.com');
      expect(status().textContent).toBe(MESSAGES.ja.status_exported);

      await setSnapshots({});
      importFile({ size: downloads[0].size, text: () => Promise.resolve(text) });
      await submitDialog('correct horse');
      await waitFor(() => status().textContent.startsWith('インポートしました'));

      expect(await getSnapshots()).toEqual({ 'a.com': { x: sized(snapshot) } });
      expect(status().className).toContain('success');
    });

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

    it('an export that fails shows the error and enables the button again', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      vi.spyOn(chrome.storage.local, 'get').mockImplementation(async keys => {
        if (keys === 'snapshotHosts') throw new Error('storage failure');
        return get(keys);
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const button = document.getElementById('exportBtn');

      button.click();
      await waitFor(() => status().textContent === MESSAGES.ja.error_export_failed);

      expect(status().className).toContain('error');
      expect(button.disabled).toBe(false);
      expect(downloads).toHaveLength(0);
      consoleError.mockRestore();
    });

    it('an encrypted export whose encryption fails shows the error and enables the button again', async () => {
      await setSettings({ encryptExports: true });
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();
      const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey').mockRejectedValue(new Error('OperationError'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const button = document.getElementById('exportBtn');

      button.click();
      await submitDialog('correct horse', 'correct horse');
      await waitFor(() => status().textContent === MESSAGES.ja.error_export_failed);

      expect(button.disabled).toBe(false);
      expect(downloads).toHaveLength(0);
      deriveKey.mockRestore();
      consoleError.mockRestore();
    });

    it('cancelling the new passphrase downloads nothing, shows nothing and enables the button again', async () => {
      await setSettings({ encryptExports: true });
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();
      const button = document.getElementById('exportBtn');

      button.click();
      await waitFor(() => dialog());
      expect(button.disabled).toBe(true);
      dialog().querySelector('.tk3-btn-cancel').click();
      await flush();

      expect(dialog()).toBeNull();
      expect(downloads).toHaveLength(0);
      expect(status().textContent).toBe('');
      expect(button.disabled).toBe(false);
    });

    it('cancelling the import passphrase changes nothing', async () => {
      const before = { 'a.com': { existing: { savedAt: SAVED } } };
      await setSnapshots(before);
      await loadOptions();
      const envelope = await encryptText(JSON.stringify({ 'b.com': { x: { savedAt: SAVED } } }), 'right-passphrase', MIN_ITERATIONS);

      importFile({ size: 1000, text: () => Promise.resolve(JSON.stringify(envelope)) });
      await waitFor(() => dialog());
      dialog().querySelector('.tk3-btn-cancel').click();
      await flush();
      await flush();

      expect(dialog()).toBeNull();
      expect(await getSnapshots()).toEqual(before);
      expect(status().textContent).toBe('');
      expect(document.getElementById('importFile').value).toBe('');
    });

    it.each([
      ['is not JSON', async () => encryptText('not json', 'passphrase', MIN_ITERATIONS)],
      ['is itself an encrypted file', async () => encryptText(
        JSON.stringify(await encryptText('{}', 'passphrase', MIN_ITERATIONS)), 'passphrase', MIN_ITERATIONS,
      )],
      ['has a malformed iv', async () => {
        const envelope = await encryptText('{}', 'passphrase', MIN_ITERATIONS);
        envelope[1].iv = 'AAAA';
        return envelope;
      }],
    ])('refuses an encrypted file whose content %s and changes nothing', async (_, build) => {
      const before = { 'a.com': { existing: { savedAt: SAVED } } };
      await setSnapshots(before);
      await loadOptions();
      const envelope = await build();

      importFile({ size: 1000, text: () => Promise.resolve(JSON.stringify(envelope)) });
      await submitDialog('passphrase');
      await waitFor(() => status().textContent === MESSAGES.ja.error_import_failed);

      expect(status().className).toContain('error');
      expect(await getSnapshots()).toEqual(before);
    });

    it('refuses a tampered ciphertext and changes nothing', async () => {
      const before = { 'a.com': { existing: { savedAt: SAVED } } };
      await setSnapshots(before);
      await loadOptions();
      const envelope = await encryptText(JSON.stringify({ 'b.com': { x: { savedAt: SAVED } } }), 'passphrase', MIN_ITERATIONS);
      const { data } = envelope[1];
      envelope[1].data = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`;

      importFile({ size: 1000, text: () => Promise.resolve(JSON.stringify(envelope)) });
      await submitDialog('passphrase');
      await waitFor(() => status().className.includes('error'));

      // AES-GCM cannot tell tampering from a wrong passphrase.
      expect(status().textContent).toBe(MESSAGES.ja.error_wrong_passphrase);
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
        expect(await getSnapshots()).toEqual({ 'a.com': { x: sized(fresh), y: sized(extra) } });
        expect((await getSnapshotOrders())['a.com']).toEqual(['x', 'y']);
        expect(status().textContent).toBe('インポートしました（追加 1 件・上書き 1 件・別名で追加 0 件・スキップ 0 件）');
      });

      it('skip keeps the existing snapshot', async () => {
        await importWithConflict(1);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: old, y: sized(extra) } });
      });

      it('keep both adds the imported one under a new name', async () => {
        await importWithConflict(2);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: old, 'x (2)': sized(fresh), y: sized(extra) } });
        expect((await getSnapshotOrders())['a.com']).toEqual(['x', 'x (2)', 'y']);
      });

      it('keeps changes another page made while the conflict dialog was open', async () => {
        await setSnapshots({ 'a.com': { x: old } });
        await setSnapshotOrders({ 'a.com': ['x'] });
        await loadOptions();
        importFile({ size: 100, text: () => Promise.resolve(JSON.stringify({ 'a.com': { x: fresh, y: extra } })) });
        await waitFor(() => dialog());

        // The popup saves a snapshot meanwhile.
        await setSnapshots({ 'a.com': { x: old, popup: old }, 'p.com': { p: old } });
        await setSnapshotOrders({ 'a.com': ['x', 'popup'], 'p.com': ['p'] });

        dialog().querySelectorAll('button')[1].click();
        await waitFor(() => status().textContent.startsWith('インポートしました'));

        expect(await getSnapshots()).toEqual({ 'a.com': { x: old, popup: old, y: sized(extra) }, 'p.com': { p: old } });
        expect(await getSnapshotOrders()).toEqual({ 'a.com': ['x', 'popup', 'y'], 'p.com': ['p'] });
      });

      it('cancel changes nothing', async () => {
        await importWithConflict(3);
        expect(await getSnapshots()).toEqual({ 'a.com': { x: old } });
        expect((await getSnapshotOrders())['a.com']).toEqual(['x']);
      });

      it('asks about a conflict created after the page loaded', async () => {
        await setSnapshots({ 'a.com': { x: old } });
        await loadOptions();
        // Saved by the popup; the page has not seen the event.
        await setSnapshotsFor('a.com', { x: old, y: old });

        importFile({ size: 100, text: () => Promise.resolve(JSON.stringify({ 'a.com': { y: fresh } })) });
        await waitFor(() => dialog());

        expect(dialog().textContent).toContain('a.com / y');
      });
    });

    it('import reads and writes only the file\'s hosts', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } }, 'b.com': { z: { savedAt: SAVED } } });
      await loadOptions();
      const get = vi.spyOn(chrome.storage.local, 'get');
      const set = vi.spyOn(chrome.storage.local, 'set');

      importFile({ size: 100, text: () => Promise.resolve(JSON.stringify({ 'a.com': { y: { savedAt: SAVED } } })) });
      await waitFor(() => status().textContent.startsWith('インポートしました'));

      expect(set.mock.calls.some(([items]) => 'snapshots/b.com' in items)).toBe(false);
      // Only the render after the merge reads every host.
      const lastSet = Math.max(...set.mock.invocationCallOrder);
      const readsOfB = get.mock.invocationCallOrder.filter((_, i) => {
        const keys = get.mock.calls[i][0];
        return keys == null || [keys].flat().includes('snapshots/b.com');
      });
      expect(readsOfB.every(order => order > lastSet)).toBe(true);
      expect(rowNames(domainItems()[0])).toEqual(['x', 'y']);
    });

    it('a multi-host import writes the changed hosts, the index and the orders in one set', async () => {
      const old = { savedAt: SAVED };
      await setSnapshots({ 'a.com': { x: old }, 'b.com': { z: old } });
      await setSnapshotOrders({ 'a.com': ['x'], 'b.com': ['z'] });
      await loadOptions();
      const set = vi.spyOn(chrome.storage.local, 'set');

      const file = { 'a.com': { y: old }, 'b.com': { z: { savedAt: '2024-02-02T00:00:00.000Z' } }, 'c.com': { w: old } };
      importFile({ size: 100, text: () => Promise.resolve(JSON.stringify(file)) });
      await waitFor(() => dialog());
      dialog().querySelectorAll('button')[1].click();
      await waitFor(() => status().textContent.startsWith('インポートしました'));

      expect(set).toHaveBeenCalledTimes(1);
      const [items] = set.mock.calls[0];
      expect(Object.keys(items).sort()).toEqual(['snapshotHosts', 'snapshotOrder', 'snapshots/a.com', 'snapshots/c.com']);
      expect(items.snapshotHosts).toEqual(['a.com', 'b.com', 'c.com']);
      expect(await getSnapshotOrders()).toEqual({ 'a.com': ['x', 'y'], 'b.com': ['z'], 'c.com': ['w'] });
    });

    it('an import whose write fails shows the error and leaves storage and the list as they were', async () => {
      const old = { savedAt: SAVED };
      const before = { 'a.com': { x: old }, 'b.com': { z: old } };
      await setSnapshots(before);
      await setSnapshotOrders({ 'a.com': ['x'], 'b.com': ['z'] });
      await loadOptions();
      const set = chrome.storage.local.set.bind(chrome.storage.local);
      vi.spyOn(chrome.storage.local, 'set').mockImplementation(async items => {
        if ('snapshots/b.com' in items) throw new Error('QUOTA_BYTES quota exceeded');
        return set(items);
      });

      const file = { 'a.com': { y: old }, 'b.com': { w: old } };
      importFile({ size: 100, text: () => Promise.resolve(JSON.stringify(file)) });
      await waitFor(() => status().textContent === MESSAGES.ja.error_import_failed);

      expect(status().className).toContain('error');
      expect(document.getElementById('importFile').value).toBe('');
      expect(await getSnapshots()).toEqual(before);
      expect(await getSnapshotOrders()).toEqual({ 'a.com': ['x'], 'b.com': ['z'] });
      expect(domainNames()).toEqual(['a.com', 'b.com']);
      expect(rowNames(domainItems()[0])).toEqual(['x']);
    });

    it('exporting one snapshot reads one host', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } }, 'b.com': { z: { savedAt: SAVED } } });
      await loadOptions();
      const get = vi.spyOn(chrome.storage.local, 'get');

      domainItems()[0].querySelector('.snapshot-row[data-name="x"] .btn-export').click();
      await flush();

      expect(downloads).toHaveLength(1);
      expect(snapshotReads(get)).toEqual([['snapshots/a.com']]);
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

    it('after adding, lists and passes on the stored groups, including one added elsewhere meanwhile', async () => {
      await setSnapshots({ 'app.example.com': { x: { savedAt: SAVED } }, 'app.other.org': { y: { savedAt: SAVED } } });
      await loadOptions();
      const chips = () => Object.fromEntries(domainItems().map(item => [
        item.querySelector('.domain-name').textContent,
        item.querySelector('.group-chip')?.textContent ?? null,
      ]));

      await submitGroup('example.com');
      await chrome.storage.local.set({ groups: ['other.org'] });
      await answer(true);

      expect((await chrome.storage.local.get('groups')).groups).toEqual(['other.org', 'example.com']);
      expect(groupNames()).toEqual(['other.org', 'example.com']);
      expect(chips()).toEqual({ 'app.example.com': 'グループ: example.com', 'app.other.org': 'グループ: other.org' });
    });

    it('still adds the group when the permission prompt is denied, and says so', async () => {
      await loadOptions();
      const request = vi.spyOn(chrome.permissions, 'request').mockResolvedValue(false);

      await submitGroup('example.com');
      await answer(true);

      expect(request).toHaveBeenCalledWith({ origins: ['*://example.com/*', '*://*.example.com/*'] });
      expect((await chrome.storage.local.get('groups')).groups).toEqual(['example.com']);
      expect([...chrome._state.grantedOrigins]).toEqual([]);
      expect(groupNames()).toEqual(['example.com']);
      expect(status().className).toContain('success');
      expect(status().textContent).toBe(MESSAGES.ja.status_group_added_no_permission.replace('{group}', 'example.com'));
    });

    it('adds nothing and shows an error when the permission request fails', async () => {
      await loadOptions();
      vi.spyOn(chrome.permissions, 'request').mockRejectedValue(new Error('This function must be called during a user gesture'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await submitGroup('example.com');
      await answer(true);

      expect((await chrome.storage.local.get('groups')).groups ?? []).toEqual([]);
      expect(groupNames()).toEqual([]);
      expect(status().className).toContain('error');
      expect(status().textContent).toBe(MESSAGES.ja.error_group_failed);
      consoleError.mockRestore();
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
      await setBackups({ 'app.example.com': { savedAt: SAVED, activeName: null } });
      const read = async () => ({ snapshots: await getSnapshots(), orders: await getSnapshotOrders(), backups: await getBackups() });
      const before = await read();
      await loadOptions();

      await submitGroup('example.com');
      await answer(true);

      expect(await read()).toEqual(before);
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

  describe('page state', () => {
    const SAVED = '2024-01-01T00:00:00.000Z';

    it('changing the sort reads no snapshot key', async () => {
      await setSnapshots({
        'a.com': { small: { savedAt: SAVED } },
        'b.com': { big: { savedAt: SAVED, localStorage: { k: 'x'.repeat(1000) } } },
      });
      await loadOptions();
      expect(domainNames()).toEqual(['a.com', 'b.com']);
      const get = vi.spyOn(chrome.storage.local, 'get');

      await setSort('size');

      expect(domainNames()).toEqual(['b.com', 'a.com']);
      expect(snapshotReads(get)).toEqual([]);
    });

    it('a snapshot saved elsewhere appears on the next render', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();

      await setSnapshotsFor('b.com', { y: { savedAt: SAVED } });
      chrome._deliverStorageEvents();
      await setSort('size');

      expect(domainNames()).toContain('b.com');
      expect(rowNames(domainItems().find(item => item.querySelector('.domain-name').textContent === 'b.com'))).toEqual(['y']);
    });

    it('a change that lands during the first load is not lost', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      const held = chrome._holdGet(keys => keys.includes('snapshotHosts'));
      await loadOptions();

      await setSnapshotsFor('b.com', { y: { savedAt: SAVED } });
      chrome._deliverStorageEvents();
      held.release();
      await flush();
      expect(domainNames()).toEqual(['a.com']);

      await setSort('name');
      expect(domainNames()).toEqual(['a.com', 'b.com']);
    });

    it('a reorder shows on the next render', async () => {
      await setSnapshots({ 'a.com': { first: { savedAt: SAVED }, second: { savedAt: SAVED } } });
      await setSnapshotOrders({ 'a.com': ['first', 'second'] });
      await loadOptions();

      const list = document.querySelector('.domain-snapshots');
      const [firstRow, secondRow] = [...list.querySelectorAll('.snapshot-row')];
      list.insertBefore(secondRow, firstRow);
      list.dispatchEvent(new Event('drop', { bubbles: true }));
      await flush();
      await setSort('name');

      expect(rowNames(domainItems()[0])).toEqual(['second', 'first']);
    });

    it('a rename shows on the next render', async () => {
      await setSnapshots({ 'a.com': { first: { savedAt: SAVED }, second: { savedAt: SAVED } } });
      await setSnapshotOrders({ 'a.com': ['second', 'first'] });
      await loadOptions();

      const row = document.querySelector('.snapshot-row[data-name="first"]');
      row.querySelector('.snapshot-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = row.querySelector('.snapshot-name-input');
      input.value = 'renamed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();
      await setSort('name');

      expect(rowNames(domainItems()[0])).toEqual(['second', 'renamed']);
    });

    it('render right after import shows the imported snapshots', async () => {
      await setSnapshots({ 'a.com': { existing: { savedAt: SAVED } } });
      await loadOptions();

      const input = document.getElementById('importFile');
      const text = JSON.stringify({ 'a.com': { imported: { savedAt: SAVED } }, 'n.com': { n: { savedAt: SAVED } } });
      Object.defineProperty(input, 'files', { value: [{ size: text.length, text: async () => text }], configurable: true });
      input.dispatchEvent(new Event('change'));
      await vi.waitFor(() => {
        if (!document.getElementById('statusMsg').textContent.startsWith('インポートしました')) throw new Error('not yet');
      });

      expect(domainNames()).toEqual(['a.com', 'n.com']);
      expect(rowNames(domainItems()[0])).toEqual(['existing', 'imported']);
    });

    it('clear all empties the list before the event arrives', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();

      document.getElementById('clearAllBtn').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(chrome._state.storageEvents.length).toBeGreaterThan(0);
      expect(domainItems()).toHaveLength(0);
      expect(document.querySelector('.empty-state')).not.toBeNull();
    });

    it('group chips update right after add and remove, with no snapshot read', async () => {
      await setSnapshots({ 'app.example.com': { a: { savedAt: SAVED } } });
      await loadOptions();
      const get = vi.spyOn(chrome.storage.local, 'get');
      const confirm = async () => {
        await flush();
        document.querySelector('.tk3-btn-confirm').click();
        await flush();
        await flush();
      };

      document.getElementById('groupInput').value = 'example.com';
      document.getElementById('groupForm').requestSubmit();
      await confirm();
      expect(document.querySelector('.group-chip')?.textContent).toBe('グループ: example.com');

      document.querySelector('#groupList .group-item .btn-icon').click();
      await confirm();
      expect(document.querySelector('.group-chip')).toBeNull();
      expect(document.querySelector('#groupList .group-empty')).not.toBeNull();

      expect(snapshotReads(get)).toEqual([]);
    });

    it('a backup written elsewhere shows in the meter on the next render', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: SAVED } } });
      await loadOptions();
      const backupSegment = () => document.querySelector('#meterBar .meter-segment--backups');
      expect(Number(backupSegment().dataset.bytes)).toBe(0);

      await setBackup('a.com', { savedAt: SAVED, activeName: null, localStorage: { k: 'v' } });
      await setSort('size');

      const expected = await chrome.storage.local.getBytesInUse(['backups/a.com']);
      expect(expected).toBeGreaterThan(0);
      expect(Number(backupSegment().dataset.bytes)).toBe(expected);
    });
  });

  describe('storage from an older version', () => {
    const SAVED = '2024-01-01T00:00:00.000Z';

    it('legacy data shows on the first open', async () => {
      const x = { savedAt: SAVED, localStorage: { k: 'v' } };
      await chrome.storage.local.set({
        snapshots: { 'a.com': { x, y: { savedAt: SAVED } }, 'b.com': { z: { savedAt: SAVED } } },
        backups: { 'a.com': { savedAt: SAVED, activeName: null } },
        snapshotOrder: { 'a.com': ['y', 'x'] },
      });

      await loadOptions();

      expect(domainItems().map(item => item.querySelector('.domain-name').textContent)).toEqual(['a.com', 'b.com']);
      expect([...domainItems()[0].querySelectorAll('.snapshot-row')].map(r => r.dataset.name)).toEqual(['y', 'x']);
      expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
      expect((await getSnapshots())['a.com'].x).toEqual({ ...x, bytes: byteSize(x) });
      expect(await getBackups()).toEqual({ 'a.com': { savedAt: SAVED, activeName: null } });
    });

    it('a failed migration keeps the old keys and the page still works', async () => {
      await chrome.storage.local.set({ snapshots: { 'a.com': { x: { savedAt: SAVED } } } });
      await setSnapshotsFor('b.com', { z: { savedAt: SAVED } });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const remove = vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('I/O error'));

      await loadOptions();

      expect(logged).toHaveBeenCalled();
      expect(document.body.dataset.ready).toBe('true');
      expect(domainNames()).toContain('b.com');
      expect(await chrome.storage.local.get('snapshots')).toHaveProperty('snapshots');
      remove.mockRestore();

      const toggle = document.getElementById('toggleAutoReload');
      toggle.click();
      await flush();
      expect((await getSettings()).autoReload).toBe(false);
    });

    it('the next open retries the migration and keeps the per-host data', async () => {
      await chrome.storage.local.set({ snapshots: { 'a.com': { x: { savedAt: SAVED } } } });
      await setSnapshotsFor('b.com', { z: { savedAt: SAVED } });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const remove = vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('I/O error'));
      await loadOptions();
      expect(logged).toHaveBeenCalled();
      remove.mockRestore();
      logged.mockRestore();
      const before = structuredClone({ a: chrome._state.storage['snapshots/a.com'], b: chrome._state.storage['snapshots/b.com'] });

      await loadOptions();

      expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
      expect(chrome._state.storage['snapshots/a.com']).toEqual(before.a);
      expect(chrome._state.storage['snapshots/b.com']).toEqual(before.b);
      expect(await getSnapshotHosts()).toEqual(['b.com', 'a.com']);
      expect(domainNames()).toEqual(['a.com', 'b.com']);
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
      expect(await getBackups()).toEqual({});
      expect(await chrome.storage.local.get(['snapshotOrder', 'activeSnapshots']))
        .toEqual({ snapshotOrder: {}, activeSnapshots: {} });
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
