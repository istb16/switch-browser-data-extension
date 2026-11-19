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

const KEYS = {
  snapshots:       stored => stored ?? {},
  settings:        withDefaultSettings,
  snapshotOrder:   stored => stored ?? {},
  activeSnapshots: stored => stored ?? {},
  backups:         stored => stored ?? {},
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

export async function getSnapshots() {
  return readKey('snapshots');
}

export async function setSnapshots(snapshots) {
  await writeKey('snapshots', snapshots);
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

export async function getBackups() {
  return readKey('backups');
}

export async function setBackups(backups) {
  await writeKey('backups', backups);
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
