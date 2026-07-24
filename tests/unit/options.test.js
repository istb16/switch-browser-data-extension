import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setSnapshots, setSnapshotOrders, getSnapshots, getSnapshotOrders, setSettings } from '../../lib/storage.js';

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

  it('reflects saved settings in the data-type toggles and persists changes on save', async () => {
    await setSettings({ enabledTypes: { cookies: false, localStorage: true, sessionStorage: false, indexedDB: true } });
    await loadOptions();

    expect(document.getElementById('toggleCookies').checked).toBe(false);
    expect(document.getElementById('toggleLocalStorage').checked).toBe(true);

    document.getElementById('toggleCookies').checked = true;
    document.getElementById('saveSettingsBtn').click();
    await flush();

    const { getSettings } = await import('../../lib/storage.js');
    expect((await getSettings()).enabledTypes.cookies).toBe(true);
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

  describe('clearing all data', () => {
    it('deletes everything after confirming', async () => {
      await setSnapshots({ 'a.com': { x: { savedAt: '2024-01-01T00:00:00.000Z' } } });
      await loadOptions();

      document.getElementById('clearAllBtn').click();
      await flush();
      document.querySelector('.tk3-btn-confirm').click();
      await flush();

      expect(await getSnapshots()).toEqual({});
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
