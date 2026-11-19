// Whole-store seeding and reading for tests, in the extension's per-host key
// layout (one key per host plus an index). The extension itself only ever
// writes one host, or the hosts an import touches, at a time.
import { SNAPSHOT_PREFIX, BACKUP_PREFIX } from '../../lib/storage.js';

const isEmpty = value => value == null || Object.keys(value).length === 0;

async function replaceAll(prefix, indexKey, values) {
  const stored = await chrome.storage.local.get(null);
  const old = Object.keys(stored).filter(key => key.startsWith(prefix));
  if (old.length) await chrome.storage.local.remove(old);
  const kept = Object.keys(values).filter(host => !isEmpty(values[host]));
  await chrome.storage.local.set({
    ...Object.fromEntries(kept.map(host => [prefix + host, values[host]])),
    [indexKey]: kept,
  });
}

export function setSnapshots(snapshots) {
  return replaceAll(SNAPSHOT_PREFIX, 'snapshotHosts', snapshots);
}

export function setBackups(backups) {
  return replaceAll(BACKUP_PREFIX, 'backupHosts', backups);
}

export async function getBackups() {
  const { backupHosts = [] } = await chrome.storage.local.get('backupHosts');
  const stored = backupHosts.length ? await chrome.storage.local.get(backupHosts.map(host => BACKUP_PREFIX + host)) : {};
  return Object.fromEntries(backupHosts
    .filter(host => (BACKUP_PREFIX + host) in stored)
    .map(host => [host, stored[BACKUP_PREFIX + host]]));
}
