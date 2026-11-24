import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  orderedNames,
  withSnapshotLock,
  saveSnapshot,
  deleteSnapshot,
  renameSnapshot,
  setSnapshotOrder,
  loadSnapshot,
  updateSnapshotDetails,
  replaceSnapshotFields,
  migrateStorage, SCHEMA_VERSION,
  saveBackup,
  clearAllData,
} from '../../lib/snapshot.js';
import {
  getSnapshots, getSnapshotOrders, setSnapshotOrders, getSettings, setSettings, getGroups, setGroups,
  getSnapshotHosts, getBackupHosts, getActiveSnapshots,
} from '../../lib/storage.js';
import { setSnapshots, getBackups } from '../support/storage-seed.js';
import { byteSize } from '../../lib/snapshot-summary.js';
import { removeGroup } from '../../lib/groups.js';

const SAVED = '2024-01-01T00:00:00.000Z';

async function snapshotsOf(domain) {
  return (await getSnapshots())[domain] ?? {};
}

describe('lib/snapshot', () => {
  it('saveSnapshot stores data with a savedAt timestamp and appends to the order', async () => {
    await saveSnapshot('example.com', 'first', { cookies: [] });
    const snapshots = await getSnapshots();
    expect(snapshots['example.com'].first.cookies).toEqual([]);
    expect(typeof snapshots['example.com'].first.savedAt).toBe('string');

    const orders = await getSnapshotOrders();
    expect(orders['example.com']).toEqual(['first']);
  });

  it('saveSnapshot does not duplicate an existing name in the order on overwrite', async () => {
    await saveSnapshot('example.com', 'first', { cookies: [] });
    await saveSnapshot('example.com', 'first', { cookies: [{ name: 'a' }] });
    const orders = await getSnapshotOrders();
    expect(orders['example.com']).toEqual(['first']);
    const snapshots = await snapshotsOf('example.com');
    expect(snapshots.first.cookies).toEqual([{ name: 'a' }]);
  });

  it('replaceSnapshotFields replaces and removes only the given fields, keeping the memo', async () => {
    await saveSnapshot('example.com', 'first', { cookies: [{ name: 'old' }], cookieDomain: 'example.com', localStorage: { a: '1' } }, { memo: 'note' });
    expect(await replaceSnapshotFields('example.com', 'first', { cookies: [{ name: 'new' }] }, ['cookieDomain'])).toBe(true);

    const { first } = await snapshotsOf('example.com');
    expect(first.cookies).toEqual([{ name: 'new' }]);
    expect('cookieDomain' in first).toBe(false);
    expect(first.localStorage).toEqual({ a: '1' });
    expect(first.memo).toBe('note');
  });

  it('replaceSnapshotFields writes nothing when the snapshot is gone', async () => {
    await saveSnapshot('example.com', 'other', { cookies: [] });
    expect(await replaceSnapshotFields('example.com', 'first', { cookies: [] }, [])).toBe(false);
    expect(Object.keys(await snapshotsOf('example.com'))).toEqual(['other']);
  });

  it('orderedNames drops stale names and appends the unordered ones sorted', () => {
    expect(orderedNames({ a: {}, b: {}, c: {} }, ['c', 'gone'])).toEqual(['c', 'a', 'b']);
    expect(orderedNames(undefined, ['x'])).toEqual([]);
    expect(orderedNames({ b: {}, a: {} }, undefined)).toEqual(['a', 'b']);
  });

  describe('with Web Locks', () => {
    let restore;

    beforeEach(() => {
      // A minimal exclusive lock: each request waits for the previous one.
      let tail = Promise.resolve();
      const locks = {
        request: vi.fn((name, task) => {
          const run = tail.then(() => task());
          tail = run.catch(() => {});
          return run;
        }),
      };
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
      restore = () => {
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else delete navigator.locks;
      };
    });

    afterEach(() => restore());

    it('concurrent writes from two pages all persist', async () => {
      await Promise.all([
        saveSnapshot('example.com', 'a', {}),
        saveSnapshot('example.com', 'b', {}),
        withSnapshotLock(async () => {
          const snapshots = await getSnapshots();
          snapshots['other.com'] = { c: { savedAt: '2024-01-01T00:00:00.000Z' } };
          await setSnapshots(snapshots);
        }),
        renameSnapshot('example.com', 'a', 'renamed'),
      ]);

      expect(Object.keys((await getSnapshots())['example.com']).sort()).toEqual(['b', 'renamed']);
      expect((await getSnapshots())['other.com']).toHaveProperty('c');
      expect((await getSnapshotOrders())['example.com']).toEqual(['renamed', 'b']);
      expect(navigator.locks.request).toHaveBeenCalledTimes(4);
      expect(navigator.locks.request.mock.calls.every(([name]) => name === 'snapshots')).toBe(true);
    });

    it('setting the active snapshot and renaming at once both persist', async () => {
      const { setActiveSnapshot } = await import('../../lib/snapshot.js');
      const { setActiveSnapshots, getActiveSnapshots } = await import('../../lib/storage.js');
      await saveSnapshot('example.com', 'a', {});
      await setActiveSnapshots({ 'example.com': 'a' });

      await Promise.all([
        renameSnapshot('example.com', 'a', 'renamed'),
        setActiveSnapshot('other.com', 'x'),
      ]);

      expect(await getActiveSnapshots()).toEqual({ 'example.com': 'renamed', 'other.com': 'x' });
    });

    for (const order of ['switch first', 'rename first']) {
      it(`concurrent setActiveSnapshot and renameSnapshot leave previous consistent (${order})`, async () => {
        const { setActiveSnapshot } = await import('../../lib/snapshot.js');
        const { setActiveSnapshots, getActiveSnapshots, getPreviousSnapshots } = await import('../../lib/storage.js');
        await saveSnapshot('example.com', 'a', {});
        await saveSnapshot('example.com', 'b', {});
        await setActiveSnapshots({ 'example.com': 'a' });

        const tasks = [
          () => setActiveSnapshot('example.com', 'b'),
          () => renameSnapshot('example.com', 'a', 'renamed'),
        ];
        if (order === 'rename first') tasks.reverse();
        await Promise.all(tasks.map(task => task()));

        expect(await getActiveSnapshots()).toEqual({ 'example.com': 'b' });
        expect(await getPreviousSnapshots()).toEqual({ 'example.com': { host: 'example.com', name: 'renamed' } });
      });
    }

    for (const order of ['switch first', 'delete first']) {
      it(`concurrent setActiveSnapshot and deleteSnapshot of the previous leave no previous (${order})`, async () => {
        const { setActiveSnapshot } = await import('../../lib/snapshot.js');
        const { setActiveSnapshots, getActiveSnapshots, getPreviousSnapshots, getSnapshotsFor } = await import('../../lib/storage.js');
        await saveSnapshot('example.com', 'a', {});
        await saveSnapshot('example.com', 'b', {});
        await setActiveSnapshots({ 'example.com': 'a' });

        const tasks = [
          () => setActiveSnapshot('example.com', 'b'),
          () => deleteSnapshot('example.com', 'a'),
        ];
        if (order === 'delete first') tasks.reverse();
        await Promise.all(tasks.map(task => task()));

        expect(await getActiveSnapshots()).toEqual({ 'example.com': 'b' });
        expect((await getPreviousSnapshots())['example.com']).toBeUndefined();
        expect(Object.keys((await getSnapshotsFor(['example.com']))['example.com'])).toEqual(['b']);
      });
    }

    it('a backup saved while all data is cleared does not bring the old backups back', async () => {
      const { saveBackup, clearAllData } = await import('../../lib/snapshot.js');
      const { getBackups } = await import('../support/storage-seed.js');
      await saveBackup('old.com', {}, null);

      // saveBackup starts first: without the lock it reads old.com before the clear and writes it back after.
      await Promise.all([saveBackup('a.com', {}, null), clearAllData()]);

      expect(Object.keys(await getBackups())).toEqual([]);
    });
  });

  it('setSnapshotOrder replaces one domain\'s order and keeps the others', async () => {
    await setSnapshotOrders({ 'a.com': ['x'], 'b.com': ['y', 'z'] });
    await setSnapshotOrder('b.com', ['z', 'y']);
    expect(await getSnapshotOrders()).toEqual({ 'a.com': ['x'], 'b.com': ['z', 'y'] });
  });

  it('deleteSnapshot removes the snapshot and its order entry', async () => {
    await saveSnapshot('example.com', 'a', {});
    await saveSnapshot('example.com', 'b', {});
    await deleteSnapshot('example.com', 'a');

    expect(await snapshotsOf('example.com')).toEqual(expect.not.objectContaining({ a: expect.anything() }));
    const orders = await getSnapshotOrders();
    expect(orders['example.com']).toEqual(['b']);
  });

  it('deleteSnapshot removes the domain entirely once its last snapshot is gone', async () => {
    await saveSnapshot('example.com', 'only', {});
    await deleteSnapshot('example.com', 'only');

    const snapshots = await getSnapshots();
    expect(snapshots).not.toHaveProperty('example.com');
    const orders = await getSnapshotOrders();
    expect(orders).not.toHaveProperty('example.com');
  });

  it('renameSnapshot moves the data under the new name and preserves order position', async () => {
    await saveSnapshot('example.com', 'a', { value: 1 });
    await saveSnapshot('example.com', 'b', { value: 2 });
    await setSnapshotOrder('example.com', ['a', 'b']);

    await renameSnapshot('example.com', 'a', 'renamed');

    const snapshots = await snapshotsOf('example.com');
    expect(snapshots).not.toHaveProperty('a');
    expect(snapshots.renamed.value).toBe(1);

    const orders = await getSnapshotOrders();
    expect(orders['example.com']).toEqual(['renamed', 'b']);
  });

  it('renameSnapshot throws when the new name already exists', async () => {
    await saveSnapshot('example.com', 'a', {});
    await saveSnapshot('example.com', 'b', {});
    await expect(renameSnapshot('example.com', 'a', 'b')).rejects.toThrow('duplicate');
  });

  it('saveSnapshot keeps memo and color on overwrite', async () => {
    await saveSnapshot('example.com', 'a', { cookies: [] }, { memo: 'admin', color: 'red' });
    await saveSnapshot('example.com', 'a', { cookies: [{ name: 'x' }] });
    const { a } = await snapshotsOf('example.com');
    expect(a).toMatchObject({ memo: 'admin', color: 'red', cookies: [{ name: 'x' }] });

    await saveSnapshot('example.com', 'a', { cookies: [] }, { color: 'blue' });
    expect((await loadSnapshot('example.com', 'a'))).toMatchObject({ memo: 'admin', color: 'blue' });
  });

  it('saveSnapshot and updateSnapshotDetails store cleaned details', async () => {
    const long = 'x'.repeat(101);
    await saveSnapshot('example.com', 'a', {}, { memo: long, color: 'pink' });
    let a = await loadSnapshot('example.com', 'a');
    expect(a.memo).toBe('x'.repeat(100));
    expect(a).not.toHaveProperty('color');

    await updateSnapshotDetails('example.com', 'a', { memo: 'line one\nline two', color: 'pink' });
    a = await loadSnapshot('example.com', 'a');
    expect(a.memo).toBe('line one line two');
    expect(a).not.toHaveProperty('color');

    await updateSnapshotDetails('example.com', 'a', { memo: long, color: 'green' });
    a = await loadSnapshot('example.com', 'a');
    expect(a.memo).toHaveLength(100);
    expect(a.color).toBe('green');
  });

  it('updateSnapshotDetails clears memo/color', async () => {
    await saveSnapshot('example.com', 'a', { value: 1 }, { memo: 'm', color: 'amber' });
    await updateSnapshotDetails('example.com', 'a', { memo: '', color: '' });
    const a = await loadSnapshot('example.com', 'a');
    expect(a).not.toHaveProperty('memo');
    expect(a).not.toHaveProperty('color');
    expect(a.value).toBe(1);
  });

  it('loadSnapshot returns the stored snapshot or null', async () => {
    await saveSnapshot('example.com', 'a', { value: 42 });
    expect((await loadSnapshot('example.com', 'a')).value).toBe(42);
    expect(await loadSnapshot('example.com', 'missing')).toBeNull();
  });
});

