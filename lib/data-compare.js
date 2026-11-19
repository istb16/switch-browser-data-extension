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

function cookieObjects(cookies) {
  return new Map(cookies.map(c => [cookieKey(c), c]));
}

// A saved cookie past its expiry has been dropped or reissued by now, so neither
// its absence nor a new value says anything about the account.
function expired(cookie, now) {
  return cookie.expirationDate != null && cookie.expirationDate * 1000 <= now;
}

function changedCookies(snapshotCookies, currentCookies, volatile, now) {
  const before = cookieObjects(snapshotCookies);
  const after = cookieObjects(currentCookies);
  const changed = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const kind = volatile[key];
    if (kind === 'any' || (before.has(key) && expired(before.get(key), now))) continue;
    const name = key.slice(key.lastIndexOf('|') + 1);
    if (before.has(key) !== after.has(key)) changed.push({ type: 'cookies', key, name, kind: 'presence' });
    else if (kind !== 'value' && before.get(key).value !== after.get(key).value) changed.push({ type: 'cookies', key, name, kind: 'value' });
  }
  return changed;
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
 * What differs between a snapshot and the current data: one entry per changed
 * cookie ({ type: 'cookies', key, name, kind: 'value' | 'presence' }) and one per
 * other changed type ({ type }); empty when nothing does. A type is compared only
 * when it is enabled and present on both sides: a type the snapshot never stored,
 * or one that could not be read now (no host permission, no content script), says
 * nothing about a change.
 */
export function findChanges(snapshot, current, enabledTypes, volatileCookies = {}, now = Date.now()) {
  const changes = [];
  if (enabledTypes.cookies && snapshot.cookies && current.cookies) {
    changes.push(...changedCookies(snapshot.cookies, current.cookies, volatileCookies, now));
  }
  for (const type of ['localStorage', 'sessionStorage']) {
    if (enabledTypes[type] && snapshot[type] && current[type]
      && stableStringify(snapshot[type]) !== stableStringify(current[type])) changes.push({ type });
  }
  if (enabledTypes.indexedDB) {
    const a = indexedDBDigest(snapshot);
    const b = indexedDBDigest(current);
    if (a && b && a !== b) changes.push({ type: 'indexedDB' });
  }
  return changes;
}

const TYPE_LABELS = { localStorage: 'localStorage', sessionStorage: 'sessionStorage', indexedDB: 'IndexedDB' };

export function describeChanges(changes) {
  const cookieNames = changes.filter(c => c.type === 'cookies').map(c => c.name);
  const labels = cookieNames.length ? [`Cookie: ${cookieNames.join(', ')}`] : [];
  return [...labels, ...changes.filter(c => c.type !== 'cookies').map(c => TYPE_LABELS[c.type])];
}
