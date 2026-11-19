import {
  getSnapshotsFor, setSnapshotsFor, getSnapshotOrders, setSnapshotOrders,
  getActiveSnapshots, setActiveSnapshots, setBackup, setVolatileCookies, setCookieChecks, updateKey,
  SNAPSHOT_PREFIX, BACKUP_PREFIX,
} from './storage.js';
import { cleanDetails, withBytes } from './snapshot-summary.js';

export { getBackup } from './storage.js';

const LEGACY_KEYS = ['snapshots', 'backups'];

// Every write here reads a host's snapshots and writes them back, so two
// extension pages (popup and options) writing at once would drop one change. Web
// Locks are shared by every page of the extension's origin; the fallback is for
// environments without them, such as the unit tests' jsdom.
export function withSnapshotLock(task) {
  if (!globalThis.navigator?.locks) return task();
  return navigator.locks.request('snapshots', task);
}

// The saved order without names that are gone, then the unordered names sorted.
export function orderedNames(snapshotsOfDomain, order) {
  const allNames   = Object.keys(snapshotsOfDomain ?? {});
  const ordered    = (order ?? []).filter(n => allNames.includes(n));
  const unordered  = allNames.filter(n => !ordered.includes(n)).sort();
  return [...ordered, ...unordered];
}

// The memo and colour describe the snapshot, not the data in it, so an overwrite
// keeps them unless `details` gives new ones.
export function saveSnapshot(domain, name, data, details = {}) {
  return withSnapshotLock(() => saveSnapshotLocked(domain, name, data, details));
}

async function snapshotsOf(domain) {
  return (await getSnapshotsFor([domain]))[domain];
}

async function saveSnapshotLocked(domain, name, data, details) {
  const [stored, orders] = await Promise.all([snapshotsOf(domain), getSnapshotOrders()]);
  const snapshots = stored ?? {};
  const previous = snapshots[name];
  const { memo, color, ...rest } = data;
  const kept = cleanDetails({ memo: previous?.memo, color: previous?.color, ...details });
  snapshots[name] = withBytes({ ...rest, ...kept, savedAt: new Date().toISOString() });
  if (!orders[domain]) orders[domain] = [];
  if (!orders[domain].includes(name)) orders[domain].push(name);
  await Promise.all([setSnapshotsFor(domain, snapshots), setSnapshotOrders(orders)]);
}

export function updateSnapshotDetails(domain, name, details) {
  return withSnapshotLock(() => updateSnapshotDetailsLocked(domain, name, details));
}

async function updateSnapshotDetailsLocked(domain, name, details) {
  const snapshots = await snapshotsOf(domain);
  const snapshot = snapshots?.[name];
  if (!snapshot) return;
  delete snapshot.memo;
  delete snapshot.color;
  snapshots[name] = withBytes({ ...snapshot, ...cleanDetails(details) });
  await setSnapshotsFor(domain, snapshots);
}

// The keys of `active` that point at this snapshot: its own domain's name, or a
// group's { host, name } reference under the group's base key.
function activeKeysFor(active, domain, name) {
  return Object.keys(active).filter(key => {
    const value = active[key];
    if (typeof value === 'string') return key === domain && value === name;
    return value?.host === domain && value?.name === name;
  });
}

export function deleteSnapshot(domain, name) {
  return withSnapshotLock(() => deleteSnapshotLocked(domain, name));
}

async function deleteSnapshotLocked(domain, name) {
  const [snapshots, orders, active] = await Promise.all([snapshotsOf(domain), getSnapshotOrders(), getActiveSnapshots()]);
  if (!snapshots) return;
  delete snapshots[name];
  if (orders[domain]) {
    orders[domain] = orders[domain].filter(n => n !== name);
    if (orders[domain].length === 0) delete orders[domain];
  }
  const writes = [setSnapshotsFor(domain, snapshots), setSnapshotOrders(orders)];
  const activeKeys = activeKeysFor(active, domain, name);
  if (activeKeys.length) {
    for (const key of activeKeys) delete active[key];
    writes.push(setActiveSnapshots(active));
  }
  await Promise.all(writes);
}

export function renameSnapshot(domain, oldName, newName) {
  return withSnapshotLock(() => renameSnapshotLocked(domain, oldName, newName));
}