describe('lib/snapshot — active snapshot and backup', () => {
  const activeOf = async domain => (await getActiveSnapshots())[domain] ?? null;

  it('records the active snapshot per domain and clears it with null', async () => {
    const { setActiveSnapshot } = await import('../../lib/snapshot.js');
    expect(await activeOf('a.com')).toBeNull();
    await setActiveSnapshot('a.com', 'x');
    expect(await activeOf('a.com')).toBe('x');
    await setActiveSnapshot('a.com', null);
    expect(await activeOf('a.com')).toBeNull();
  });

  it('deleting the active snapshot clears it; deleting another one keeps it', async () => {
    const { setActiveSnapshot } = await import('../../lib/snapshot.js');
    await saveSnapshot('a.com', 'x', {});
    await saveSnapshot('a.com', 'y', {});
    await setActiveSnapshot('a.com', 'x');

    await deleteSnapshot('a.com', 'y');
    expect(await activeOf('a.com')).toBe('x');
    await deleteSnapshot('a.com', 'x');
    expect(await activeOf('a.com')).toBeNull();
  });

  it('renaming the active snapshot keeps it active under the new name', async () => {
    const { setActiveSnapshot } = await import('../../lib/snapshot.js');
    await saveSnapshot('a.com', 'x', {});
    await setActiveSnapshot('a.com', 'x');
    await renameSnapshot('a.com', 'x', 'z');
    expect(await activeOf('a.com')).toBe('z');
  });

  it('deleteSnapshot clears a group reference to it', async () => {
    const { setActiveSnapshots } = await import('../../lib/storage.js');
    await saveSnapshot('app.example.com', 'x', {});
    await saveSnapshot('app.example.com', 'y', {});
    await saveSnapshot('example.com', 'x', {});
    await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'x' } });

    await deleteSnapshot('example.com', 'x');
    await deleteSnapshot('app.example.com', 'y');
    expect(await activeOf('example.com')).toEqual({ host: 'app.example.com', name: 'x' });

    await deleteSnapshot('app.example.com', 'x');
    expect(await activeOf('example.com')).toBeNull();
  });

  it('renameSnapshot renames a group reference to it', async () => {
    const { setActiveSnapshots } = await import('../../lib/storage.js');
    await saveSnapshot('app.example.com', 'x', {});
    await saveSnapshot('www.example.com', 'x', {});
    await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'x' } });

    await renameSnapshot('www.example.com', 'x', 'w');
    expect(await activeOf('example.com')).toEqual({ host: 'app.example.com', name: 'x' });
    await renameSnapshot('app.example.com', 'x', 'z');
    expect(await activeOf('example.com')).toEqual({ host: 'app.example.com', name: 'z' });
  });

  it('renameSnapshot keeps the applied types of the active record', async () => {
    const { setActiveSnapshots } = await import('../../lib/storage.js');
    await saveSnapshot('a.com', 'x', {});
    await saveSnapshot('app.example.com', 'x', {});
    await setActiveSnapshots({
      'a.com': { host: 'a.com', name: 'x', types: ['cookies'] },
      'example.com': { host: 'app.example.com', name: 'x', types: ['localStorage'] },
    });

    await renameSnapshot('a.com', 'x', 'z');
    await renameSnapshot('app.example.com', 'x', 'w');

    expect(await activeOf('a.com')).toEqual({ host: 'a.com', name: 'z', types: ['cookies'] });
    expect(await activeOf('example.com'))
      .toEqual({ host: 'app.example.com', name: 'w', types: ['localStorage'] });
  });

  it('deleteSnapshot removes an active record that has types', async () => {
    const { getActiveSnapshots, setActiveSnapshots } = await import('../../lib/storage.js');
    await saveSnapshot('a.com', 'x', {});
    await saveSnapshot('a.com', 'y', {});
    await setActiveSnapshots({ 'a.com': { host: 'a.com', name: 'x', types: ['cookies'] } });

    await deleteSnapshot('a.com', 'y');
    expect(await getActiveSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'x', types: ['cookies'] } });
    await deleteSnapshot('a.com', 'x');
    expect(await getActiveSnapshots()).toEqual({});
  });

  it('keeps one backup per domain, apart from the snapshots', async () => {
    const { saveBackup, getBackup } = await import('../../lib/snapshot.js');
    expect(await getBackup('a.com')).toBeNull();
    await saveBackup('a.com', { localStorage: { a: '1' } }, 'x');
    await saveBackup('a.com', { localStorage: { a: '2' } }, null);
    const backup = await getBackup('a.com');
    expect(backup.localStorage).toEqual({ a: '2' });
    expect(backup.activeName).toBeNull();
    expect(typeof backup.savedAt).toBe('string');
    expect(await getSnapshots()).toEqual({});
  });
});

