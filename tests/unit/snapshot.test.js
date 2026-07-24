import { describe, it, expect } from 'vitest';
import {
  getSnapshotsForDomain,
  getOrderedSnapshotNames,
  saveSnapshot,
  deleteSnapshot,
  renameSnapshot,
  setSnapshotOrder,
  loadSnapshot,
} from '../../lib/snapshot.js';
import { getSnapshots, getSnapshotOrders, setSnapshots, setSnapshotOrders } from '../../lib/storage.js';

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

  it('loadSnapshot returns the stored snapshot or null', async () => {
    await saveSnapshot('example.com', 'a', { value: 42 });
    expect((await loadSnapshot('example.com', 'a')).value).toBe(42);
    expect(await loadSnapshot('example.com', 'missing')).toBeNull();
  });
});