async function renameSnapshotLocked(domain, oldName, newName) {
  const [snapshots, orders, active] = await Promise.all([snapshotsOf(domain), getSnapshotOrders(), getActiveSnapshots()]);
  if (!snapshots?.[oldName]) return;
  if (snapshots[newName]) throw new Error('duplicate');
  snapshots[newName] = snapshots[oldName];
  delete snapshots[oldName];
  if (orders[domain]) {
    const idx = orders[domain].indexOf(oldName);
    if (idx !== -1) orders[domain][idx] = newName;
  }
  const writes = [setSnapshotsFor(domain, snapshots), setSnapshotOrders(orders)];
  const activeKeys = activeKeysFor(active, domain, oldName);
  if (activeKeys.length) {
    for (const key of activeKeys) {
      active[key] = typeof active[key] === 'string' ? newName : { ...active[key], name: newName };
    }
    writes.push(setActiveSnapshots(active));
  }
  await Promise.all(writes);
}

export function setSnapshotOrder(domain, order) {
  return withSnapshotLock(() => updateKey('snapshotOrder', orders => {
    orders[domain] = order;
    return orders;
  }));
}

export async function loadSnapshot(domain, name) {
  return (await snapshotsOf(domain))?.[name] ?? null;
}

export async function getActiveSnapshot(domain) {
  const active = await getActiveSnapshots();
  return active[domain] ?? null;
}

// Renaming and deleting rewrite `activeSnapshots` under the lock too.
export function setActiveSnapshot(domain, name) {
  return withSnapshotLock(() => updateKey('activeSnapshots', active => {
    if (name) active[domain] = name;
    else delete active[domain];
    return active;
  }));
}

// One backup per domain: the state just before the last load, kept apart from
// the named snapshots so it never shows up in their list, order or export.
// Locked so a backup written during clearAllData cannot bring the old ones back.
export function saveBackup(domain, data, activeName) {
  return withSnapshotLock(() => setBackup(domain, {
    ...data, activeName: activeName ?? null, savedAt: new Date().toISOString(),
  }));
}

// Every key is scanned rather than the indexes trusted, so a key an index lost
// track of goes too.
export function clearAllData() {
  return withSnapshotLock(async () => {
    const keys = Object.keys(await chrome.storage.local.get(null))
      .filter(key => key.startsWith(SNAPSHOT_PREFIX) || key.startsWith(BACKUP_PREFIX));
    await chrome.storage.local.remove([...keys, 'snapshotHosts', 'backupHosts', ...LEGACY_KEYS]);
    await Promise.all([
      setSnapshotOrders({}), setActiveSnapshots({}), setVolatileCookies({}), setCookieChecks({}),
    ]);
  });
}

const hasLegacy = stored => LEGACY_KEYS.some(key => key in stored);

const withBytesEach = snapshots =>
  Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, withBytes(snapshot)]));

/**
 * Moves the single `snapshots` and `backups` values of older versions to one key
 * per host. The popup and options page call it before reading snapshots; on
 * failure the old keys stay, and the next open tries again.
 */
export async function migrateStorage() {
  if (!hasLegacy(await chrome.storage.local.get(LEGACY_KEYS))) return;
  await withSnapshotLock(async () => {
    const stored = await chrome.storage.local.get([...LEGACY_KEYS, 'snapshotHosts', 'backupHosts']);
    if (!hasLegacy(stored)) return;
    const moves = [
      { legacy: stored.snapshots ?? {}, prefix: SNAPSHOT_PREFIX, indexKey: 'snapshotHosts', convert: withBytesEach },
      { legacy: stored.backups ?? {},   prefix: BACKUP_PREFIX,   indexKey: 'backupHosts',   convert: backup => backup },
    ];
    const candidates = moves.flatMap(({ legacy, prefix }) => Object.keys(legacy).map(host => prefix + host));
    const existing = candidates.length ? await chrome.storage.local.get(candidates) : {};

    const items = {};
    for (const { legacy, prefix, indexKey, convert } of moves) {
      const listed = stored[indexKey] ?? [];
      const hosts = [...listed];
      for (const [host, value] of Object.entries(legacy)) {
        // A per-host key can only have been written after the legacy value
        // (a save before migration, or a downgrade and upgrade), so it is newer.
        if ((prefix + host) in existing || !value || Object.keys(value).length === 0) continue;
        items[prefix + host] = convert(value);
        if (!hosts.includes(host)) hosts.push(host);
      }
      if (hosts.length !== listed.length) items[indexKey] = hosts;
    }
    if (Object.keys(items).length) await chrome.storage.local.set(items);
    await chrome.storage.local.remove(LEGACY_KEYS);
  });
}
