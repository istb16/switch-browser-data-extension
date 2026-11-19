const DEFAULT_SETTINGS = {
  enabledTypes: {
    cookies:        true,
    localStorage:   true,
    sessionStorage: true,
    indexedDB:      true,
  },
  autoBackup: true,
  autoReload: true,
  showBadge:  true,
  encryptExports: false,
};

// Settings saved by older versions lack the newer keys, so every read is merged
// over the defaults rather than returned as stored.
export function withDefaultSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    enabledTypes: { ...DEFAULT_SETTINGS.enabledTypes, ...settings?.enabledTypes },
  };
}

export const SNAPSHOT_PREFIX = 'snapshots/';
export const BACKUP_PREFIX = 'backups/';

const KEYS = {
  snapshotHosts:   stored => stored ?? [],
  settings:        withDefaultSettings,
  snapshotOrder:   stored => stored ?? {},
  activeSnapshots: stored => stored ?? {},
  backupHosts:     stored => stored ?? [],
  volatileCookies: stored => stored ?? {},
  groups:          stored => stored ?? [],
  cookieChecks:    stored => stored ?? {},
};

export async function readKeys(keys) {
  const stored = await chrome.storage.local.get(keys);
  return Object.fromEntries([keys].flat().map(key => [key, KEYS[key](stored[key])]));
}

async function readKey(key) {
  return (await readKeys(key))[key];
}

async function writeKey(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// `update` gets the stored value (or its default) and returns the value to
// write; returning undefined leaves the key untouched.
export async function updateKey(key, update) {
  const value = update(await readKey(key));
  if (value !== undefined) await writeKey(key, value);
}

const isEmpty = value => value == null || Object.keys(value).length === 0;

async function readHostKeys(prefix, hosts) {
  if (hosts.length === 0) return {};
  const stored = await chrome.storage.local.get(hosts.map(host => prefix + host));
  return Object.fromEntries(hosts.filter(host => (prefix + host) in stored).map(host => [host, stored[prefix + host]]));
}

// A value and its index entry go out in one set. An empty value removes the key
// before the index entry, so a crash in between leaves a listed host without a
// key, which readers skip, and never a key that no index lists.
async function writeHostKey(prefix, indexKey, host, value) {
  const hosts = await readKey(indexKey);
  if (!isEmpty(value)) {
    const items = { [prefix + host]: value };
    if (!hosts.includes(host)) items[indexKey] = [...hosts, host];
    await chrome.storage.local.set(items);
    return;
  }
  await chrome.storage.local.remove(prefix + host);
  if (hosts.includes(host)) await writeKey(indexKey, hosts.filter(h => h !== host));
}

async function writeAllHostKeys(prefix, indexKey, values) {
  const hosts = await readKey(indexKey);
  const kept = Object.keys(values).filter(host => !isEmpty(values[host]));
  const gone = [...new Set([...hosts, ...Object.keys(values)])].filter(host => !kept.includes(host));
  if (gone.length) await chrome.storage.local.remove(gone.map(host => prefix + host));
  await chrome.storage.local.set({
    ...Object.fromEntries(kept.map(host => [prefix + host, values[host]])),
    [indexKey]: kept,
  });
}

export async function getSnapshotHosts() {
  return readKey('snapshotHosts');
}

export async function getSnapshotsFor(hosts) {
  return readHostKeys(SNAPSHOT_PREFIX, hosts);
}

export async function setSnapshotsFor(host, snapshots) {
  await writeHostKey(SNAPSHOT_PREFIX, 'snapshotHosts', host, snapshots);
}

export async function getSnapshots() {
  return getSnapshotsFor(await getSnapshotHosts());
}

export async function setSnapshots(snapshots) {
  await writeAllHostKeys(SNAPSHOT_PREFIX, 'snapshotHosts', snapshots);
}

// The hosts' values, the host index and the orders go out in one set, so a
// failed write leaves none of them changed rather than some hosts without
// their order. Empty values are not written.
export async function setSnapshotsAndOrders(values, orders) {
  const hosts = await readKey('snapshotHosts');
  const kept = Object.keys(values).filter(host => !isEmpty(values[host]));
  const added = kept.filter(host => !hosts.includes(host));
  await chrome.storage.local.set({
    ...Object.fromEntries(kept.map(host => [SNAPSHOT_PREFIX + host, values[host]])),
    ...(added.length ? { snapshotHosts: [...hosts, ...added] } : {}),
    snapshotOrder: orders,
  });
}

export async function getSettings() {
  return readKey('settings');
}

export async function setSettings(settings) {
  await writeKey('settings', settings);
}

export async function getSnapshotOrders() {
  return readKey('snapshotOrder');
}

export async function setSnapshotOrders(orders) {
  await writeKey('snapshotOrder', orders);
}

export async function getActiveSnapshots() {
  return readKey('activeSnapshots');
}

export async function setActiveSnapshots(activeSnapshots) {
  await writeKey('activeSnapshots', activeSnapshots);
}

export async function getBackupHosts() {
  return readKey('backupHosts');
}

export async function getBackup(host) {
  return (await readHostKeys(BACKUP_PREFIX, [host]))[host] ?? null;
}

export async function setBackup(host, backup) {
  await writeHostKey(BACKUP_PREFIX, 'backupHosts', host, backup);
}

export async function getBackups() {
  return readHostKeys(BACKUP_PREFIX, await getBackupHosts());
}

export async function setBackups(backups) {
  await writeAllHostKeys(BACKUP_PREFIX, 'backupHosts', backups);
}

export async function getVolatileCookies() {
  return readKey('volatileCookies');
}

export async function setVolatileCookies(volatileCookies) {
  await writeKey('volatileCookies', volatileCookies);
}

export async function getGroups() {
  return readKey('groups');
}

export async function setGroups(groups) {
  await writeKey('groups', groups);
}

export async function getCookieChecks() {
  return readKey('cookieChecks');
}

export async function setCookieChecks(cookieChecks) {
  await writeKey('cookieChecks', cookieChecks);
}