describe('lib/snapshot — previous snapshot', () => {
  async function setup() {
    const { setActiveSnapshot } = await import('../../lib/snapshot.js');
    const storage = await import('../../lib/storage.js');
    return { setActiveSnapshot, ...storage };
  }

  it('records the previous snapshot on a change to another one', async () => {
    const { setActiveSnapshot, setActiveSnapshots, getPreviousSnapshots } = await setup();
    await setActiveSnapshot('a.com', 'x');
    await setActiveSnapshot('a.com', 'y');
    expect(await getPreviousSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'x' } });

    await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'x' } });
    await setActiveSnapshot('example.com', { host: 'www.example.com', name: 'x' });
    expect((await getPreviousSnapshots())['example.com']).toEqual({ host: 'app.example.com', name: 'x' });
  });

  it('a partial active record becomes previous without its types', async () => {
    const { setActiveSnapshot, setActiveSnapshots, getPreviousSnapshots } = await setup();
    await setActiveSnapshots({ 'a.com': { host: 'a.com', name: 'x', types: ['cookies'] } });
    await setActiveSnapshot('a.com', 'y');
    expect(await getPreviousSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'x' } });
  });

  it('the same snapshot or a change of types only keeps previous', async () => {
    const { setActiveSnapshot, setActiveSnapshots, setPreviousSnapshots, getPreviousSnapshots } = await setup();
    const previous = { 'a.com': { host: 'a.com', name: 'p' } };
    await setPreviousSnapshots(previous);
    await setActiveSnapshots({ 'a.com': 'x' });

    await setActiveSnapshot('a.com', 'x');
    await setActiveSnapshot('a.com', { host: 'a.com', name: 'x', types: ['cookies'] });
    await setActiveSnapshot('a.com', { host: 'a.com', name: 'x', types: ['cookies', 'localStorage'] });
    await setActiveSnapshot('a.com', 'x');

    expect(await getPreviousSnapshots()).toEqual(previous);
  });

  it('clearing the active record keeps previous', async () => {
    const { setActiveSnapshot, setActiveSnapshots, setPreviousSnapshots, getPreviousSnapshots } = await setup();
    await setPreviousSnapshots({ 'a.com': { host: 'a.com', name: 'p' } });
    await setActiveSnapshots({ 'a.com': 'x' });
    await setActiveSnapshot('a.com', null);
    expect(await getPreviousSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'p' } });
  });

  it('no active record → a snapshot keeps previous, and writes none when there is none', async () => {
    const { setActiveSnapshot, setPreviousSnapshots, getPreviousSnapshots } = await setup();
    await setActiveSnapshot('b.com', 'y');
    expect('previousSnapshots' in chrome._state.storage).toBe(false);

    await setPreviousSnapshots({ 'a.com': { host: 'a.com', name: 'p' } });
    await setActiveSnapshot('a.com', 'y');
    expect(await getPreviousSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'p' } });
  });

  it('a clear then an undo keeps previous', async () => {
    const { setActiveSnapshot, setActiveSnapshots, setPreviousSnapshots, getPreviousSnapshots, getActiveSnapshots } = await setup();
    await setPreviousSnapshots({ 'a.com': { host: 'a.com', name: 'p' } });
    await setActiveSnapshots({ 'a.com': 'x' });
    await setActiveSnapshot('a.com', null);
    await setActiveSnapshot('a.com', 'x');
    expect(await getActiveSnapshots()).toEqual({ 'a.com': 'x' });
    expect(await getPreviousSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'p' } });
  });

  it('the active and previous records go out in one set', async () => {
    const { setActiveSnapshot, setActiveSnapshots } = await setup();
    await setActiveSnapshots({ 'a.com': 'x' });
    const set = vi.spyOn(chrome.storage.local, 'set');

    await setActiveSnapshot('a.com', 'y');

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toEqual({
      activeSnapshots: { 'a.com': 'y' },
      previousSnapshots: { 'a.com': { host: 'a.com', name: 'x' } },
    });
    set.mockRestore();
  });

  it('rename and delete rewrite previousSnapshots', async () => {
    const { setPreviousSnapshots, getPreviousSnapshots } = await setup();
    await saveSnapshot('a.com', 'x', {});
    await saveSnapshot('app.example.com', 'x', {});
    await setPreviousSnapshots({
      'a.com': { host: 'a.com', name: 'x' },
      'example.com': { host: 'app.example.com', name: 'x' },
    });

    await renameSnapshot('a.com', 'x', 'z');
    await renameSnapshot('app.example.com', 'x', 'w');
    expect(await getPreviousSnapshots()).toEqual({
      'a.com': { host: 'a.com', name: 'z' },
      'example.com': { host: 'app.example.com', name: 'w' },
    });

    await deleteSnapshot('app.example.com', 'w');
    expect(await getPreviousSnapshots()).toEqual({ 'a.com': { host: 'a.com', name: 'z' } });
  });

  // a.com/x is referenced by a bare active name, by a group's { host, name } active
  // record (a.com taken as a group member here) and by a previous record; the
  // other references point at a.com/y or at x of another host.
  async function seedRefs() {
    const { setActiveSnapshots, setPreviousSnapshots } = await setup();
    await saveSnapshot('a.com', 'x', {});
    await saveSnapshot('a.com', 'y', {});
    await saveSnapshot('b.com', 'x', {});
    await setActiveSnapshots({
      'a.com': 'x',
      'group.com': { host: 'a.com', name: 'x' },
      'b.com': 'x',
      'other.com': { host: 'a.com', name: 'y' },
    });
    await setPreviousSnapshots({
      'a.com': { host: 'a.com', name: 'x' },
      'b.com': { host: 'b.com', name: 'x' },
      'c.com': { host: 'a.com', name: 'y' },
    });
  }

  it('renameSnapshot rewrites a bare active name, a { host, name } active ref and the previous ref, and leaves refs to other snapshots alone', async () => {
    const { getActiveSnapshots, getPreviousSnapshots } = await setup();
    await seedRefs();

    await renameSnapshot('a.com', 'x', 'z');

    expect(await getActiveSnapshots()).toEqual({
      'a.com': 'z',
      'group.com': { host: 'a.com', name: 'z' },
      'b.com': 'x',
      'other.com': { host: 'a.com', name: 'y' },
    });
    expect(await getPreviousSnapshots()).toEqual({
      'a.com': { host: 'a.com', name: 'z' },
      'b.com': { host: 'b.com', name: 'x' },
      'c.com': { host: 'a.com', name: 'y' },
    });
  });

  it('deleteSnapshot removes the same three kinds of ref and leaves refs to other snapshots alone', async () => {
    const { getActiveSnapshots, getPreviousSnapshots } = await setup();
    await seedRefs();

    await deleteSnapshot('a.com', 'x');

    expect(await getActiveSnapshots()).toEqual({
      'b.com': 'x',
      'other.com': { host: 'a.com', name: 'y' },
    });
    expect(await getPreviousSnapshots()).toEqual({
      'b.com': { host: 'b.com', name: 'x' },
      'c.com': { host: 'a.com', name: 'y' },
    });
  });
});

