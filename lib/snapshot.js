import {
  getSnapshots, setSnapshots, getSnapshotOrders, setSnapshotOrders,
  getActiveSnapshots, setActiveSnapshots, getBackups, setBackups, setVolatileCookies, setCookieChecks,
} from './storage.js';
import { cleanDetails } from './snapshot-summary.js';

export async function getSnapshotsForDomain(domain) {
  const snapshots = await getSnapshots();
  return snapshots[domain] ?? {};
}

export async function getOrderedSnapshotNames(domain) {
  const [snapshots, orders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
  const allNames   = Object.keys(snapshots[domain] ?? {});
  const ordered    = (orders[domain] ?? []).filter(n => allNames.includes(n));
  const unordered  = allNames.filter(n => !ordered.includes(n)).sort();
  return [...ordered, ...unordered];
}

// The memo and colour describe the snapshot, not the data in it, so an overwrite
// keeps them unless `details` gives new ones.
export async function saveSnapshot(domain, name, data, details = {}) {
  const [snapshots, orders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
  if (!snapshots[domain]) snapshots[domain] = {};
  const previous = snapshots[domain][name];
  const { memo, color, ...rest } = data;
  const kept = cleanDetails({ memo: previous?.memo, color: previous?.color, ...details });
  snapshots[domain][name] = { ...rest, ...kept, savedAt: new Date().toISOString() };
  if (!orders[domain]) orders[domain] = [];
  if (!orders[domain].includes(name)) orders[domain].push(name);
  await Promise.all([setSnapshots(snapshots), setSnapshotOrders(orders)]);
}

export async function updateSnapshotDetails(domain, name, details) {
  const snapshots = await getSnapshots();
  const snapshot = snapshots[domain]?.[name];
  if (!snapshot) return;
  delete snapshot.memo;
  delete snapshot.color;
  Object.assign(snapshot, cleanDetails(details));
  await setSnapshots(snapshots);
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

export async function deleteSnapshot(domain, name) {
  const [snapshots, orders, active] = await Promise.all([getSnapshots(), getSnapshotOrders(), getActiveSnapshots()]);
  if (!snapshots[domain]) return;
  delete snapshots[domain][name];
  if (Object.keys(snapshots[domain]).length === 0) delete snapshots[domain];
  if (orders[domain]) {
    orders[domain] = orders[domain].filter(n => n !== name);
    if (orders[domain].length === 0) delete orders[domain];
  }
  const writes = [setSnapshots(snapshots), setSnapshotOrders(orders)];
  const activeKeys = activeKeysFor(active, domain, name);
  if (activeKeys.length) {
    for (const key of activeKeys) delete active[key];
    writes.push(setActiveSnapshots(active));
  }
  await Promise.all(writes);
}

export async function renameSnapshot(domain, oldName, newName) {
  const [snapshots, orders, active] = await Promise.all([getSnapshots(), getSnapshotOrders(), getActiveSnapshots()]);
  if (!snapshots[domain]?.[oldName]) return;
  if (snapshots[domain][newName]) throw new Error('duplicate');
  snapshots[domain][newName] = snapshots[domain][oldName];
  delete snapshots[domain][oldName];
  if (orders[domain]) {
    const idx = orders[domain].indexOf(oldName);
    if (idx !== -1) orders[domain][idx] = newName;
  }
  const writes = [setSnapshots(snapshots), setSnapshotOrders(orders)];
  const activeKeys = activeKeysFor(active, domain, oldName);
  if (activeKeys.length) {
    for (const key of activeKeys) {
      active[key] = typeof active[key] === 'string' ? newName : { ...active[key], name: newName };
    }
    writes.push(setActiveSnapshots(active));
  }
  await Promise.all(writes);
}

export async function setSnapshotOrder(domain, order) {
  const orders = await getSnapshotOrders();
  orders[domain] = order;
  await setSnapshotOrders(orders);
}

export async function loadSnapshot(domain, name) {
  const snapshots = await getSnapshots();
  return snapshots[domain]?.[name] ?? null;
}

export async function getActiveSnapshot(domain) {
  const active = await getActiveSnapshots();
  return active[domain] ?? null;
}

export async function setActiveSnapshot(domain, name) {
  const active = await getActiveSnapshots();
  if (name) active[domain] = name;
  else delete active[domain];
  await setActiveSnapshots(active);
}

// One backup per domain: the state just before the last load, kept apart from
// the named snapshots so it never shows up in their list, order or export.
export async function saveBackup(domain, data, activeName) {
  const backups = await getBackups();
  backups[domain] = { ...data, activeName: activeName ?? null, savedAt: new Date().toISOString() };
  await setBackups(backups);
}

export async function getBackup(domain) {
  const backups = await getBackups();
  return backups[domain] ?? null;
}

export async function clearAllData() {
  await Promise.all([
    setSnapshots({}), setSnapshotOrders({}), setActiveSnapshots({}), setBackups({}),
    setVolatileCookies({}), setCookieChecks({}),
  ]);
}
