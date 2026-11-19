import { isCookieExpired } from './data-compare.js';

// The only tk-base tokens with both light and dark values.
export const SNAPSHOT_COLORS = ['red', 'amber', 'green', 'blue'];
export const MEMO_MAX = 100;

export function cleanDetails({ memo, color } = {}) {
  const details = {};
  if (typeof memo === 'string') {
    const text = memo.replace(/[\r\n]+/g, ' ').trim().slice(0, MEMO_MAX);
    if (text) details.memo = text;
  }
  if (SNAPSHOT_COLORS.includes(color)) details.color = color;
  return details;
}

const encoder = new TextEncoder();

export function byteSize(value) {
  return encoder.encode(JSON.stringify(value) ?? '').length;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Counts per data type: 0 for a type the snapshot stored empty, null for one it
 * never stored, so the preview can tell "nothing there" from "not saved".
 */
export function summarize(snapshot, now = Date.now()) {
  const keys = value => (value ? Object.keys(value).length : null);
  const cookies = Array.isArray(snapshot.cookies) ? snapshot.cookies : null;
  return {
    cookies: cookies ? cookies.length : null,
    localStorage: keys(snapshot.localStorage),
    sessionStorage: keys(snapshot.sessionStorage),
    indexedDB: keys(snapshot.indexedDB),
    expiredCookies: cookies ? cookies.filter(c => isCookieExpired(c, now)).length : 0,
  };
}

export function withBytes(snapshot) {
  const { bytes, ...rest } = snapshot;
  return { ...rest, bytes: byteSize(rest) };
}

export function sizeOf(snapshot) {
  if (Number.isFinite(snapshot.bytes)) return snapshot.bytes;
  const { bytes, ...rest } = snapshot;
  return byteSize(rest);
}

export function measureDomains(allSnapshots) {
  const result = {};
  for (const [domain, snapshots] of Object.entries(allSnapshots)) {
    const sizes = {};
    let bytes = 0;
    for (const [name, snapshot] of Object.entries(snapshots)) {
      sizes[name] = sizeOf(snapshot);
      bytes += sizes[name];
    }
    result[domain] = { bytes, snapshots: sizes };
  }
  return result;
}