describe('lib/snapshot — clearAllData', () => {
  it('empties snapshots, their order, the active snapshots and the backups', async () => {
    const { clearAllData, setActiveSnapshot, saveBackup } = await import('../../lib/snapshot.js');
    await saveSnapshot('a.com', 'x', {});
    await setActiveSnapshot('a.com', 'x');
    await saveBackup('a.com', {}, 'x');

    await clearAllData();

    expect(await getSnapshots()).toEqual({});
    expect(await getBackups()).toEqual({});
    expect(await chrome.storage.local.get(['snapshotOrder', 'activeSnapshots']))
      .toEqual({ snapshotOrder: {}, activeSnapshots: {} });
    expect(Object.keys(chrome._state.storage).filter(key => key.includes('/'))).toEqual([]);
  });

  it('clearAllData removes unlisted and legacy keys too', async () => {
    const { clearAllData } = await import('../../lib/snapshot.js');
    await chrome.storage.local.set({
      'snapshots/x.com': { a: { savedAt: SAVED } },
      'backups/x.com': { savedAt: SAVED },
      snapshots: { 'y.com': {} },
      backups: {},
      language: 'en',
    });
    await setSettings({ ...(await getSettings()), autoReload: false });
    await setGroups(['example.com']);

    await clearAllData();

    expect(Object.keys(chrome._state.storage).sort()).toEqual([
      'activeSnapshots', 'cookieChecks', 'groups', 'language', 'previousSnapshots', 'settings', 'snapshotOrder',
      'volatileCookies',
    ]);
  });

  it('clearAllData empties previousSnapshots and removes commandNotice', async () => {
    const { clearAllData } = await import('../../lib/snapshot.js');
    await chrome.storage.local.set({
      previousSnapshots: { 'a.com': { host: 'a.com', name: 'x' } },
      commandNotice: { tabId: 1, key: 'shortcut_no_previous', until: 0 },
    });

    await clearAllData();

    expect(await chrome.storage.local.get(['previousSnapshots', 'commandNotice']))
      .toEqual({ previousSnapshots: {} });
  });

  it('clearAllData keeps groups and settings', async () => {
    const { clearAllData } = await import('../../lib/snapshot.js');
    const settings = { ...(await getSettings()), autoReload: false };
    await setSettings(settings);
    await setGroups(['example.com']);
    await saveSnapshot('a.com', 'x', {});

    await clearAllData();

    expect(await getGroups()).toEqual(['example.com']);
    expect(await getSettings()).toEqual(settings);
  });
});

