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
};

export async function getSnapshots() {
  const { snapshots } = await chrome.storage.local.get('snapshots');
  return snapshots ?? {};
}

export async function setSnapshots(snapshots) {
  await chrome.storage.local.set({ snapshots });
}

// Settings saved by older versions lack the newer keys, so every read is merged
// over the defaults rather than returned as stored.
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    enabledTypes: { ...DEFAULT_SETTINGS.enabledTypes, ...settings?.enabledTypes },
  };
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export async function getSnapshotOrders() {
  const { snapshotOrder } = await chrome.storage.local.get('snapshotOrder');
  return snapshotOrder ?? {};
}

export async function setSnapshotOrders(orders) {
  await chrome.storage.local.set({ snapshotOrder: orders });
}

export async function getActiveSnapshots() {
  const { activeSnapshots } = await chrome.storage.local.get('activeSnapshots');
  return activeSnapshots ?? {};
}

export async function setActiveSnapshots(activeSnapshots) {
  await chrome.storage.local.set({ activeSnapshots });
}

export async function getBackups() {
  const { backups } = await chrome.storage.local.get('backups');
  return backups ?? {};
}

export async function setBackups(backups) {
  await chrome.storage.local.set({ backups });
}

export async function getVolatileCookies() {
  const { volatileCookies } = await chrome.storage.local.get('volatileCookies');
  return volatileCookies ?? {};
}

export async function setVolatileCookies(volatileCookies) {
  await chrome.storage.local.set({ volatileCookies });
}

export async function getCookieChecks() {
  const { cookieChecks } = await chrome.storage.local.get('cookieChecks');
  return cookieChecks ?? {};
}

export async function setCookieChecks(cookieChecks) {
  await chrome.storage.local.set({ cookieChecks });
}
