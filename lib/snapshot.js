import { getSnapshots, setSnapshots, getSnapshotOrders, setSnapshotOrders } from './storage.js';

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

export async function saveSnapshot(domain, name, data) {
  const [snapshots, orders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
  if (!snapshots[domain]) snapshots[domain] = {};
  snapshots[domain][name] = { ...data, savedAt: new Date().toISOString() };
  if (!orders[domain]) orders[domain] = [];
  if (!orders[domain].includes(name)) orders[domain].push(name);
  await Promise.all([setSnapshots(snapshots), setSnapshotOrders(orders)]);
}

export async function deleteSnapshot(domain, name) {
  const [snapshots, orders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
  if (!snapshots[domain]) return;
  delete snapshots[domain][name];
  if (Object.keys(snapshots[domain]).length === 0) delete snapshots[domain];
  if (orders[domain]) {
    orders[domain] = orders[domain].filter(n => n !== name);
    if (orders[domain].length === 0) delete orders[domain];
  }
  await Promise.all([setSnapshots(snapshots), setSnapshotOrders(orders)]);
}

export async function renameSnapshot(domain, oldName, newName) {
  const [snapshots, orders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
  if (!snapshots[domain]?.[oldName]) return;
  if (snapshots[domain][newName]) throw new Error('duplicate');
  snapshots[domain][newName] = snapshots[domain][oldName];
  delete snapshots[domain][oldName];
  if (orders[domain]) {
    const idx = orders[domain].indexOf(oldName);
    if (idx !== -1) orders[domain][idx] = newName;
  }
  await Promise.all([setSnapshots(snapshots), setSnapshotOrders(orders)]);
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
