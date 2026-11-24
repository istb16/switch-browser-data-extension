import {
  getSnapshotsFor, setSnapshotsFor, getSnapshotOrders, setSnapshotOrders,
  getActiveSnapshots, setActiveSnapshots, getPreviousSnapshots, setPreviousSnapshots,
  setBackup, setVolatileCookies, setCookieChecks, updateKey, readKeys,
  SNAPSHOT_PREFIX, BACKUP_PREFIX,
} from './storage.js';
import { cleanDetails, withBytes } from './snapshot-summary.js';
import { isPlainObject } from './data-types.js';

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

// Read under the same lock as the write, so an edit of the fields left alone that
// lands in between is not written back over. Resolves false when the snapshot is gone.
export function replaceSnapshotFields(domain, name, fields, removed, details = {}) {
  return withSnapshotLock(async () => {
    const stored = (await snapshotsOf(domain))?.[name];
    if (!stored) return false;
    const merged = { ...stored, ...fields };
    for (const field of removed) delete merged[field];
    await saveSnapshotLocked(domain, name, merged, details);
    return true;
  });
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

// A rewrite to undefined removes the reference; true when `map` needs writing back.
function rewriteRefs(map, domain, name, rewrite) {
  const keys = activeKeysFor(map, domain, name);
  for (const key of keys) {
    const next = rewrite(map[key]);
    if (next === undefined) delete map[key];
    else map[key] = next;
  }
  return keys.length > 0;
}

export function deleteSnapshot(domain, name) {
  return withSnapshotLock(() => deleteSnapshotLocked(domain, name));
}

async function deleteSnapshotLocked(domain, name) {
  const [snapshots, orders, active, previous] = await Promise.all([
    snapshotsOf(domain), getSnapshotOrders(), getActiveSnapshots(), getPreviousSnapshots(),
  ]);
  if (!snapshots) return;
  delete snapshots[name];
  if (orders[domain]) {
    orders[domain] = orders[domain].filter(n => n !== name);
    if (orders[domain].length === 0) delete orders[domain];
  }
  const writes = [setSnapshotsFor(domain, snapshots), setSnapshotOrders(orders)];
  if (rewriteRefs(active, domain, name, () => undefined)) writes.push(setActiveSnapshots(active));
  if (rewriteRefs(previous, domain, name, () => undefined)) writes.push(setPreviousSnapshots(previous));
  await Promise.all(writes);
}

export function renameSnapshot(domain, oldName, newName) {
  return withSnapshotLock(() => renameSnapshotLocked(domain, oldName, newName));
}

async function renameSnapshotLocked(domain, oldName, newName) {
  const [snapshots, orders, active, previous] = await Promise.all([
    snapshotsOf(domain), getSnapshotOrders(), getActiveSnapshots(), getPreviousSnapshots(),
  ]);
  if (!snapshots?.[oldName]) return;
  if (snapshots[newName]) throw new Error('duplicate');
  snapshots[newName] = snapshots[oldName];
  delete snapshots[oldName];
  if (orders[domain]) {
    const idx = orders[domain].indexOf(oldName);
    if (idx !== -1) orders[domain][idx] = newName;
  }
  const writes = [setSnapshotsFor(domain, snapshots), setSnapshotOrders(orders)];
  const renamedActive = value => (typeof value === 'string' ? newName : { ...value, name: newName });
  if (rewriteRefs(active, domain, oldName, renamedActive)) writes.push(setActiveSnapshots(active));
  if (rewriteRefs(previous, domain, oldName, value => ({ ...value, name: newName }))) {
    writes.push(setPreviousSnapshots(previous));
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

// A record of the active map as { host, name }; `types` is dropped, so the
// previous snapshot is always loaded whole.
function refOf(domain, value) {
  if (!value) return null;
  if (typeof value === 'string') return { host: domain, name: value };
  return { host: value.host, name: value.name };
}

// Renaming and deleting rewrite `activeSnapshots` and `previousSnapshots` under
// the lock too. Only a change from one snapshot to another records the previous:
// a clear followed by an undo must not replace it with the cleared snapshot.
export function setActiveSnapshot(domain, name) {
  return withSnapshotLock(async () => {
    const { activeSnapshots: active, previousSnapshots: previous } =
      await readKeys(['activeSnapshots', 'previousSnapshots']);
    const from = refOf(domain, active[domain]);
    const to = refOf(domain, name);
    const items = {};
    if (from && to && (from.host !== to.host || from.name !== to.name)) {
      previous[domain] = from;
      items.previousSnapshots = previous;
    }
    if (name) active[domain] = name;
    else delete active[domain];
    items.activeSnapshots = active;
    await chrome.storage.local.set(items);
  });
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
    await chrome.storage.local.remove([...keys, 'snapshotHosts', 'backupHosts', 'commandNotice', ...LEGACY_KEYS]);
    await Promise.all([
      setSnapshotOrders({}), setActiveSnapshots({}), setVolatileCookies({}), setCookieChecks({}),
      setPreviousSnapshots({}),
    ]);
  });
}

// A corrupt entry is dropped rather than failing the whole migration, which
// would fail the same way on every open and never move the rest.
const withBytesEach = snapshots => Object.fromEntries(Object.entries(snapshots)
  .filter(([, snapshot]) => isPlainObject(snapshot))
  .map(([name, snapshot]) => [name, withBytes(snapshot)]));

// Version 1 (before 2.0.0): every host's snapshots under `snapshots`, every
// backup under `backups`. Version 2: one key per host, with `bytes` recorded.
async function toPerHostKeys() {
  const stored = await chrome.storage.local.get([...LEGACY_KEYS, 'snapshotHosts', 'backupHosts']);
  if (!LEGACY_KEYS.some(key => key in stored)) return;
  // A host that already has a per-host key keeps it, and for snapshots gains only
  // the names it lacks: after a migration that failed, the pages still work and
  // save to per-host keys, and the retry must not undo those saves.
  const moves = [
    {
      legacy: stored.snapshots, prefix: SNAPSHOT_PREFIX, indexKey: 'snapshotHosts', convert: withBytesEach,
      merge: (current, converted) => ({ ...converted, ...current }),
    },
    { legacy: stored.backups, prefix: BACKUP_PREFIX, indexKey: 'backupHosts', convert: backup => backup, merge: null },
  ].map(move => ({ ...move, legacy: isPlainObject(move.legacy) ? move.legacy : {} }));
  const candidates = moves.flatMap(({ legacy, prefix }) => Object.keys(legacy).map(host => prefix + host));
  const existing = candidates.length ? await chrome.storage.local.get(candidates) : {};

  const items = {};
  for (const { legacy, prefix, indexKey, convert, merge } of moves) {
    const listed = stored[indexKey] ?? [];
    const hosts = [...listed];
    for (const [host, value] of Object.entries(legacy)) {
      if (!isPlainObject(value)) continue;
      const current = existing[prefix + host];
      if (current !== undefined && !(merge && isPlainObject(current))) continue;
      const converted = convert(value);
      const next = current === undefined ? converted : merge(current, converted);
      const unchanged = current !== undefined && Object.keys(next).length === Object.keys(current).length;
      if (Object.keys(next).length === 0 || unchanged) continue;
      items[prefix + host] = next;
      if (!hosts.includes(host)) hosts.push(host);
    }
    if (hosts.length !== listed.length) items[indexKey] = hosts;
  }
  if (Object.keys(items).length) await chrome.storage.local.set(items);
  await chrome.storage.local.remove(LEGACY_KEYS);
}

export const SCHEMA_VERSION = 2;

// MIGRATIONS[n] turns a version n store into version n + 1. Each one must be
// safe to run again: the version is recorded only after the last one, so a
// failure part-way reruns them all on the next open.
const MIGRATIONS = { 1: toPerHostKeys };

/**
 * Brings the stored data to SCHEMA_VERSION. The popup and options page call it
 * before reading snapshots; on failure the version stays, and the next open
 * tries again. A store without a version predates it and is version 1.
 */
export async function migrateStorage() {
  const isCurrent = ({ schemaVersion }) => (schemaVersion ?? 1) >= SCHEMA_VERSION;
  if (isCurrent(await chrome.storage.local.get('schemaVersion'))) return;
  await withSnapshotLock(async () => {
    const stored = await chrome.storage.local.get('schemaVersion');
    if (isCurrent(stored)) return;
    for (let version = stored.schemaVersion ?? 1; version < SCHEMA_VERSION; version++) {
      await MIGRATIONS[version]();
    }
    await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
  });
}
