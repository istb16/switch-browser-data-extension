export async function getSnapshots() {
  const { snapshots } = await chrome.storage.local.get('snapshots');
  return snapshots ?? {};
}

export async function setSnapshots(snapshots) {
  await chrome.storage.local.set({ snapshots });
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings ?? {
    enabledTypes: {
      cookies:        true,
      localStorage:   true,
      sessionStorage: true,
      indexedDB:      true,
    },
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
