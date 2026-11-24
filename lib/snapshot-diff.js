// Item-level view and diff of a snapshot for the viewer. Snapshots can come from
// crafted import files, so nothing here assumes the shape beyond what it checks,
// and every keyed lookup goes through a Map so keys like __proto__ are plain keys.

import { cookieKey, stableStringify } from './data-compare.js';
import { cookiesWithin, cookieHostOf, hostMatches } from './cookie-handler.js';
import { isScopeWithin } from './domain.js';
import { isPlainObject } from './data-types.js';

const STORAGE_TYPES = ['localStorage', 'sessionStorage'];

function textOf(value) {
  return typeof value === 'string' ? value : String(stableStringify(value));
}

// IndexedDB only accepts a string or a nonempty array of strings; anything else
// (from a crafted file) is treated as no keyPath.
function validKeyPath(keyPath) {
  return typeof keyPath === 'string'
    || (Array.isArray(keyPath) && keyPath.length > 0 && keyPath.every(path => typeof path === 'string'));
}

// With '' in the keyPath the key holds the record itself, so it must be masked
// like a value.
function keyHoldsRecord(keyPath) {
  return keyPath === '' || (Array.isArray(keyPath) && keyPath.includes(''));
}

/**
 * The value of `keyPath` in a record as a stable string, or null when the store
 * has no valid keyPath or the record lacks the key (such records can only be
 * compared by content).
 */
