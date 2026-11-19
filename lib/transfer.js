import { isEncryptedEnvelope } from './crypto.js';
import { cleanDetails, withBytes } from './snapshot-summary.js';
import { orderedNames } from './snapshot.js';

// About five times the size advisory after base64 growth; a larger file is not
// a plausible export and would be decrypted and parsed wholly in memory.
export const IMPORT_MAX_BYTES = 256 * 1024 * 1024;

// Each domain becomes a storage key, and real exports hold hostnames from
// URL.hostname (the empty one for file: pages), so anything else is not one.
export const IMPORT_MAX_HOSTS = 5000;
const DOMAIN_KEY_MAX = 253;
const DOMAIN_KEY_PATTERN = /^[a-z0-9._\-[\]:]*$/;

const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const withoutBytes = snapshot => {
  if (!isPlainObject(snapshot)) return snapshot;
  const { bytes, ...rest } = snapshot;
  return rest;
};

function pickExport(snapshots, { domain, name }) {
  if (!domain) return snapshots;
  const forDomain = snapshots[domain] ?? {};
  if (name === undefined) return { [domain]: forDomain };
  return { [domain]: { [name]: forDomain[name] } };
}

export function buildExport(snapshots, scope = {}) {
  return Object.fromEntries(Object.entries(pickExport(snapshots, scope)).map(([domain, entries]) => [
    domain,
    Object.fromEntries(Object.entries(entries).map(([name, snapshot]) => [name, withoutBytes(snapshot)])),
  ]));
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
  return withBytes({ ...rest, ...cleanDetails({ memo, color }) });
}

const validDomainKey = domain => domain.length <= DOMAIN_KEY_MAX && DOMAIN_KEY_PATTERN.test(domain);

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
  if (!isPlainObject(value) || Object.keys(value).length > IMPORT_MAX_HOSTS) throw new Error('invalid');

  const data = {};
  for (const [domain, snapshots] of Object.entries(value)) {
    if (RESERVED_KEYS.includes(domain) || !validDomainKey(domain) || !isPlainObject(snapshots)) {
      throw new Error('invalid');
    }
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

  const changedHosts = [];

  for (const [domain, entries] of Object.entries(imported)) {
    const written = counts.added + counts.overwritten + counts.renamed;
    const target = { ...(Object.hasOwn(existing, domain) ? existing[domain] : {}) };
    // Start from the order the list shows (orderedNames), so appended names land
    // after every existing one rather than ahead of the unordered ones.
    const order = orderedNames(target, Object.hasOwn(orders, domain) ? orders[domain] : []);
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
    if (counts.added + counts.overwritten + counts.renamed > written) changedHosts.push(domain);
  }
  return { snapshots, orders: nextOrders, counts, changedHosts };
}
