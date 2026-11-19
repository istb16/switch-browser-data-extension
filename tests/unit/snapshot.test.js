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
} from '../../lib/snapshot.js';
import {
  getSnapshots, getSnapshotOrders, setSnapshots, setSnapshotOrders, getSettings, setSettings, getGroups, setGroups,
} from '../../lib/storage.js';

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

    it('a backup saved while all data is cleared does not bring the old backups back', async () => {
      const { saveBackup, clearAllData } = await import('../../lib/snapshot.js');
      const { getBackups } = await import('../../lib/storage.js');
      await saveBackup('old.com', {}, null);

      // saveBackup starts first: without the lock it reads old.com before the clear and writes it back after.
      await Promise.all([saveBackup('a.com', {}, null), clearAllData()]);

      expect(Object.keys(await getBackups())).toEqual([]);
    });
  });

  it('orderedNames follows the stored order, then appends unordered names alphabetically', async () => {
    // saveSnapshot() always appends new names to the order array, so names
    // end up "unordered" only when storage and the order list diverge — as
    // happens with options.js's import flow, which merges snapshot data
    // without touching snapshotOrder. Reproduce that directly.
    await setSnapshots({ 'example.com': { b: {}, a: {}, z: {}, c: {} } });
    await setSnapshotOrders({ 'example.com': ['b', 'a'] });

    const orders = await getSnapshotOrders();
    expect(orderedNames(await snapshotsOf('example.com'), orders['example.com'])).toEqual(['b', 'a', 'c', 'z']);
  });

  it('orderedNames ignores stale order entries for deleted snapshots', async () => {
    await saveSnapshot('example.com', 'a', {});
    await setSnapshotOrder('example.com', ['a', 'ghost']);
    const orders = await getSnapshotOrders();
    expect(orders['example.com']).toEqual(['a', 'ghost']);
    expect(orderedNames(await snapshotsOf('example.com'), orders['example.com'])).toEqual(['a']);
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

  it('deleteSnapshot on an unknown domain is a no-op', async () => {
    await expect(deleteSnapshot('unknown.com', 'x')).resolves.toBeUndefined();
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

  it('renameSnapshot on a missing snapshot is a no-op', async () => {
    await expect(renameSnapshot('example.com', 'missing', 'new')).resolves.toBeUndefined();
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

  it('updateSnapshotDetails on a missing snapshot is a no-op', async () => {
    await updateSnapshotDetails('example.com', 'missing', { memo: 'm' });
    expect(await getSnapshots()).toEqual({});
  });

  it('loadSnapshot returns the stored snapshot or null', async () => {
    await saveSnapshot('example.com', 'a', { value: 42 });
    expect((await loadSnapshot('example.com', 'a')).value).toBe(42);
    expect(await loadSnapshot('example.com', 'missing')).toBeNull();
  });
});

describe('lib/snapshot — active snapshot and backup', () => {
  it('records the active snapshot per domain and clears it with null', async () => {
    const { getActiveSnapshot, setActiveSnapshot } = await import('../../lib/snapshot.js');
    expect(await getActiveSnapshot('a.com')).toBeNull();
    await setActiveSnapshot('a.com', 'x');
    expect(await getActiveSnapshot('a.com')).toBe('x');
    await setActiveSnapshot('a.com', null);
    expect(await getActiveSnapshot('a.com')).toBeNull();
  });

  it('deleting the active snapshot clears it; deleting another one keeps it', async () => {
    const { setActiveSnapshot, getActiveSnapshot } = await import('../../lib/snapshot.js');
    await saveSnapshot('a.com', 'x', {});
    await saveSnapshot('a.com', 'y', {});
    await setActiveSnapshot('a.com', 'x');

    await deleteSnapshot('a.com', 'y');
    expect(await getActiveSnapshot('a.com')).toBe('x');
    await deleteSnapshot('a.com', 'x');
    expect(await getActiveSnapshot('a.com')).toBeNull();
  });

  it('renaming the active snapshot keeps it active under the new name', async () => {
    const { setActiveSnapshot, getActiveSnapshot } = await import('../../lib/snapshot.js');
    await saveSnapshot('a.com', 'x', {});
    await setActiveSnapshot('a.com', 'x');
    await renameSnapshot('a.com', 'x', 'z');
    expect(await getActiveSnapshot('a.com')).toBe('z');
  });

  it('deleteSnapshot clears a group reference to it', async () => {
    const { getActiveSnapshot } = await import('../../lib/snapshot.js');
    const { setActiveSnapshots } = await import('../../lib/storage.js');
    await saveSnapshot('app.example.com', 'x', {});
    await saveSnapshot('app.example.com', 'y', {});
    await saveSnapshot('example.com', 'x', {});
    await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'x' } });

    await deleteSnapshot('example.com', 'x');
    await deleteSnapshot('app.example.com', 'y');
    expect(await getActiveSnapshot('example.com')).toEqual({ host: 'app.example.com', name: 'x' });

    await deleteSnapshot('app.example.com', 'x');
    expect(await getActiveSnapshot('example.com')).toBeNull();
  });

  it('renameSnapshot renames a group reference to it', async () => {
    const { getActiveSnapshot } = await import('../../lib/snapshot.js');
    const { setActiveSnapshots } = await import('../../lib/storage.js');
    await saveSnapshot('app.example.com', 'x', {});
    await saveSnapshot('www.example.com', 'x', {});
    await setActiveSnapshots({ 'example.com': { host: 'app.example.com', name: 'x' } });

    await renameSnapshot('www.example.com', 'x', 'w');
    expect(await getActiveSnapshot('example.com')).toEqual({ host: 'app.example.com', name: 'x' });
    await renameSnapshot('app.example.com', 'x', 'z');
    expect(await getActiveSnapshot('example.com')).toEqual({ host: 'app.example.com', name: 'z' });
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

  it('saveBackup replaces one domain\'s backup and keeps the others', async () => {
    const { saveBackup, getBackup } = await import('../../lib/snapshot.js');
    await saveBackup('a.com', { localStorage: { a: '1' } }, null);
    await saveBackup('b.com', { localStorage: { b: '1' } }, 'x');
    expect((await getBackup('a.com')).localStorage).toEqual({ a: '1' });
    expect(await getBackup('b.com')).toMatchObject({ localStorage: { b: '1' }, activeName: 'x' });
  });
});

describe('lib/snapshot — clearAllData', () => {
  it('empties snapshots, their order, the active snapshots and the backups', async () => {
    const { clearAllData, setActiveSnapshot, saveBackup } = await import('../../lib/snapshot.js');
    await saveSnapshot('a.com', 'x', {});
    await setActiveSnapshot('a.com', 'x');
    await saveBackup('a.com', {}, 'x');

    await clearAllData();

    expect(await chrome.storage.local.get(['snapshots', 'snapshotOrder', 'activeSnapshots', 'backups']))
      .toEqual({ snapshots: {}, snapshotOrder: {}, activeSnapshots: {}, backups: {} });
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
