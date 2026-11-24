import { describe, it, expect, vi } from 'vitest';
import {
  getSnapshots, getSettings, setSettings, getSnapshotOrders, getActiveSnapshots, setActiveSnapshots, getGroups, setGroups,
  readKeys, updateKey, withDefaultSettings, getSnapshotHosts, getSnapshotsFor, setSnapshotsFor, getBackupHosts, getBackup,
  setBackup, setSnapshotsAndOrders, getPreviousSnapshots, setPreviousSnapshots,
} from '../../lib/storage.js';
import { setSnapshots, getBackups } from '../support/storage-seed.js';

describe('lib/storage', () => {
  it('returns an empty object when no snapshots are stored', async () => {
    expect(await getSnapshots()).toEqual({});
  });

  it('round-trips settings', async () => {
    const settings = {
      enabledTypes: { cookies: false, localStorage: true, sessionStorage: false, indexedDB: true },
      autoBackup: false,
      autoReload: true,
      showBadge:  false,
      encryptExports: true,
      reloadOtherTabs: true,
    };
    await setSettings(settings);
    expect(await getSettings()).toEqual(settings);
  });

  it('withDefaultSettings merges stored settings over the defaults', () => {
    expect(withDefaultSettings(undefined)).toEqual({
      enabledTypes: { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true },
      autoBackup: true,
      autoReload: true,
      reloadOtherTabs: false,
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

  it('readKeys defaults previousSnapshots to {} and commandNotice to null', async () => {
    expect(await readKeys(['previousSnapshots', 'commandNotice']))
      .toEqual({ previousSnapshots: {}, commandNotice: null });
  });

  it('round-trips the previous snapshots', async () => {
    const previous = { 'a.com': { host: 'a.com', name: 'x' } };
    await setPreviousSnapshots(previous);
    expect(await getPreviousSnapshots()).toEqual(previous);
  });

  it('readKeys takes a single key too', async () => {
    expect(await readKeys('groups')).toEqual({ groups: [] });
  });

  it('readKeys returns a key outside its table as stored', async () => {
    await chrome.storage.local.set({ language: 'en' });
    expect(await readKeys(['groups', 'language', 'missing'])).toEqual({ groups: [], language: 'en', missing: undefined });
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

  describe('per-host keys', () => {
    const snap = { savedAt: '2024-01-01T00:00:00.000Z' };

    it('setSnapshotsFor writes the host key and index in one set', async () => {
      const set = vi.spyOn(chrome.storage.local, 'set');

      await setSnapshotsFor('a.com', { x: snap });

      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith({ 'snapshots/a.com': { x: snap }, snapshotHosts: ['a.com'] });
      expect(await getSnapshotHosts()).toEqual(['a.com']);
    });

    it('an empty host removes the key, then the index entry', async () => {
      await setSnapshotsFor('a.com', { x: snap });
      await setSnapshotsFor('b.com', { y: snap });
      const remove = vi.spyOn(chrome.storage.local, 'remove');
      const set = vi.spyOn(chrome.storage.local, 'set');

      await setSnapshotsFor('a.com', {});

      expect(remove).toHaveBeenCalledWith('snapshots/a.com');
      expect(set).toHaveBeenCalledWith({ snapshotHosts: ['b.com'] });
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(set.mock.invocationCallOrder[0]);
      expect(chrome._state.storage).not.toHaveProperty('snapshots/a.com');
      expect(await getSnapshotHosts()).toEqual(['b.com']);
    });

    it('remove rejects → nothing changed', async () => {
      await setSnapshotsFor('a.com', { x: snap });
      vi.spyOn(chrome.storage.local, 'remove').mockRejectedValueOnce(new Error('io'));

      await expect(setSnapshotsFor('a.com', {})).rejects.toThrow('io');

      expect(await getSnapshotHosts()).toEqual(['a.com']);
      expect(await getSnapshots()).toEqual({ 'a.com': { x: snap } });
    });

    it('the index update rejects after the key is removed', async () => {
      await setSnapshotsFor('a.com', { x: snap });
      vi.spyOn(chrome.storage.local, 'set').mockRejectedValueOnce(new Error('io'));

      await expect(setSnapshotsFor('a.com', {})).rejects.toThrow('io');

      expect(await getSnapshotHosts()).toEqual(['a.com']);
      expect(await getSnapshots()).toEqual({});
      await setSnapshotsFor('a.com', { y: snap });
      expect(await getSnapshots()).toEqual({ 'a.com': { y: snap } });
      expect(await getSnapshotHosts()).toEqual(['a.com']);
    });

    it('getSnapshotsFor reads only the asked hosts and skips a missing key', async () => {
      await setSnapshots({ 'a.com': { x: snap }, 'b.com': { y: snap } });
      await chrome.storage.local.set({ snapshotHosts: ['a.com', 'b.com', 'gone.com'] });
      const get = vi.spyOn(chrome.storage.local, 'get');

      expect(await getSnapshotsFor(['a.com', 'gone.com'])).toEqual({ 'a.com': { x: snap } });

      expect(get).toHaveBeenCalledWith(['snapshots/a.com', 'snapshots/gone.com']);
      expect(await getSnapshots()).toEqual({ 'a.com': { x: snap }, 'b.com': { y: snap } });
    });

    it('backups live under one key per host', async () => {
      expect(await getBackup('a.com')).toBeNull();
      await setBackup('a.com', snap);
      await setBackup('b.com', snap);
      expect(await getBackup('a.com')).toEqual(snap);
      expect(await getBackupHosts()).toEqual(['a.com', 'b.com']);
      expect(chrome._state.storage['backups/b.com']).toEqual(snap);

      await setBackup('a.com', null);
      expect(await getBackups()).toEqual({ 'b.com': snap });
    });

    describe('setSnapshotsAndOrders', () => {
      it('skips an empty value and lists only the new hosts', async () => {
        await setSnapshotsFor('a.com', { x: snap });
        const set = vi.spyOn(chrome.storage.local, 'set');

        await setSnapshotsAndOrders({ 'a.com': { x: snap, y: snap }, 'b.com': {}, 'c.com': { z: snap } }, { 'a.com': ['y', 'x'] });

        expect(set).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledWith({
          'snapshots/a.com': { x: snap, y: snap },
          'snapshots/c.com': { z: snap },
          snapshotHosts: ['a.com', 'c.com'],
          snapshotOrder: { 'a.com': ['y', 'x'] },
        });
        expect(chrome._state.storage).not.toHaveProperty('snapshots/b.com');
      });

      it('leaves snapshotHosts out when every host is already listed', async () => {
        await setSnapshotsFor('a.com', { x: snap });
        await setSnapshotsFor('b.com', { y: snap });
        const set = vi.spyOn(chrome.storage.local, 'set');

        await setSnapshotsAndOrders({ 'b.com': { y: snap, z: snap } }, { 'b.com': ['y', 'z'] });

        expect(set).toHaveBeenCalledWith({ 'snapshots/b.com': { y: snap, z: snap }, snapshotOrder: { 'b.com': ['y', 'z'] } });
        expect(await getSnapshotHosts()).toEqual(['a.com', 'b.com']);
      });

      it('does not list an existing host twice when a new one is added with it', async () => {
        await setSnapshotsFor('a.com', { x: snap });

        await setSnapshotsAndOrders({ 'a.com': { x: snap, y: snap }, 'b.com': { z: snap } }, {});

        expect(await getSnapshotHosts()).toEqual(['a.com', 'b.com']);
      });

      it('with no values writes only the orders', async () => {
        await setSnapshotsFor('a.com', { x: snap });
        const set = vi.spyOn(chrome.storage.local, 'set');

        await setSnapshotsAndOrders({}, { 'a.com': ['x'] });

        expect(set).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledWith({ snapshotOrder: { 'a.com': ['x'] } });
        expect(await getSnapshotOrders()).toEqual({ 'a.com': ['x'] });
      });
    });

    it('accepts the empty host of file: pages', async () => {
      await setSnapshotsFor('', { x: snap });
      expect(await getSnapshots()).toEqual({ '': { x: snap } });
    });
  });

  it('updateKey passes an updater error on and writes nothing', async () => {
    const set = vi.spyOn(chrome.storage.local, 'set');
    await expect(updateKey('groups', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(set).not.toHaveBeenCalled();
  });
});