export function recordKey(record, keyPath) {
  if (!validKeyPath(keyPath)) return null;
  const valueAt = path => {
    if (path === '') return record;
    let value = record;
    for (const part of path.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return value;
  };
  const key = Array.isArray(keyPath) ? keyPath.map(valueAt) : valueAt(keyPath);
  if (key === undefined || (Array.isArray(keyPath) && key.includes(undefined))) return null;
  return stableStringify(key);
}

export function previewOf(text, max) {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function cookieRows(cookies) {
  if (!Array.isArray(cookies)) return null;
  return cookies.filter(isPlainObject).map(cookie => ({ key: cookieKey(cookie), value: textOf(cookie.value), cookie }));
}

function storageRows(items) {
  if (!isPlainObject(items)) return null;
  return Object.keys(items).map(key => ({ key, value: textOf(items[key]) }));
}

function storeRow(name, store) {
  const keyPath = isPlainObject(store) ? store.keyPath ?? null : null;
  const records = isPlainObject(store) && Array.isArray(store.records) ? store.records : [];
  const maskKey = validKeyPath(keyPath) && keyHoldsRecord(keyPath);
  return {
    name,
    keyPath,
    autoIncrement: isPlainObject(store) && Boolean(store.autoIncrement),
    records: records.map(record => ({ key: recordKey(record, keyPath), value: textOf(record), maskKey })),
  };
}

function databaseRows(databases) {
  if (!isPlainObject(databases)) return null;
  return Object.keys(databases).map(name => {
    const db = isPlainObject(databases[name]) ? databases[name] : {};
    const stores = isPlainObject(db.stores) ? db.stores : {};
    return { name, version: db.version ?? null, stores: Object.keys(stores).map(store => storeRow(store, stores[store])) };
  });
}

/**
 * The items of each type as rows: cookies { key, value, cookie }, web storage
 * { key, value }, IndexedDB databases { name, version, stores: [{ name, keyPath,
 * autoIncrement, records: [{ key, value }] }] }. A type the snapshot never stored
 * is null; values are text.
 */
export function rowsOf(snapshot) {
  const data = isPlainObject(snapshot) ? snapshot : {};
  return {
    cookies: cookieRows(data.cookies),
    localStorage: storageRows(data.localStorage),
    sessionStorage: storageRows(data.sessionStorage),
    indexedDB: databaseRows(data.indexedDB),
  };
}

function zeroCounts() {
  return { added: 0, removed: 0, changed: 0 };
}

function countsOf(rows) {
  const counts = zeroCounts();
  for (const row of rows) if (row.status in counts) counts[row.status] += 1;
  return counts;
}

function addCounts(total, counts) {
  for (const status of Object.keys(total)) total[status] += counts[status];
  return total;
}

/**
 * Rows keyed by `key`, in base order then the other side's new keys:
 * 'removed' is only in base (the viewed snapshot), 'added' only in other.
 */
export function diffRows(base, other, same) {
  const before = new Map(base.map(row => [row.key, row]));
  const after = new Map(other.map(row => [row.key, row]));
  const rows = [];
  for (const [key, row] of before) {
    if (!after.has(key)) rows.push({ key, status: 'removed', base: row, other: null });
    else rows.push({ key, status: same(row, after.get(key)) ? 'same' : 'changed', base: row, other: after.get(key) });
  }
  for (const [key, row] of after) {
    if (!before.has(key)) rows.push({ key, status: 'added', base: null, other: row });
  }
  return rows;
}

// Records without a key can only be matched by content, so duplicates count.
function diffMultiset(base, other) {
  const left = new Map();
  for (const row of other) left.set(row.value, (left.get(row.value) ?? 0) + 1);
  const rows = base.map(row => {
    const n = left.get(row.value) ?? 0;
    if (n === 0) return { key: row.key, status: 'removed', base: row, other: null };
    left.set(row.value, n - 1);
    return { key: row.key, status: 'same', base: row, other: row };
  });
  for (const row of other) {
    const n = left.get(row.value) ?? 0;
    if (n === 0) continue;
    left.set(row.value, n - 1);
    rows.push({ key: row.key, status: 'added', base: null, other: row });
  }
  return rows;
}

function diffRecords(base, other) {
  const before = base?.records ?? [];
  const after = other?.records ?? [];
  const keyed = base && other && base.keyPath != null
    && stableStringify(base.keyPath) === stableStringify(other.keyPath);
  if (!keyed) return diffMultiset(before, after);
  const sameValue = (a, b) => a.value === b.value;
  return [
    ...diffRows(before.filter(r => r.key !== null), after.filter(r => r.key !== null), sameValue),
    ...diffMultiset(before.filter(r => r.key === null), after.filter(r => r.key === null)),
  ];
}

// Base's names in order, then the other side's new ones.
function unionNames(before, after) {
  return [...before.keys(), ...[...after.keys()].filter(name => !before.has(name))];
}

/**
 * The stores of one database (from rowsOf) against the same database on the
 * other side; either may be missing. Each store is { name, base, other,
 * schemaChanged, rows, counts }.
 */
export function diffStores(baseDb, otherDb) {
  const before = new Map((baseDb?.stores ?? []).map(store => [store.name, store]));
  const after = new Map((otherDb?.stores ?? []).map(store => [store.name, store]));
  return unionNames(before, after).map(name => {
    const base = before.get(name) ?? null;
    const other = after.get(name) ?? null;
    const schemaChanged = Boolean(base && other)
      && (stableStringify(base.keyPath) !== stableStringify(other.keyPath) || base.autoIncrement !== other.autoIncrement);
    const rows = diffRecords(base, other);
    return { name, base, other, schemaChanged, rows, counts: countsOf(rows) };
  });
}

function diffDatabases(base, other) {
  const before = new Map(base.map(db => [db.name, db]));
  const after = new Map(other.map(db => [db.name, db]));
  const databases = unionNames(before, after).map(name => {
    const baseDb = before.get(name) ?? null;
    const otherDb = after.get(name) ?? null;
    const stores = diffStores(baseDb, otherDb);
    return {
      name,
      base: baseDb,
      other: otherDb,
      versionChanged: Boolean(baseDb && otherDb) && baseDb.version !== otherDb.version,
      stores,
      counts: stores.reduce((total, store) => addCounts(total, store.counts), zeroCounts()),
    };
  });
  return { databases, counts: databases.reduce((total, db) => addCounts(total, db.counts), zeroCounts()) };
}

function plainRows(rows) {
  return rows.map(row => ({ key: row.key, status: null, base: row, other: null }));
}

function plainDatabases(databases) {
  return {
    databases: databases.map(db => ({
      name: db.name,
      base: db,
      other: null,
      versionChanged: false,
      stores: db.stores.map(store => ({
        name: store.name, base: store, other: null, schemaChanged: false, rows: plainRows(store.records), counts: null,
      })),
      counts: null,
    })),
    counts: null,
  };
}

/**
 * Of two cookie scopes ({ domain, exact }), the one that lies inside the other,
 * or null when neither does: comparing such snapshots in either scope would
 * report cookies the other never could have captured.
 */
export function narrowerScope(a, b) {
  if (isScopeWithin(a, b)) return a;
  if (isScopeWithin(b, a)) return b;
  return null;
}

function inScope(cookie, scope) {
  if (typeof cookie.domain !== 'string') return false;
  // The same match as cookiesWithin, so "範囲外" and "読み込まない" agree.
  return hostMatches(cookieHostOf(cookie.domain), scope);
}

/**
 * Base's rows in order (outside compareScope as 'notCompared'), then the other
 * side's new ones, with how many on each side fell outside compareScope.
 */
function compareCookieRows(baseRows, otherRows, compareScope) {
  // Only the domain decides "範囲外"; a cookie cookiesWithin rejects for its
  // shape is still compared, and notLoaded tells that a load would skip it.
  const inCompare = row => inScope(row.cookie, compareScope);
  const comparedBase = baseRows.filter(inCompare);
  const comparedOther = otherRows.filter(inCompare);
  const baseIn = new Set(comparedBase.map(row => row.cookie));
  const same = (a, b) => a.value === b.value
    && ['secure', 'httpOnly', 'sameSite'].every(field => a.cookie[field] === b.cookie[field]);
  const diffed = diffRows(comparedBase, comparedOther, same);
  const byKey = new Map(diffed.filter(row => row.base).map(row => [row.key, row]));
  const rows = [
    ...baseRows.flatMap(row => {
      if (!baseIn.has(row.cookie)) return [{ key: row.key, status: 'notCompared', base: row, other: null }];
      // A crafted file can repeat a cookie; the diff keeps one row per key.
      const diffRow = byKey.get(row.key);
      byKey.delete(row.key);
      return diffRow ? [diffRow] : [];
    }),
    ...diffed.filter(row => !row.base),
  ];
  return { rows, skipped: { base: baseRows.length - comparedBase.length, other: otherRows.length - comparedOther.length } };
}

function diffCookies(baseRows, otherRows, baseCookies, otherCookies, loadScope, compareScope) {
  const loaded = new Set(cookiesWithin(baseCookies, loadScope));
  const withLoad = row => ({ ...row, notLoaded: !loaded.has(row.base?.cookie) });
  if (otherRows === undefined) return { rows: plainRows(baseRows).map(withLoad), counts: null };
  if (!otherRows || !compareScope) return null;

  const compared = compareCookieRows(baseRows, otherRows, compareScope);
  const rows = compared.rows.map(row => (row.base ? withLoad(row) : { ...row, notLoaded: false }));
  return { rows, counts: countsOf(rows), skipped: compared.skipped };
}

// Web storage per type of STORAGE_TYPES; `after` null means no other side.
function diffStorage(before, after) {
  const result = {};
  for (const type of STORAGE_TYPES) {
    if (!before[type]) result[type] = null;
    else if (!after) result[type] = { rows: plainRows(before[type]), counts: null };
    else if (!after[type]) result[type] = null;
    else {
      const rows = diffRows(before[type], after[type], (a, b) => a.value === b.value);
      result[type] = { rows, counts: countsOf(rows) };
    }
  }
  return result;
}

/**
 * The viewed snapshot (`base`) against `other` (another snapshot or the current
 * state), per type of DATA_TYPES. Cookies and web storage give { rows, counts },
 * IndexedDB { databases, counts }; each row is { key, status, base, other } with
 * status 'same' | 'changed' | 'added' | 'removed', and for cookies also
 * 'notCompared' (outside compareScope, not counted) plus a notLoaded flag (a load
 * of base would skip it: outside loadScope or rejected by cookiesWithin). Cookies
 * also report how many on each side fell outside compareScope, as skipped.
 * A type is null when either side lacks it, and cookies are null without a
 * compareScope. With `other` null, base's rows come back with status null.
 */
export function diffSnapshots(base, other, { loadScope, compareScope = null }) {
  const before = rowsOf(base);
  const after = other ? rowsOf(other) : null;
  const result = {
    cookies: before.cookies && diffCookies(
      before.cookies, after ? after.cookies : undefined, base.cookies, other?.cookies, loadScope, compareScope,
    ),
    ...diffStorage(before, after),
  };
  if (!before.indexedDB) result.indexedDB = null;
  else if (!after) result.indexedDB = plainDatabases(before.indexedDB);
  else result.indexedDB = after.indexedDB ? diffDatabases(before.indexedDB, after.indexedDB) : null;
  return result;
}
