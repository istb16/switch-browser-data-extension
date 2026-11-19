// IndexedDB digests come from the storageDigest global (lib/storage-digest.js),
// which the popup loads as a classic script so the content script can share it.

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cookieKey(cookie) {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function cookieMap(cookies) {
  return new Map(cookies.map(c => [cookieKey(c), c.value]));
}

/**
 * Cookies the site rewrote on its own: compares the cookies just applied with
 * those found once the page has loaded again, before the user could act.
 * 'value': the cookie stayed but its value changed, so only its presence is
 * meaningful. 'any': it appeared or disappeared, so it is ignored entirely.
 */
export function findVolatileCookies(applied, current) {
  const before = cookieMap(applied);
  const after = cookieMap(current);
  const volatile = {};
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.has(key) !== after.has(key)) volatile[key] = 'any';
    else if (before.get(key) !== after.get(key)) volatile[key] = 'value';
  }
  return volatile;
}

function changedCookieNames(snapshotCookies, currentCookies, volatile) {
  const before = cookieMap(snapshotCookies);
  const after = cookieMap(currentCookies);
  const names = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const kind = volatile[key];
    if (kind === 'any') continue;
    const changed = before.has(key) !== after.has(key)
      || (kind !== 'value' && before.get(key) !== after.get(key));
    if (changed) names.push(key.slice(key.lastIndexOf('|') + 1));
  }
  return names;
}

function indexedDBDigest(data) {
  if (data.indexedDBDigest) return data.indexedDBDigest;
  return data.indexedDB ? globalThis.storageDigest.digest(data.indexedDB) : null;
}

// Saved with the snapshot so opening the popup never re-hashes a large database.
export function withDigests(data) {
  return data.indexedDB ? { ...data, indexedDBDigest: globalThis.storageDigest.digest(data.indexedDB) } : data;
}

/**
 * What differs between a snapshot and the current data, as labels such as
 * "Cookie: sid" or "localStorage"; empty when nothing does. A type is compared
 * only when it is enabled and present on both sides: a type the snapshot never
 * stored, or one that could not be read now (no host permission, no content
 * script), says nothing about a change.
 */
export function findChanges(snapshot, current, enabledTypes, volatileCookies = {}) {
  const changes = [];
  if (enabledTypes.cookies && snapshot.cookies && current.cookies) {
    const names = changedCookieNames(snapshot.cookies, current.cookies, volatileCookies);
    if (names.length) changes.push(`Cookie: ${names.join(', ')}`);
  }
  for (const type of ['localStorage', 'sessionStorage']) {
    if (enabledTypes[type] && snapshot[type] && current[type]
      && stableStringify(snapshot[type]) !== stableStringify(current[type])) changes.push(type);
  }
  if (enabledTypes.indexedDB) {
    const a = indexedDBDigest(snapshot);
    const b = indexedDBDigest(current);
    if (a && b && a !== b) changes.push('IndexedDB');
  }
  return changes;
}
