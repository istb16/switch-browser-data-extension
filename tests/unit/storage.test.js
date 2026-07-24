import { describe, it, expect } from 'vitest';
import { getSnapshots, setSnapshots, getSettings, setSettings, getSnapshotOrders, setSnapshotOrders } from '../../lib/storage.js';

describe('lib/storage', () => {
  it('returns an empty object when no snapshots are stored', async () => {
    expect(await getSnapshots()).toEqual({});
  });

  it('round-trips snapshots through chrome.storage.local', async () => {
    const snapshots = { 'example.com': { foo: { savedAt: '2024-01-01T00:00:00.000Z' } } };
    await setSnapshots(snapshots);
    expect(await getSnapshots()).toEqual(snapshots);
  });

  it('returns default enabledTypes when no settings are stored', async () => {
    expect(await getSettings()).toEqual({
      enabledTypes: { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true },
    });
  });

  it('round-trips settings', async () => {
    const settings = { enabledTypes: { cookies: false, localStorage: true, sessionStorage: false, indexedDB: true } };
    await setSettings(settings);
    expect(await getSettings()).toEqual(settings);
  });

  it('returns an empty object when no snapshot order is stored', async () => {
    expect(await getSnapshotOrders()).toEqual({});
  });

  it('round-trips snapshot orders', async () => {
    const orders = { 'example.com': ['b', 'a'] };
    await setSnapshotOrders(orders);
    expect(await getSnapshotOrders()).toEqual(orders);
  });
});
