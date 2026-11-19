import { isEncryptedEnvelope } from './crypto.js';
import { cleanDetails } from './snapshot-summary.js';

// About five times the size advisory after base64 growth; a larger file is not
// a plausible export and would be decrypted and parsed wholly in memory.
export const IMPORT_MAX_BYTES = 256 * 1024 * 1024;

const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function buildExport(snapshots, { domain, name } = {}) {
  if (!domain) return snapshots;
  const forDomain = snapshots[domain] ?? {};
  if (name === undefined) return { [domain]: forDomain };
  return { [domain]: { [name]: forDomain[name] } };
}

export function exportFileName({ domain } = {}, now = Date.now()) {
  const part = domain ? `${domain.replace(/[^a-z0-9.-]/gi, '_')}-` : '';
  return `browser-data-snapshots-${part}${now}.json`;
}

function validSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  if (typeof snapshot.savedAt !== 'string' || Number.isNaN(Date.parse(snapshot.savedAt))) return false;
  if (snapshot.cookies !== undefined
    && !(Array.isArray(snapshot.cookies) && snapshot.cookies.every(isPlainObject))) return false;
  return ['localStorage', 'sessionStorage', 'indexedDB']
    .every(type => snapshot[type] === undefined || isPlainObject(snapshot[type]));
}

function cleanSnapshot(snapshot) {
  const { memo, color, ...rest } = snapshot;
  if (rest.cookieDomain !== undefined && typeof rest.cookieDomain !== 'string') delete rest.cookieDomain;
  return { ...rest, ...cleanDetails({ memo, color }) };
}

/**
 * Returns `{ encrypted: true, envelope }` or `{ encrypted: false, data }`.
 * Throws `Error('invalid')` when any part of the file is malformed, so nothing
 * from a bad file is merged. Pass `{ decrypted: true }` for the text inside an
 * envelope, where a second envelope is not accepted.
 */
export function parseImport(text, { decrypted = false } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('invalid');
  }
  if (!decrypted && isEncryptedEnvelope(value)) return { encrypted: true, envelope: value };
  if (!isPlainObject(value)) throw new Error('invalid');

  const data = {};
  for (const [domain, snapshots] of Object.entries(value)) {
    if (RESERVED_KEYS.includes(domain) || !isPlainObject(snapshots)) throw new Error('invalid');
    data[domain] = {};
    for (const [name, snapshot] of Object.entries(snapshots)) {
      if (RESERVED_KEYS.includes(name) || !validSnapshot(snapshot)) throw new Error('invalid');
      data[domain][name] = cleanSnapshot(snapshot);
    }
  }
  return { encrypted: false, data };
}

export function findConflicts(existing, imported) {
  const conflicts = [];
  for (const [domain, snapshots] of Object.entries(imported)) {
    if (!Object.hasOwn(existing, domain)) continue;
    for (const name of Object.keys(snapshots)) {
      if (Object.hasOwn(existing[domain], name)) conflicts.push({ domain, name });
    }
  }
  return conflicts;
}

export function uniqueName(name, taken) {
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!Object.hasOwn(taken, candidate)) return candidate;
  }
}

/**
 * strategy: 'overwrite' | 'skip' | 'keepBoth', applied to every conflict in the file.
 * Overwritten names keep their position; added and renamed names are appended
 * in file order. Returns new objects; the inputs are not modified.
 */
export function mergeImport(existing, orders, imported, strategy) {
  const snapshots = { ...existing };
  const nextOrders = { ...orders };
  const counts = { added: 0, overwritten: 0, skipped: 0, renamed: 0 };

  for (const [domain, entries] of Object.entries(imported)) {
    const target = { ...(Object.hasOwn(existing, domain) ? existing[domain] : {}) };
    // Without a saved order the list shows the names sorted; start from that so
    // appended names do not jump ahead of them.
    const order = Object.hasOwn(orders, domain) ? [...orders[domain]] : Object.keys(target).sort();
    const orderLength = order.length;
    for (const [name, snapshot] of Object.entries(entries)) {
      if (!Object.hasOwn(target, name)) {
        target[name] = snapshot;
        if (!order.includes(name)) order.push(name);
        counts.added++;
      } else if (strategy === 'overwrite') {
        target[name] = snapshot;
        if (!order.includes(name)) order.push(name);
        counts.overwritten++;
      } else if (strategy === 'keepBoth') {
        const renamed = uniqueName(name, target);
        target[renamed] = snapshot;
        order.push(renamed);
        counts.renamed++;
      } else {
        counts.skipped++;
      }
    }
    snapshots[domain] = target;
    if (order.length !== orderLength) nextOrders[domain] = order;
  }
  return { snapshots, orders: nextOrders, counts };
}