describe('lib/snapshot — per-host keys', () => {
  it('save, overwrite and detail edit record bytes', async () => {
    const sizeWithoutBytes = ({ bytes, ...rest }) => byteSize(rest);

    await saveSnapshot('a.com', 'x', { localStorage: { k: 'v' }, bytes: 1 });
    let x = await loadSnapshot('a.com', 'x');
    expect(x.bytes).toBe(sizeWithoutBytes(x));

    await saveSnapshot('a.com', 'x', { localStorage: { k: 'a longer value' } });
    x = await loadSnapshot('a.com', 'x');
    expect(x.bytes).toBe(sizeWithoutBytes(x));

    await updateSnapshotDetails('a.com', 'x', { memo: 'a memo that adds bytes', color: 'red' });
    x = await loadSnapshot('a.com', 'x');
    expect(x.bytes).toBe(sizeWithoutBytes(x));
  });

  it('save writes only that host\'s key', async () => {
    await saveSnapshot('a.com', 'x', {});
    const get = vi.spyOn(chrome.storage.local, 'get');
    const set = vi.spyOn(chrome.storage.local, 'set');

    await saveSnapshot('b.com', 'y', {});

    const keys = [...get.mock.calls.flatMap(([k]) => [k].flat()), ...set.mock.calls.flatMap(([items]) => Object.keys(items))];
    expect(keys).not.toContain('snapshots/a.com');
    expect(await getSnapshotHosts()).toEqual(['a.com', 'b.com']);
  });

  it('rename, delete and detail edit of a missing entry change nothing', async () => {
    await saveSnapshot('a.com', 'x', { value: 1 });
    const before = structuredClone(chrome._state.storage);

    await renameSnapshot('a.com', 'missing', 'new');
    await renameSnapshot('b.com', 'missing', 'new');
    await deleteSnapshot('b.com', 'missing');
    await updateSnapshotDetails('a.com', 'missing', { memo: 'm' });
    await updateSnapshotDetails('b.com', 'missing', { memo: 'm' });

    expect(chrome._state.storage).toEqual(before);
  });

  it('saveBackup writes one host\'s key', async () => {
    await saveBackup('a.com', { localStorage: { a: '1' } }, null);
    const set = vi.spyOn(chrome.storage.local, 'set');

    await saveBackup('b.com', { localStorage: { b: '1' } }, null);

    const written = set.mock.calls.flatMap(([items]) => Object.keys(items));
    expect(written).toContain('backups/b.com');
    expect(written).not.toContain('backups/a.com');
    expect(await getBackupHosts()).toEqual(['a.com', 'b.com']);
  });
});

