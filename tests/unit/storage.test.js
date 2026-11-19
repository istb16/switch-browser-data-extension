import { describe, it, expect, vi } from 'vitest';
import {
  getSnapshots, setSnapshots, getSettings, setSettings, getSnapshotOrders, setSnapshotOrders,
  getActiveSnapshots, setActiveSnapshots, getBackups, setBackups, getGroups, setGroups,
  getVolatileCookies, setVolatileCookies, getCookieChecks, setCookieChecks,
  readKeys, updateKey, withDefaultSettings,
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

  it('round-trips volatile cookies and cookie checks, defaulting to empty objects', async () => {
    expect(await getVolatileCookies()).toEqual({});
    expect(await getCookieChecks()).toEqual({});
    await setVolatileCookies({ 'a.com': { 'a.com|/|x': 'value' } });
    await setCookieChecks({ 5: { domain: 'a.com', cookies: [], until: 1 } });
    expect(await getVolatileCookies()).toEqual({ 'a.com': { 'a.com|/|x': 'value' } });
    expect(await getCookieChecks()).toEqual({ 5: { domain: 'a.com', cookies: [], until: 1 } });
  });

  it('withDefaultSettings merges stored settings over the defaults', () => {
    expect(withDefaultSettings(undefined)).toEqual({
      enabledTypes: { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true },
      autoBackup: true,
      autoReload: true,
      showBadge:  true,
      encryptExports: false,
    });
    expect(withDefaultSettings({ autoReload: false, enabledTypes: { indexedDB: false } })).toMatchObject({
      enabledTypes: { cookies: true, localStorage: true, sessionStorage: true, indexedDB: false },
      autoBackup: true,
      autoReload: false,
    });
  });

  it('readKeys reads several keys in one get, with defaults for the missing ones', async () => {
    await setGroups(['example.com']);
    await setSettings({ showBadge: false });
    const get = vi.spyOn(chrome.storage.local, 'get');

    const values = await readKeys(['settings', 'groups', 'activeSnapshots', 'snapshotOrder']);

    expect(get).toHaveBeenCalledTimes(1);
    expect(values).toEqual({
      settings: withDefaultSettings({ showBadge: false }),
      groups: ['example.com'],
      activeSnapshots: {},
      snapshotOrder: {},
    });
  });

  it('readKeys takes a single key too', async () => {
    expect(await readKeys('groups')).toEqual({ groups: [] });
  });

  it('updateKey writes what the updater returns', async () => {
    await setActiveSnapshots({ 'a.com': 'x' });
    const update = vi.fn(active => ({ ...active, 'b.com': 'y' }));

    await updateKey('activeSnapshots', update);

    expect(update).toHaveBeenCalledWith({ 'a.com': 'x' });
    expect(await getActiveSnapshots()).toEqual({ 'a.com': 'x', 'b.com': 'y' });
  });

  it('updateKey hands the default to the updater when the key is missing', async () => {
    await updateKey('groups', groups => [...groups, 'example.com']);
    expect(await getGroups()).toEqual(['example.com']);
  });

  it('updateKey writes nothing when the updater returns undefined', async () => {
    await setGroups(['example.com']);
    const set = vi.spyOn(chrome.storage.local, 'set');

    await updateKey('groups', () => undefined);

    expect(set).not.toHaveBeenCalled();
    expect(await getGroups()).toEqual(['example.com']);
  });

  it('updateKey passes an updater error on and writes nothing', async () => {
    const set = vi.spyOn(chrome.storage.local, 'set');
    await expect(updateKey('groups', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(set).not.toHaveBeenCalled();
  });
});
