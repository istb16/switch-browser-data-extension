function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Only which cookies exist is compared, not their values: many sites rewrite
// values on every response (CSRF tokens, Cloudflare's __cf_bm, analytics ids,
// re-encrypted session cookies), so comparing values would flag a change right
// after every load. Signing out or in still adds or removes cookies.
function cookieIdentities(cookies) {
  return cookies.map(c => `${c.domain}|${c.path}|${c.name}`).sort();
}

export function summarizeIndexedDB(indexedDB) {
  return Object.fromEntries(Object.entries(indexedDB).map(([dbName, db]) => [dbName, {
    version: db.version,
    stores: Object.fromEntries(Object.entries(db.stores).map(([storeName, store]) => [storeName, store.records.length])),
  }]));
}

function comparable(type, data) {
  if (type === 'cookies') return data.cookies && cookieIdentities(data.cookies);
  if (type === 'indexedDB') return data.indexedDBSummary ?? (data.indexedDB && summarizeIndexedDB(data.indexedDB));
  return data[type];
}

/**
 * Whether the current data differs from a snapshot. A type is compared only when
 * it is enabled and present on both sides: a type the snapshot never stored, or
 * one that could not be read now (no host permission, no content script), says
 * nothing about a change. IndexedDB is compared by record counts per store.
 */
export function hasChanges(snapshot, current, enabledTypes) {
  return ['cookies', 'localStorage', 'sessionStorage', 'indexedDB'].some(type => {
    if (!enabledTypes[type]) return false;
    const a = comparable(type, snapshot);
    const b = comparable(type, current);
    return a != null && b != null && stableStringify(a) !== stableStringify(b);
  });
}