describe('lib/snapshot — migrateStorage', () => {
  const legacy = () => ({
    snapshots: {
      'a.com': { x: { savedAt: SAVED, localStorage: { k: 'v' } }, y: { savedAt: SAVED } },
      'b.com': { z: { savedAt: SAVED, cookies: [] } },
    },
    backups: { 'a.com': { savedAt: SAVED, activeName: 'x' } },
    snapshotOrder: { 'a.com': ['y', 'x'] },
  });

  it('moves legacy snapshots and backups to per-host keys', async () => {
    const seed = legacy();
    await chrome.storage.local.set(seed);

    await migrateStorage();

    const snapshots = await getSnapshots();
    for (const [host, entries] of Object.entries(seed.snapshots)) {
      for (const [name, snapshot] of Object.entries(entries)) {
        expect(snapshots[host][name]).toEqual({ ...snapshot, bytes: byteSize(snapshot) });
      }
    }
    expect(await getBackups()).toEqual(seed.backups);
    expect(await getSnapshotOrders()).toEqual(seed.snapshotOrder);
    expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
  });

  it('with only legacy backups', async () => {
    await chrome.storage.local.set({ backups: legacy().backups });

    await migrateStorage();

    expect(await getBackups()).toEqual(legacy().backups);
    expect(await getSnapshotHosts()).toEqual([]);
    expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
  });

  it('with snapshots: {}', async () => {
    await chrome.storage.local.set({ snapshots: {} });

    await migrateStorage();

    expect(chrome._state.storage).toEqual({ schemaVersion: SCHEMA_VERSION });
  });

  it('after a failed migration, per-host saves win over the legacy copy, which adds only the names they lack', async () => {
    await saveSnapshot('a.com', 'newer', {});
    await saveSnapshot('a.com', 'x', { localStorage: { k: 'per-host' } });
    await saveBackup('a.com', { localStorage: { newer: '1' } }, null);
    const kept = structuredClone({ s: chrome._state.storage['snapshots/a.com'], b: chrome._state.storage['backups/a.com'] });
    await chrome.storage.local.set({
      snapshots: legacy().snapshots,
      backups: { ...legacy().backups, 'b.com': { savedAt: SAVED, activeName: null } },
    });

    await migrateStorage();

    const a = (await getSnapshots())['a.com'];
    expect(a.newer).toEqual(kept.s.newer);
    expect(a.x).toEqual(kept.s.x);
    expect(a.y).toMatchObject({ savedAt: SAVED });
    expect(Number.isFinite(a.y.bytes)).toBe(true);
    expect(Object.keys(a).sort()).toEqual(['newer', 'x', 'y']);
    expect(Object.keys((await getSnapshots())['b.com'])).toEqual(['z']);
    expect((await getBackups())['a.com']).toEqual(kept.b);
    expect((await getBackups())['b.com']).toEqual({ savedAt: SAVED, activeName: null });
    expect(await getSnapshotHosts()).toEqual(['a.com', 'b.com']);
    expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
  });

  it('on a migrated store writes nothing', async () => {
    await chrome.storage.local.set(legacy());
    await migrateStorage();
    const set = vi.spyOn(chrome.storage.local, 'set');
    const remove = vi.spyOn(chrome.storage.local, 'remove');

    await migrateStorage();

    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('reruns after a crash before the legacy remove', async () => {
    await chrome.storage.local.set(legacy());
    await migrateStorage();
    const once = structuredClone(chrome._state.storage);

    chrome._state.storage = {};
    await chrome.storage.local.set(legacy());
    vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('crash'));
    await expect(migrateStorage()).rejects.toThrow('crash');
    expect(await chrome.storage.local.get('snapshots')).toHaveProperty('snapshots');
    await migrateStorage();

    expect(chrome._state.storage).toEqual(once);
  });

  it('a retry after a failed remove keeps what was saved in between', async () => {
    await chrome.storage.local.set(legacy());
    vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('crash'));
    await expect(migrateStorage()).rejects.toThrow('crash');
    await saveSnapshot('a.com', 'between', { localStorage: { b: '1' } });
    const before = structuredClone({
      a: chrome._state.storage['snapshots/a.com'],
      b: chrome._state.storage['snapshots/b.com'],
      backup: chrome._state.storage['backups/a.com'],
    });

    await migrateStorage();

    expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
    expect(chrome._state.storage['snapshots/a.com']).toEqual(before.a);
    expect(Object.keys(before.a)).toContain('between');
    expect(chrome._state.storage['snapshots/b.com']).toEqual(before.b);
    expect(chrome._state.storage['backups/a.com']).toEqual(before.backup);
    expect(await getSnapshotHosts()).toEqual(['a.com', 'b.com']);
    expect(await getBackupHosts()).toEqual(['a.com']);
  });

  it('a failed migration leaves the legacy keys and can be retried', async () => {
    await chrome.storage.local.set(legacy());
    vi.spyOn(chrome.storage.local, 'set').mockRejectedValueOnce(new Error('quota'));

    await expect(migrateStorage()).rejects.toThrow('quota');
    expect(await chrome.storage.local.get(['snapshots', 'backups', 'schemaVersion'])).toEqual({
      snapshots: legacy().snapshots, backups: legacy().backups,
    });
    expect(await getSnapshotHosts()).toEqual([]);

    await migrateStorage();
    expect(Object.keys(await getSnapshots()).sort()).toEqual(['a.com', 'b.com']);
    expect(await chrome.storage.local.get(['snapshots', 'backups', 'schemaVersion'])).toEqual({ schemaVersion: SCHEMA_VERSION });
  });

  it('drops corrupt legacy snapshots and moves the rest', async () => {
    const ok = { savedAt: SAVED, localStorage: { k: 'v' } };
    await chrome.storage.local.set({ snapshots: { 'a.com': { bad: null, text: 'x', list: [1], ok } } });

    await migrateStorage();

    expect(await getSnapshots()).toEqual({ 'a.com': { ok: { ...ok, bytes: byteSize(ok) } } });
    expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
  });

  it('skips a legacy host whose value is not an object, or has only corrupt entries', async () => {
    const z = { savedAt: SAVED };
    await chrome.storage.local.set({
      snapshots: { 'a.com': 'corrupt', 'n.com': null, 'c.com': { bad: null }, 'b.com': { z } },
      backups: { 'a.com': 42, 'b.com': { savedAt: SAVED, activeName: null } },
    });

    await migrateStorage();

    expect(await getSnapshots()).toEqual({ 'b.com': { z: { ...z, bytes: byteSize(z) } } });
    expect(await getSnapshotHosts()).toEqual(['b.com']);
    expect(await getBackups()).toEqual({ 'b.com': { savedAt: SAVED, activeName: null } });
    expect(await chrome.storage.local.get(['snapshots', 'backups'])).toEqual({});
  });

  it('a legacy value that is not an object is removed without moving anything', async () => {
    await chrome.storage.local.set({ snapshots: 'corrupt', backups: [1, 2] });

    await migrateStorage();

    expect(chrome._state.storage).toEqual({ schemaVersion: SCHEMA_VERSION });
  });

  it('a save before migration survives it', async () => {
    await chrome.storage.local.set(legacy());

    await saveSnapshot('a.com', 'fresh', { localStorage: { f: '1' } });
    await migrateStorage();

    const snapshots = await getSnapshots();
    expect(snapshots['a.com'].fresh.localStorage).toEqual({ f: '1' });
    expect(Object.keys(snapshots['b.com'])).toEqual(['z']);
  });

  describe('with a non-reentrant lock', () => {
    let restore;

    beforeEach(() => {
      // Requests run one after another; a request made inside a held lock
      // would wait forever, as with Web Locks.
      let tail = Promise.resolve();
      const locks = {
        request: vi.fn((name, task) => {
          const run = tail.then(() => task());
          tail = run.catch(() => {});
          return run;
        }),
      };
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
      restore = () => {
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else delete navigator.locks;
      };
    });

    afterEach(() => restore());

    it('migration and every mutator complete', async () => {
      await chrome.storage.local.set(legacy());

      await expect(Promise.all([
        migrateStorage(),
        saveSnapshot('c.com', 'n', {}),
        deleteSnapshot('a.com', 'y'),
        renameSnapshot('b.com', 'z', 'w'),
        updateSnapshotDetails('c.com', 'n', { memo: 'm' }),
        saveBackup('c.com', {}, null),
        removeGroup('example.com'),
      ])).resolves.toBeDefined();
      await expect(clearAllData()).resolves.toBeUndefined();
      expect(navigator.locks.request).toHaveBeenCalled();
    });
  });
});
