import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setSnapshots } from '../support/storage-seed.js';
import { viewerUrl, openViewer } from '../../lib/viewer-link.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const viewerHtml = readFileSync(path.join(repoRoot, 'viewer/viewer.html'), 'utf-8');
const bodyHtml = viewerHtml.match(/<body>([\s\S]*)<\/body>/)[1];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

const $ = id => document.getElementById(id);
const HOST = 'example.com';
const SAVED_AT = '2024-01-01T00:00:00.000Z';

function cookie(name, value, extra = {}) {
  return { name, value, domain: HOST, path: '/', secure: true, httpOnly: false, sameSite: 'lax', ...extra };
}

function idb(records, store = {}, version = 1) {
  return { app: { version, stores: { items: { keyPath: 'id', autoIncrement: false, records, ...store } } } };
}

const baseSnapshot = (extra = {}) => ({
  savedAt: SAVED_AT,
  memo: 'work account',
  color: 'blue',
  cookies: [cookie('sid', 'secret-sid')],
  localStorage: { token: 'secret-token', theme: 'dark' },
  sessionStorage: { tab: 'tab-one-value' },
  indexedDB: idb([{ id: 1, name: 'alpha' }]),
  ...extra,
});

// The page data each tab's content script reports, by tab id.
let pages;

function mockContentScript() {
  chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
    if (message.type !== 'getStorageData' || !pages[tabId]) {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    const out = {};
    for (const [type, on] of Object.entries(message.types)) {
      if (on && pages[tabId][type] !== undefined) out[type] = structuredClone(pages[tabId][type]);
    }
    return out;
  });
}

async function loadViewer(target) {
  const search = typeof target === 'string' ? target : new URL(viewerUrl(target)).search;
  history.replaceState(null, '', `/viewer/viewer.html${search}`);
  document.body.removeAttribute('data-ready');
  document.body.innerHTML = bodyHtml;
  vi.resetModules();
  await import('../../viewer/viewer.js');
  await vi.waitFor(() => expect(document.body.dataset.ready).toBe('true'));
  await settle();
}

async function selectCompare(value) {
  const select = $('compareSelect');
  select.value = value;
  select.dispatchEvent(new Event('change'));
  await settle();
}

async function setToggle(id, checked) {
  $(id).checked = checked;
  $(id).dispatchEvent(new Event('change'));
  await settle();
}

const typeSection = type => document.querySelector(`#types [data-type="${type}"]`);
const bodyRows = section => [...section.querySelectorAll(':scope > .section-body > .rows-scroll > table > tbody > tr')];
const storeSection = name => document.querySelector(`#types [data-store="${name}"]`);
const summaryText = section => section.querySelector(':scope > summary').textContent;
const rowByKey = (type, key) => bodyRows(typeSection(type)).find(tr => tr.querySelector('.cell-mono')?.textContent === key);
const noteText = () => $('compareNote').textContent;
const statusRows = (section, status) => section.querySelectorAll(`tr.status-${status}`);

async function openSection(section) {
  section.open = true;
  section.dispatchEvent(new Event('toggle'));
  await flush();
}

async function closeSection(section) {
  section.open = false;
  section.dispatchEvent(new Event('toggle'));
  await flush();
}

