import { describe, it, expect } from 'vitest';
import {
  getSnapshotsForDomain,
  getOrderedSnapshotNames,
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

describe('lib/snapshot', () => {
  it('getSnapshotsForDomain returns {} for an unknown domain', async () => {
    expect(await getSnapshotsForDomain('example.com')).toEqual({});
  });

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
    const snapshots = await getSnapshotsForDomain('example.com');
    expect(snapshots.first.cookies).toEqual([{ name: 'a' }]);
  });

  it('getOrderedSnapshotNames follows the stored order, then appends unordered names alphabetically', async () => {
    // saveSnapshot() always appends new names to the order array, so names
    // end up "unordered" only when storage and the order list diverge — as
    // happens with options.js's import flow, which merges snapshot data
    // without touching snapshotOrder. Reproduce that directly.
    await setSnapshots({ 'example.com': { b: {}, a: {}, z: {}, c: {} } });
    await setSnapshotOrders({ 'example.com': ['b', 'a'] });

    expect(await getOrderedSnapshotNames('example.com')).toEqual(['b', 'a', 'c', 'z']);
  });

  it('getOrderedSnapshotNames ignores stale order entries for deleted snapshots', async () => {
    await saveSnapshot('example.com', 'a', {});
    await setSnapshotOrder('example.com', ['a', 'ghost']);
    expect(await getOrderedSnapshotNames('example.com')).toEqual(['a']);
  });

  it('deleteSnapshot removes the snapshot and its order entry', async () => {
    await saveSnapshot('example.com', 'a', {});
    await saveSnapshot('example.com', 'b', {});
    await deleteSnapshot('example.com', 'a');

    expect(await getSnapshotsForDomain('example.com')).toEqual(expect.not.objectContaining({ a: expect.anything() }));
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

    const snapshots = await getSnapshotsForDomain('example.com');
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
    const { a } = await getSnapshotsForDomain('example.com');
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
