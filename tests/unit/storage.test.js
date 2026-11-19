import { describe, it, expect } from 'vitest';
import {
  getSnapshots, setSnapshots, getSettings, setSettings, getSnapshotOrders, setSnapshotOrders,
  getActiveSnapshots, setActiveSnapshots, getBackups, setBackups, getGroups, setGroups,
} from '../../lib/storage.js';

describe('lib/storage', () => {
  it('returns an empty object when no snapshots are stored', async () => {
    expect(await getSnapshots()).toEqual({});
  });

  it('round-trips snapshots through chrome.storage.local', async () => {
    const snapshots = { 'example.com': { foo: { savedAt: '2024-01-01T00:00:00.000Z' } } };
    await setSnapshots(snapshots);
    expect(await getSnapshots()).toEqual(snapshots);
  });

  it('returns the default settings when none are stored', async () => {
    expect(await getSettings()).toEqual({
      enabledTypes: { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true },
      autoBackup: true,
      autoReload: true,
      showBadge:  true,
      encryptExports: false,
    });
  });

  it('round-trips settings', async () => {
    const settings = {
      enabledTypes: { cookies: false, localStorage: true, sessionStorage: false, indexedDB: true },
      autoBackup: false,
      autoReload: true,
      showBadge:  false,
      encryptExports: true,
    };
    await setSettings(settings);
    expect(await getSettings()).toEqual(settings);
  });

  it('fills keys missing from settings saved by an older version with the defaults', async () => {
    await setSettings({ enabledTypes: { cookies: false } });
    const settings = await getSettings();
    expect(settings.enabledTypes).toEqual({ cookies: false, localStorage: true, sessionStorage: true, indexedDB: true });
    expect(settings.autoBackup).toBe(true);
    expect(settings.autoReload).toBe(true);
    expect(settings.showBadge).toBe(true);
    expect(settings.encryptExports).toBe(false);
  });

  it('round-trips active snapshots and backups', async () => {
    expect(await getActiveSnapshots()).toEqual({});
    expect(await getBackups()).toEqual({});
    await setActiveSnapshots({ 'a.com': 'x' });
    await setBackups({ 'a.com': { savedAt: '2024-01-01T00:00:00.000Z' } });
    expect(await getActiveSnapshots()).toEqual({ 'a.com': 'x' });
    expect(await getBackups()).toEqual({ 'a.com': { savedAt: '2024-01-01T00:00:00.000Z' } });
  });

  it('returns an empty object when no snapshot order is stored', async () => {
    expect(await getSnapshotOrders()).toEqual({});
  });

  it('round-trips snapshot orders', async () => {
    const orders = { 'example.com': ['b', 'a'] };
    await setSnapshotOrders(orders);
    expect(await getSnapshotOrders()).toEqual(orders);
  });

  it('getGroups defaults to an empty array', async () => {
    expect(await getGroups()).toEqual([]);
  });

  it('round-trips groups', async () => {
    await setGroups(['example.com']);
    expect(await getGroups()).toEqual(['example.com']);
  });
});