const manyKeys = (n, value = i => `v${i}`) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(4, '0')}`, value(i)]));

describe('lib/viewer-link.js', () => {
  it('builds the viewer URL with the host, name and tab, and opens it in a tab', async () => {
    const url = viewerUrl({ host: HOST, name: 'a&b', tabId: 7 });
    expect(url.startsWith(chrome.runtime.getURL('viewer/viewer.html?'))).toBe(true);
    const params = new URL(url).searchParams;
    expect([params.get('host'), params.get('name'), params.get('tab')]).toEqual([HOST, 'a&b', '7']);
    expect(new URL(viewerUrl({ host: HOST, name: 'x' })).searchParams.has('tab')).toBe(false);

    await openViewer({ host: HOST, name: 'x' });
    expect(chrome._state.createdTabs).toEqual([{ url: viewerUrl({ host: HOST, name: 'x' }) }]);
  });
});

describe('viewer/viewer.js', () => {
  beforeEach(() => {
    pages = {};
    mockContentScript();
  });

  describe('header and lookup', () => {
    it('shows header and per-type tables for the snapshot in the URL', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      await loadViewer({ host: HOST, name: 'main' });

      expect($('viewer').classList.contains('hidden')).toBe(false);
      expect($('notFound').classList.contains('hidden')).toBe(true);
      expect($('snapshotName').textContent).toBe('main');
      expect($('snapshotHost').textContent).toBe(HOST);
      expect($('snapshotMemo').textContent).toBe('work account');
      expect($('snapshotChip').classList.contains('snapshot-chip--blue')).toBe(true);
      expect($('snapshotSize').textContent).toMatch(/B$/);
      expect([...document.querySelectorAll('#types > [data-type]')].map(el => el.dataset.type))
        .toEqual(['cookies', 'localStorage', 'sessionStorage', 'indexedDB']);
      expect(summaryText(typeSection('cookies'))).toContain('1 件');
      expect(summaryText(typeSection('localStorage'))).toContain('2 件');
      expect(bodyRows(typeSection('localStorage'))).toHaveLength(2);
    });

    it('missing snapshot shows not-found', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      await loadViewer({ host: HOST, name: 'gone' });
      expect($('notFound').classList.contains('hidden')).toBe(false);
      expect($('viewer').classList.contains('hidden')).toBe(true);
    });

    it('a missing host or name param shows not-found without throwing', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      for (const search of ['?name=main', `?host=${HOST}`, '']) {
        await loadViewer(search);
        expect($('notFound').classList.contains('hidden')).toBe(false);
        expect($('types').children).toHaveLength(0);
      }
    });

    it('a name that exists only on another host shows not-found', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() }, 'other.com': { only: baseSnapshot() } });
      await loadViewer({ host: HOST, name: 'only' });
      expect($('notFound').classList.contains('hidden')).toBe(false);
    });

    it('a name or host of __proto__ shows not-found', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      await loadViewer({ host: HOST, name: '__proto__' });
      expect($('notFound').classList.contains('hidden')).toBe(false);
      expect($('snapshotName').textContent).toBe('');

      await loadViewer({ host: '__proto__', name: 'main' });
      expect($('notFound').classList.contains('hidden')).toBe(false);
      expect($('types').children).toHaveLength(0);
    });

    it('viewerUrl encodes and the viewer decodes names with & = # % and Japanese', async () => {
      const name = 'a&b=c#d%e 日本語+';
      await setSnapshots({ [HOST]: { a: baseSnapshot({ memo: 'decoy' }), [name]: baseSnapshot({ memo: 'target' }) } });
      await loadViewer({ host: HOST, name, tabId: 3 });
      expect($('snapshotName').textContent).toBe(name);
      expect($('snapshotMemo').textContent).toBe('target');
    });

    it('opens a legacy-shaped snapshot and compares it with the current state', async () => {
      const legacy = {
        savedAt: SAVED_AT,
        cookies: [cookie('sid', 'old')],
        localStorage: { token: 'a' },
        indexedDB: idb([{ id: 1, name: 'alpha' }]),
      };
      await setSnapshots({ [HOST]: { legacy } });
      chrome._state.grantedOrigins.add(`*://${HOST}/*`);
      chrome._state.cookies = [cookie('sid', 'new')];
      chrome._state.tabs = [{ id: 7, url: `https://${HOST}/` }];
      pages[7] = { localStorage: { token: 'b' }, indexedDB: idb([{ id: 1, name: 'beta' }]) };
      await loadViewer({ host: HOST, name: 'legacy', tabId: 7 });
      await selectCompare('current');

      expect(statusRows(typeSection('cookies'), 'changed')).toHaveLength(1);
      expect(statusRows(typeSection('localStorage'), 'changed')).toHaveLength(1);
      await openSection(storeSection('items'));
      expect(statusRows(storeSection('items'), 'changed')).toHaveLength(1);
    });
  });

  describe('masking and values', () => {
    beforeEach(async () => {
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot(),
          other: baseSnapshot({ localStorage: { token: 'other-token-value', theme: 'dark' } }),
          many: baseSnapshot({ localStorage: manyKeys(250, i => `value-${i}`) }),
        },
      });
    });

    it('values are masked and absent from the DOM until revealed', async () => {
      await loadViewer({ host: HOST, name: 'main' });
      await openSection(storeSection('items'));
      const html = document.body.innerHTML;
      for (const value of ['secret-token', 'secret-sid', 'dark', 'alpha']) expect(html).not.toContain(value);
      const cell = rowByKey('localStorage', 'token').querySelector('.value');
      expect(cell.textContent).toContain('••••••');
      expect(cell.textContent).toContain('12');
    });

    it('both values of a masked changed row are absent from the DOM', async () => {
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect(rowByKey('localStorage', 'token').classList.contains('status-changed')).toBe(true);
      expect(rowByKey('localStorage', 'token').querySelectorAll('.value')).toHaveLength(2);
      expect(document.body.innerHTML).not.toContain('secret-token');
      expect(document.body.innerHTML).not.toContain('other-token-value');
    });

    it('revealing one cell leaves the others masked', async () => {
      await loadViewer({ host: HOST, name: 'main' });
      rowByKey('localStorage', 'token').querySelector('.value-mask').click();
      expect(rowByKey('localStorage', 'token').querySelector('.value').textContent).toBe('secret-token');
      expect(rowByKey('localStorage', 'theme').querySelector('.value-mask')).not.toBeNull();
      expect(document.body.innerHTML).not.toContain('secret-sid');
    });

    it('revealToggle reveals every rendered cell', async () => {
      await loadViewer({ host: HOST, name: 'main' });
      await setToggle('revealToggle', true);
      expect(document.querySelectorAll('#types .value-mask')).toHaveLength(0);
      for (const value of ['secret-token', 'secret-sid', 'dark', 'tab-one-value']) expect(document.body.innerHTML).toContain(value);
    });

    it('turning the reveal toggle off removes values from innerHTML', async () => {
      await loadViewer({ host: HOST, name: 'main' });
      rowByKey('localStorage', 'theme').querySelector('.value-mask').click();
      await setToggle('revealToggle', true);
      await setToggle('revealToggle', false);
      for (const value of ['secret-token', 'secret-sid', 'dark', 'tab-one-value']) expect(document.body.innerHTML).not.toContain(value);
    });

    it('rows built while the toggle is on are revealed', async () => {
      await loadViewer({ host: HOST, name: 'many' });
      await setToggle('revealToggle', true);

      await openSection(storeSection('items'));
      expect(storeSection('items').textContent).toContain('alpha');

      typeSection('localStorage').querySelector('.more-rows').click();
      expect(bodyRows(typeSection('localStorage'))).toHaveLength(250);
      expect(document.body.innerHTML).toContain('value-249');

      await selectCompare('snapshot:main');
      expect(document.querySelectorAll('#types .value-mask')).toHaveLength(0);
      expect(document.body.innerHTML).toContain('value-0');
    });

    it('a re-render with the toggle off masks a cell revealed by click', async () => {
      await loadViewer({ host: HOST, name: 'main' });
      rowByKey('localStorage', 'token').querySelector('.value-mask').click();
      await selectCompare('snapshot:other');
      expect(document.body.innerHTML).not.toContain('secret-token');

      rowByKey('localStorage', 'token').querySelector('.value-mask').click();
      expect(document.body.innerHTML).toContain('secret-token');
      await setToggle('diffOnlyToggle', false);
      expect(document.body.innerHTML).not.toContain('secret-token');
    });

    it('"さらに表示" keeps a cell revealed by click and adds masked rows', async () => {
      await loadViewer({ host: HOST, name: 'many' });
      rowByKey('localStorage', 'k0000').querySelector('.value-mask').click();
      typeSection('localStorage').querySelector('.more-rows').click();
      expect(rowByKey('localStorage', 'k0000').querySelector('.value').textContent).toBe('value-0');
      expect(rowByKey('localStorage', 'k0249').querySelector('.value-mask')).not.toBeNull();
      expect(document.body.innerHTML).not.toContain('value-249');
    });

    it('long values are truncated and expand on demand', async () => {
      await setSnapshots({ [HOST]: { long: baseSnapshot({ localStorage: { big: 'x'.repeat(250) } }) } });
      await loadViewer({ host: HOST, name: 'long' });
      await setToggle('revealToggle', true);
      const cell = rowByKey('localStorage', 'big').querySelector('.value');
      expect(cell.querySelector('.value-text').textContent).toHaveLength(200);
      cell.querySelector('.value-expand').click();
      expect(cell.querySelector('.value-text').textContent).toHaveLength(250);
      expect(cell.querySelector('.value-expand')).toBeNull();
      expect(cell.querySelector('.value-capped')).toBeNull();
    });

    it('expand stops at 100000 with a note', async () => {
      await setSnapshots({ [HOST]: { huge: baseSnapshot({ localStorage: { big: 'y'.repeat(100050) } }) } });
      await loadViewer({ host: HOST, name: 'huge' });
      await setToggle('revealToggle', true);
      const cell = rowByKey('localStorage', 'big').querySelector('.value');
      cell.querySelector('.value-expand').click();
      expect(cell.querySelector('.value-text').textContent).toHaveLength(100000);
      expect(cell.querySelector('.value-capped')).not.toBeNull();
    });

    it('renders values as text', async () => {
      const evil = '<img src=x onerror="globalThis.pwned=1">';
      await setSnapshots({ [HOST]: { evil: baseSnapshot({ localStorage: { [evil]: evil } }) } });
      await loadViewer({ host: HOST, name: 'evil' });
      await setToggle('revealToggle', true);
      expect(document.querySelector('#types img')).toBeNull();
      expect(rowByKey('localStorage', evil).querySelector('.value').textContent).toBe(evil);
    });
  });

  describe('rendering', () => {
    it('caps rows at 200 and adds more on request', async () => {
      await setSnapshots({ [HOST]: { many: baseSnapshot({ localStorage: manyKeys(450) }) } });
      await loadViewer({ host: HOST, name: 'many' });
      const section = typeSection('localStorage');
      const more = section.querySelector('.more-rows');
      expect(bodyRows(section)).toHaveLength(200);
      expect(more.textContent).toContain('250');
      more.click();
      expect(bodyRows(section)).toHaveLength(400);
      more.click();
      expect(bodyRows(section)).toHaveLength(450);
      expect(more.classList.contains('hidden')).toBe(true);
    });

    it('details render on first open only', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot({ indexedDB: idb([{ id: 1 }, { id: 2 }]) }) } });
      await loadViewer({ host: HOST, name: 'main' });
      const store = storeSection('items');
      expect(store.open).toBe(false);
      expect(store.querySelectorAll('tr')).toHaveLength(0);
      await openSection(store);
      expect(bodyRows(store)).toHaveLength(2);
      await closeSection(store);
      await openSection(store);
      expect(bodyRows(store)).toHaveLength(2);
    });

    it('IndexedDB stores show their schema and flag a difference', async () => {
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot(),
          other: baseSnapshot({ indexedDB: idb([{ key: 1 }], { keyPath: 'key', autoIncrement: true }, 2) }),
        },
      });
      await loadViewer({ host: HOST, name: 'main' });
      expect(summaryText(storeSection('items'))).toContain('v1 · keyPath: id · autoIncrement: false');
      expect(storeSection('items').querySelector('.section-flag')).toBeNull();

      await selectCompare('snapshot:other');
      const flag = storeSection('items').querySelector('.section-flag');
      expect(flag.textContent).toContain('v2 · keyPath: key · autoIncrement: true');
    });

    it('stores and databases only one side has are flagged, even when empty', async () => {
      const dbs = (stores, extraDbs = {}) => ({ app: { version: 1, stores }, ...extraDbs });
      const items = { keyPath: 'id', autoIncrement: false, records: [{ id: 1 }] };
      const empty = { keyPath: 'id', autoIncrement: false, records: [] };
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot({ indexedDB: dbs({ items, onlyHere: empty }, { oldDb: { version: 1, stores: {} } }) }),
          other: baseSnapshot({ indexedDB: dbs({ items, onlyThere: empty }, { newDb: { version: 2, stores: { s: empty } } }) }),
        },
      });
      await loadViewer({ host: HOST, name: 'main' });
      expect(document.querySelectorAll('#types .section-flag')).toHaveLength(0);

      await selectCompare('snapshot:other');
      const flagOf = el => el.querySelector(':scope > summary .section-flag')?.textContent ?? null;
      const dbSection = name => document.querySelector(`#types [data-database="${name}"]`);
      expect(flagOf(storeSection('onlyHere'))).toBe('−削除');
      expect(flagOf(storeSection('onlyThere'))).toBe('+追加');
      expect(flagOf(storeSection('items'))).toBeNull();
      expect(flagOf(dbSection('oldDb'))).toBe('−削除');
      expect(flagOf(dbSection('newDb'))).toBe('+追加');
      expect(flagOf(dbSection('app'))).toBeNull();
      expect(flagOf(storeSection('s'))).toBeNull();
      expect(summaryText(storeSection('onlyThere'))).toContain('+0 −0 ~0');

      await selectCompare('none');
      expect(document.querySelectorAll('#types .section-flag')).toHaveLength(0);
    });

    it('databases are not flagged when IndexedDB is not comparable', async () => {
      const { indexedDB: _drop, ...noIdb } = baseSnapshot();
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: noIdb } });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect(summaryText(typeSection('indexedDB'))).toContain('比べられません');
      expect(document.querySelectorAll('#types .section-flag')).toHaveLength(0);
    });

    it('a store keyed by the whole record masks its keys', async () => {
      const tokens = { keyPath: '', autoIncrement: false, records: ['secret-token-a', 'secret-token-b'] };
      await setSnapshots({ [HOST]: { main: baseSnapshot({ indexedDB: { app: { version: 1, stores: { tokens } } } }) } });
      await loadViewer({ host: HOST, name: 'main' });
      await openSection(storeSection('tokens'));

      expect(bodyRows(storeSection('tokens'))).toHaveLength(2);
      expect(document.body.innerHTML).not.toContain('secret-token-a');
      const keyCell = bodyRows(storeSection('tokens'))[0].firstElementChild;
      expect(keyCell.querySelector('.value-mask')).not.toBeNull();
      keyCell.querySelector('.value-mask').click();
      expect(keyCell.textContent).toBe('"secret-token-a"');

      await setToggle('revealToggle', true);
      expect(document.body.innerHTML).toContain('secret-token-b');
      await setToggle('revealToggle', false);
      expect(document.body.innerHTML).not.toContain('secret-token');
    });

    it('types the snapshot lacks are not shown', async () => {
      await setSnapshots({ [HOST]: { only: { savedAt: SAVED_AT, localStorage: { a: '1' } } } });
      await loadViewer({ host: HOST, name: 'only' });
      expect([...document.querySelectorAll('#types > [data-type]')].map(el => el.dataset.type)).toEqual(['localStorage']);
    });

    it('open and closed sections survive a re-render', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: baseSnapshot({ localStorage: { token: 'x' } }) } });
      await loadViewer({ host: HOST, name: 'main' });
      await openSection(storeSection('items'));
      await closeSection(typeSection('sessionStorage'));
      await selectCompare('snapshot:other');
      await setToggle('diffOnlyToggle', false);

      expect(storeSection('items').open).toBe(true);
      expect(typeSection('sessionStorage').open).toBe(false);
      expect(typeSection('localStorage').open).toBe(true);
    });
  });

  describe('compare with a snapshot', () => {
    it('compares with another snapshot of the host', async () => {
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot(),
          other: baseSnapshot({ localStorage: { token: 'changed', fresh: 'new' } }),
        },
      });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');

      const section = typeSection('localStorage');
      expect(rowByKey('localStorage', 'token').classList.contains('status-changed')).toBe(true);
      expect(rowByKey('localStorage', 'theme').classList.contains('status-removed')).toBe(true);
      expect(rowByKey('localStorage', 'fresh').classList.contains('status-added')).toBe(true);
      expect(section.querySelector('.section-counts').textContent).toBe('+1 −1 ~1');
      expect(rowByKey('localStorage', 'token').querySelector('.cell-status').textContent).toContain('変更');
      expect($('diffOnlyControl').classList.contains('hidden')).toBe(false);
    });

    it('the compare select lists the other snapshots in the saved order', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot(), b: baseSnapshot(), a: baseSnapshot(), c: baseSnapshot() } });
      await chrome.storage.local.set({ snapshotOrder: { [HOST]: ['c', 'main', 'a'] } });
      await loadViewer({ host: HOST, name: 'main' });
      const options = [...$('compareSelect').options];
      expect(options.map(o => o.value)).toEqual(['none', 'current', 'snapshot:c', 'snapshot:a', 'snapshot:b']);
      expect(options.slice(2).map(o => o.textContent)).toEqual(['c', 'a', 'b']);
    });

    it('diff-only hides same rows and the 200 cap applies after filtering', async () => {
      const same = manyKeys(300);
      const changed = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`c${String(i).padStart(4, '0')}`, `a${i}`]));
      const changedOther = Object.fromEntries(Object.keys(changed).map(key => [key, `${changed[key]}!`]));
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot({ localStorage: { ...same, ...changed } }),
          other: baseSnapshot({ localStorage: { ...same, ...changedOther } }),
        },
      });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect($('diffOnlyToggle').checked).toBe(true);

      let section = typeSection('localStorage');
      expect(bodyRows(section)).toHaveLength(200);
      expect(bodyRows(section).every(tr => tr.classList.contains('status-changed'))).toBe(true);
      section.querySelector('.more-rows').click();
      expect(bodyRows(section)).toHaveLength(250);
      expect(section.querySelector('.more-rows').classList.contains('hidden')).toBe(true);

      await setToggle('diffOnlyToggle', false);
      section = typeSection('localStorage');
      expect(bodyRows(section)).toHaveLength(200);
      expect(bodyRows(section).some(tr => !tr.className)).toBe(true);
      expect(section.querySelector('.more-rows').textContent).toContain('350');
    });

    it('summary counts cover rows beyond the cap', async () => {
      const before = manyKeys(250, i => `a${i}`);
      const after = manyKeys(250, i => `b${i}`);
      await setSnapshots({ [HOST]: { main: baseSnapshot({ localStorage: before }), other: baseSnapshot({ localStorage: after }) } });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect(bodyRows(typeSection('localStorage'))).toHaveLength(200);
      expect(typeSection('localStorage').querySelector('.section-counts').textContent).toBe('+0 −0 ~250');
    });

    it('selecting なし clears status marks', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: baseSnapshot({ localStorage: { token: 'x' } }) } });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect(document.querySelectorAll('#types tr[class*="status-"]').length).toBeGreaterThan(0);

      await selectCompare('none');
      expect(document.querySelectorAll('#types tr[class*="status-"]')).toHaveLength(0);
      expect(document.querySelectorAll('#types .cell-status')).toHaveLength(0);
      expect(document.querySelectorAll('#types .section-counts')).toHaveLength(0);
      expect($('compareNote').classList.contains('hidden')).toBe(true);
      expect($('diffOnlyControl').classList.contains('hidden')).toBe(true);
    });

    it('two snapshots with different cookieDomain compare within the narrower scope', async () => {
      await chrome.storage.local.set({ groups: [HOST] });
      await setSnapshots({
        [HOST]: {
          grouped: baseSnapshot({
            cookieDomain: HOST,
            cookies: [cookie('sid', 'a'), cookie('appc', 'x', { domain: `app.${HOST}` })],
          }),
          hostOnly: baseSnapshot({
            cookies: [cookie('sid', 'b'), cookie('stray', 'y', { domain: `sub.${HOST}` })],
          }),
        },
      });
      await loadViewer({ host: HOST, name: 'grouped' });
      await selectCompare('snapshot:hostOnly');
      await setToggle('diffOnlyToggle', false);

      const section = typeSection('cookies');
      expect(rowByKey('cookies', 'sid').classList.contains('status-changed')).toBe(true);
      const appc = rowByKey('cookies', 'appc');
      expect(appc.classList.contains('status-notCompared')).toBe(true);
      expect(appc.querySelector('.cell-status').textContent).toContain('範囲外');
      expect(appc.textContent).not.toContain('読み込まない');
      expect(rowByKey('cookies', 'stray')).toBeUndefined();
      expect(statusRows(section, 'added')).toHaveLength(0);
      expect(statusRows(section, 'removed')).toHaveLength(0);
      expect(section.querySelector('.section-counts').textContent).toBe('+0 −0 ~1');
      expect(noteText()).toContain(`${HOST} だけ`);
      expect(noteText()).toContain('このスナップショット 1 件・相手 1 件');
    });

    it('a type the other snapshot lacks is not comparable', async () => {
      const { cookies: _cookies, ...noCookies } = baseSnapshot();
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: noCookies } });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect(summaryText(typeSection('cookies'))).toContain('比べられません（相手にこの種類のデータがありません）');
      expect(typeSection('localStorage').querySelector('.section-counts')).not.toBeNull();
    });

    it('cookies are not comparable when the scopes do not overlap', async () => {
      await setSnapshots({
        [`app.${HOST}`]: {
          main: baseSnapshot({ cookieDomain: `app.${HOST}`, cookies: [cookie('a', '1', { domain: `app.${HOST}` })] }),
          other: baseSnapshot({ cookieDomain: `api.${HOST}`, cookies: [cookie('a', '2', { domain: `api.${HOST}` })] }),
        },
      });
      await chrome.storage.local.set({ groups: [HOST] });
      await loadViewer({ host: `app.${HOST}`, name: 'main' });
      await selectCompare('snapshot:other');
      expect(summaryText(typeSection('cookies'))).toContain('比べられません');
      expect(noteText()).toContain('重ならない');
    });
  });

  describe('compare with the current state', () => {
    beforeEach(() => {
      chrome._state.grantedOrigins.add(`*://${HOST}/*`);
      chrome._state.cookies = [cookie('sid', 'secret-sid')];
    });

    const currentPage = (extra = {}) => ({
      localStorage: { token: 'secret-token', theme: 'light' },
      sessionStorage: { tab: 'tab-one-value' },
      indexedDB: idb([{ id: 1, name: 'beta' }]),
      ...extra,
    });

    it('compares with the current state using the tab param', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 7, url: `https://${HOST}/app` }];
      pages[7] = currentPage();
      await loadViewer({ host: HOST, name: 'main', tabId: 7 });
      await selectCompare('current');

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'getStorageData', digest: false }));
      expect(rowByKey('localStorage', 'theme').classList.contains('status-changed')).toBe(true);
      await openSection(storeSection('items'));
      expect(statusRows(storeSection('items'), 'changed')).toHaveLength(1);
      expect(noteText()).toContain(`https://${HOST}`);
    });

    it('prefers the tab param over another qualifying tab', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }, { id: 7, url: `http://${HOST}:8080/` }];
      pages[5] = currentPage({ localStorage: { token: 'secret-token', theme: 'dark' } });
      pages[7] = currentPage();
      await loadViewer({ host: HOST, name: 'main', tabId: 7 });
      await selectCompare('current');

      expect(chrome.tabs.sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([7, 7]);
      expect(rowByKey('localStorage', 'theme').classList.contains('status-changed')).toBe(true);
      expect(noteText()).toContain(`http://${HOST}:8080`);
    });

    it('finds a tab of the host when no tab param is given', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 4, url: 'https://other.com/' }, { id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');
      expect(chrome.tabs.sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([5, 5]);
    });

    it('ignores a tab param that left the host', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 7, url: 'https://other.com/' }, { id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      await loadViewer({ host: HOST, name: 'main', tabId: 7 });
      await selectCompare('current');
      expect(chrome.tabs.sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([5, 5]);
    });

    it('ignores a tab param whose tab was closed', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const get = vi.spyOn(chrome.tabs, 'get');
      await loadViewer({ host: HOST, name: 'main', tabId: 99 });
      await selectCompare('current');
      expect(get).toHaveBeenCalledWith(99);
      expect(chrome.tabs.sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([5, 5]);
    });

    it('a non-numeric tab param is ignored', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const get = vi.spyOn(chrome.tabs, 'get');
      await loadViewer(`?host=${HOST}&name=main&tab=abc`);
      await selectCompare('current');
      expect(get).not.toHaveBeenCalledWith('abc');
      expect(get.mock.calls.every(([id]) => id === 5)).toBe(true);
      expect(chrome.tabs.sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([5, 5]);
    });

    it.each([
      ['an incognito tab', { url: `https://${HOST}/`, incognito: true }],
      ['a discarded tab', { url: `https://${HOST}/`, discarded: true }],
      ['an unloaded tab', { url: `https://${HOST}/`, status: 'unloaded' }],
      ['a tab without a url', {}],
      ['a tab with an invalid url', { url: 'not a url' }],
      ['a non-http tab', { url: `file:///${HOST}/index.html` }],
      ['a sibling-subdomain tab', { url: `https://app.${HOST}/` }],
    ])('skips %s', async (_label, tab) => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, ...tab }];
      pages[5] = currentPage();
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      for (const type of ['localStorage', 'sessionStorage', 'indexedDB']) {
        expect(summaryText(typeSection(type))).toContain('比べられません');
      }
    });

    it('an incognito tab param is not replaced by another tab', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 7, url: `https://${HOST}/`, incognito: true }, { id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      pages[7] = currentPage();
      const getAll = vi.spyOn(chrome.cookies, 'getAll');
      await loadViewer({ host: HOST, name: 'main', tabId: 7 });
      await selectCompare('current');

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(getAll).not.toHaveBeenCalled();
      expect(noteText()).toContain('シークレットウィンドウ');
      for (const type of ['cookies', 'localStorage', 'sessionStorage', 'indexedDB']) {
        expect(summaryText(typeSection(type))).toContain('比べられません');
      }
    });

    it('an incognito tab param on another host of the group reads nothing', async () => {
      const app = `app.${HOST}`;
      await chrome.storage.local.set({ groups: [HOST] });
      chrome._state.grantedOrigins.add(`*://*.${HOST}/*`);
      await setSnapshots({ [app]: { main: baseSnapshot({ cookies: [cookie('sid', 'x', { domain: app })] }) } });
      chrome._state.tabs = [{ id: 7, url: `https://${HOST}/`, incognito: true }, { id: 5, url: `https://${app}/` }];
      pages[5] = currentPage();
      const getAll = vi.spyOn(chrome.cookies, 'getAll');
      await loadViewer({ host: app, name: 'main', tabId: 7 });
      await selectCompare('current');

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(getAll).not.toHaveBeenCalled();
      expect(noteText()).toContain('シークレットウィンドウ');
    });

    it('a group-saved snapshot compares with the current group cookies', async () => {
      const app = `app.${HOST}`;
      await chrome.storage.local.set({ groups: [HOST] });
      chrome._state.grantedOrigins.add(`*://*.${HOST}/*`);
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot({
            cookieDomain: HOST,
            cookies: [cookie('sid', 'a'), cookie('appc', 'x', { domain: app }), cookie('keep', 'same', { domain: app })],
          }),
        },
      });
      chrome._state.cookies = [cookie('sid', 'a'), cookie('appc', 'y', { domain: app }), cookie('keep', 'same', { domain: app })];
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      const section = typeSection('cookies');
      expect(rowByKey('cookies', 'appc').classList.contains('status-changed')).toBe(true);
      expect(statusRows(section, 'added')).toHaveLength(0);
      expect(statusRows(section, 'removed')).toHaveLength(0);
      expect(section.querySelector('.section-counts').textContent).toBe('+0 −0 ~1');
    });

    it('without host permission cookies are not compared and no prompt is shown', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.grantedOrigins.clear();
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const request = vi.spyOn(chrome.permissions, 'request');
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      expect(request).not.toHaveBeenCalled();
      expect(summaryText(typeSection('cookies'))).toContain('比べられません');
      expect(noteText()).toContain('許可されていない');
      expect(typeSection('localStorage').querySelector('.section-counts')).not.toBeNull();
    });

    it('without a reachable tab page data is not comparable', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.cookies = [cookie('sid', 'changed')];
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      for (const type of ['localStorage', 'sessionStorage', 'indexedDB']) {
        expect(summaryText(typeSection(type))).toContain('比べられません');
      }
      expect(document.querySelectorAll('#types tr.status-removed')).toHaveLength(0);
      expect(typeSection('cookies').querySelector('.section-counts').textContent).toBe('+0 −0 ~1');
      expect(noteText()).toContain(`${HOST} を開いているタブがない`);
    });

    it('a failed IndexedDB read keeps the web storage diff', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const plain = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        if (message.types?.indexedDB) throw new Error('Message length exceeded maximum allowed length.');
        return plain(tabId, message);
      });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      expect(typeSection('localStorage').querySelector('.section-counts').textContent).toBe('+0 −0 ~1');
      expect(summaryText(typeSection('indexedDB'))).toContain('比べられません');
      expect(typeSection('indexedDB').querySelectorAll('tr.status-removed')).toHaveLength(0);
      expect(noteText()).toContain('IndexedDB');
    });

    it('a qualifying tab without a content script makes all page types unreadable', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      expect(chrome.tabs.sendMessage).toHaveBeenCalled();
      for (const type of ['localStorage', 'sessionStorage', 'indexedDB']) {
        expect(summaryText(typeSection(type))).toContain('比べられません（タブから読めませんでした）');
        expect(typeSection(type).querySelectorAll('tr.status-removed')).toHaveLength(0);
      }
      expect(noteText()).toContain(`https://${HOST} のタブから読めなかったデータがあります（localStorage, sessionStorage, IndexedDB）`);
      expect(typeSection('cookies').querySelector('.section-counts')).not.toBeNull();
    });

    it('page data is dropped when the tab moved to another site during the read', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = { localStorage: { token: 'evil-token' }, sessionStorage: {}, indexedDB: {} };
      const plain = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        const reply = await plain(tabId, message);
        chrome._state.tabs[0].url = 'https://evil.test/';
        return reply;
      });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      for (const type of ['localStorage', 'sessionStorage', 'indexedDB']) {
        expect(summaryText(typeSection(type))).toContain('比べられません');
      }
      expect(document.querySelectorAll('#types tr.status-removed, #types tr.status-added, #types tr.status-changed'))
        .toHaveLength(0);
      expect(noteText()).toContain('読めなかったデータ');
    });

    it('a tab that stayed on the site keeps its page data', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const plain = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        const reply = await plain(tabId, message);
        chrome._state.tabs[0].url = `https://${HOST}/other-page`;
        return reply;
      });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');
      expect(rowByKey('localStorage', 'theme').classList.contains('status-changed')).toBe(true);
    });

    it.each([
      ['closed during the read', tabs => { tabs.length = 0; }],
      ['moved to another origin of the host', tabs => { tabs[0].url = `http://${HOST}/`; }],
    ])('page data is dropped when the tab %s', async (_label, change) => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const plain = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = vi.fn(async (tabId, message) => {
        const reply = await plain(tabId, message);
        change(chrome._state.tabs);
        return reply;
      });
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      for (const type of ['localStorage', 'sessionStorage', 'indexedDB']) {
        expect(summaryText(typeSection(type))).toContain('比べられません');
      }
      expect(noteText()).toContain('読めなかったデータ');
    });

    it('a failed read shows the error note and plain tables', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: baseSnapshot({ localStorage: { token: 'x' } }) } });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      expect(document.querySelectorAll('#types tr[class*="status-"]').length).toBeGreaterThan(0);

      chrome.tabs.query = vi.fn(async () => { throw new Error('boom'); });
      await selectCompare('current');

      expect(error).toHaveBeenCalled();
      expect($('compareSelect').value).toBe('current');
      expect(noteText()).toBe('比べられませんでした');
      expect($('compareNote').classList.contains('error')).toBe(true);
      expect($('compareNote').classList.contains('hidden')).toBe(false);
      expect(document.querySelectorAll('#types tr[class*="status-"]')).toHaveLength(0);
      expect(document.querySelectorAll('#types .cell-status')).toHaveLength(0);
      expect(document.querySelectorAll('#types .section-counts')).toHaveLength(0);
      expect($('diffOnlyControl').classList.contains('hidden')).toBe(true);
      error.mockRestore();
    });

    it('a stale run that rejects after a newer selection is ignored', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: baseSnapshot({ localStorage: { token: 'x' } }) } });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      let reject;
      chrome.tabs.query = vi.fn(() => new Promise((_, r) => { reject = r; }));
      await loadViewer({ host: HOST, name: 'main' });

      const select = $('compareSelect');
      select.value = 'current';
      select.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(chrome.tabs.query).toHaveBeenCalled());
      await selectCompare('snapshot:other');
      reject(new Error('late'));
      await settle();

      expect(error).not.toHaveBeenCalled();
      expect($('compareNote').classList.contains('error')).toBe(false);
      expect(rowByKey('localStorage', 'token').classList.contains('status-changed')).toBe(true);
      error.mockRestore();
    });

    it('a cookie that differs only in its flags shows the change', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.cookies = [cookie('sid', 'secret-sid', { secure: false })];
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      const row = rowByKey('cookies', 'sid');
      expect(row.classList.contains('status-changed')).toBe(true);
      expect(row.lastElementChild.textContent).toContain('Secure lax → lax');
    });

    it('an empty current state is all removed', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = { localStorage: {} };
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('current');

      expect(statusRows(typeSection('localStorage'), 'removed')).toHaveLength(2);
      expect(typeSection('localStorage').querySelector('.section-counts').textContent).toBe('+0 −2 ~0');
    });

    it('a late compare result does not overwrite a newer selection', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot() } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      let resolve;
      const reply = new Promise(r => { resolve = r; });
      chrome.tabs.sendMessage = vi.fn(() => reply);
      await loadViewer({ host: HOST, name: 'main' });

      const select = $('compareSelect');
      select.value = 'current';
      select.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());
      await selectCompare('none');
      resolve(currentPage({ localStorage: {} }));
      await settle();

      expect(document.querySelectorAll('#types tr[class*="status-"]')).toHaveLength(0);
      expect($('compareNote').classList.contains('hidden')).toBe(true);
    });

    it('tags expired, volatile and not-loaded cookies', async () => {
      await setSnapshots({
        [HOST]: {
          main: baseSnapshot({
            cookies: [
              cookie('old', '1', { expirationDate: 1000 }),
              cookie('csrf', '2'),
              cookie('deep', '3', { domain: `sub.${HOST}` }),
              cookie('plain', '4'),
            ],
          }),
        },
      });
      await chrome.storage.local.set({ volatileCookies: { [HOST]: { [`${HOST}|/|csrf`]: 'value' } } });
      await loadViewer({ host: HOST, name: 'main' });

      expect(rowByKey('cookies', 'old').textContent).toContain('期限切れ');
      expect(rowByKey('cookies', 'csrf').textContent).toContain('自動で変わる');
      expect(rowByKey('cookies', 'deep').textContent).toContain('読み込まない');
      expect(rowByKey('cookies', 'plain').querySelectorAll('.tag')).toHaveLength(0);
    });

    it('never writes', async () => {
      await setSnapshots({ [HOST]: { main: baseSnapshot(), other: baseSnapshot({ localStorage: { token: 'x' } }) } });
      chrome._state.tabs = [{ id: 5, url: `https://${HOST}/` }];
      pages[5] = currentPage();
      const spies = [
        vi.spyOn(chrome.storage.local, 'set'),
        vi.spyOn(chrome.storage.local, 'remove'),
        vi.spyOn(chrome.storage.local, 'clear'),
        vi.spyOn(chrome.cookies, 'set'),
        vi.spyOn(chrome.cookies, 'remove'),
      ];
      await loadViewer({ host: HOST, name: 'main' });
      await selectCompare('snapshot:other');
      await selectCompare('current');
      chrome._state.grantedOrigins.clear();
      await selectCompare('none');
      await selectCompare('current');

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(chrome.tabs.sendMessage).toHaveBeenCalled();
      expect(chrome.tabs.sendMessage.mock.calls.every(([, message]) => message.type === 'getStorageData')).toBe(true);
      expect(summaryText(typeSection('cookies'))).toContain('比べられません');
    });
  });
});
