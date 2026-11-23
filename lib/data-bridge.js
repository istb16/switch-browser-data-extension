// Coordinates data collection / restoration between popup and content script.
// Cookie operations are performed directly here via chrome.cookies (available in extension pages).
// host_permissions for the target domain are requested as optional at runtime.
// `scope` is the result of resolveScope() in lib/groups.js.

import { getCookiesForDomain, setCookiesForDomain } from './cookie-handler.js';
import { isWithin } from './domain.js';

export async function hasHostPermission(scope) {
  return chrome.permissions.contains({ origins: scope.origins });
}

export async function requestHostPermission(scope) {
  if (await hasHostPermission(scope)) return true;
  // Must be called within a user gesture — button-click handlers in the popup satisfy this.
  return chrome.permissions.request({ origins: scope.origins });
}

function cookieScopeOf(scope) {
  return scope.group ? { domain: scope.key, exact: false } : { domain: scope.host, exact: true };
}

/**
 * The cookie scope a snapshot was captured with, narrowed to the current one, as
 * { domain, exact } for cookiesWithin / setCookiesForDomain. Without a
 * cookieDomain the snapshot was saved outside a group, where the host permission
 * only reaches that host's own cookies (exact). Restoring such a snapshot over the
 * whole group would delete the sibling subdomains' sessions, so the result is
 * never wider than what was captured; a foreign cookieDomain falls back to the host.
 */
export function cookieDomainFor(snapshot, storeKey, scope) {
  const current = cookieScopeOf(scope);
  const captured = typeof snapshot.cookieDomain === 'string'
    ? { domain: snapshot.cookieDomain, exact: false }
    : { domain: storeKey, exact: true };
  const inside = (inner, outer) => (outer.exact
    ? inner.exact && inner.domain === outer.domain
    : isWithin(inner.domain, outer.domain));

  if (inside(captured, current)) return captured;
  if (!captured.exact && inside(current, captured)) return current;
  const host = isWithin(storeKey, current.domain) ? storeKey : scope.host;
  return { domain: host, exact: true };
}

// interactive: false never shows the permission prompt (it needs a user gesture),
// so cookies are left out when the host permission has not been granted yet.
// digest: true returns IndexedDB as a digest (indexedDBDigest) instead of the
// records, which is enough to compare and avoids passing the whole database.
export async function collectData(tabId, scope, types, { interactive = true, digest = false } = {}) {
  const readCookies = async () => {
    if (!types.cookies) return {};
    const granted = interactive ? await requestHostPermission(scope) : await hasHostPermission(scope);
    if (!granted) return {};
    const cookies = await getCookiesForDomain(scope.key);
    return scope.group ? { cookies, cookieDomain: scope.key } : { cookies };
  };

  const readPage = async () => {
    const storageTypes = storageTypesOf(types);
    if (!Object.values(storageTypes).some(Boolean)) return {};
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'getStorageData', types: storageTypes, digest });
      return result && !result.error ? result : {};
    } catch {
      // content script not available on this page (e.g. new tab, chrome:// pages)
      return {};
    }
  };

  const [cookieData, pageData] = await Promise.all([readCookies(), readPage()]);
  return Object.assign({}, cookieData, pageData);
}

function storageTypesOf(types) {
  return {
    localStorage:   types.localStorage,
    sessionStorage: types.sessionStorage,
    indexedDB:      types.indexedDB,
  };
}

// Whether the page's storage can be reached through the content script. Tabs
// opened before the extension was installed or updated have none until reloaded.
export async function canReachPage(tabId, types) {
  if (!Object.values(storageTypesOf(types)).some(Boolean)) return true;
  const reply = await chrome.tabs.sendMessage(tabId, { type: 'ping' }).catch(() => null);
  return Boolean(reply?.ok);
}

/**
 * Clears the site's data of the enabled types. Storage goes first and cookies
 * only after it succeeded, so a failure never leaves the user half cleared.
 * Resolves with the IndexedDB databases whose deletion waits for the page to
 * close them (see indexedDBHandler.clearAll).
 */
// `beforeCookies` runs with the cookie scope only once the cookies are about to
// be removed, so a failure before that leaves the jar and its callers' state alone.
export async function clearData(tabId, scope, types, { beforeCookies } = {}) {
  let blockedIndexedDB = [];
  const storageTypes = storageTypesOf(types);
  if (Object.values(storageTypes).some(Boolean)) {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'clearStorageData', types: storageTypes });
    if (result?.error) throw new Error(result.error);
    blockedIndexedDB = result?.blockedIndexedDB ?? [];
  }
  if (types.cookies && await requestHostPermission(scope)) {
    const cookieScope = cookieScopeOf(scope);
    await beforeCookies?.(cookieScope);
    await setCookiesForDomain(cookieScope, []);
  }
  return blockedIndexedDB;
}

/**
 * `storeKey` is the host the snapshot is stored under. Page data belongs to that
 * host's origin, so on another host of a group only the cookies are applied and
 * `storageSkipped` says the page data was left out. `cookiesApplied` and
 * `sharedStorageApplied` say what was actually written; sessionStorage belongs to
 * the tab alone, so only localStorage and IndexedDB count as shared with the
 * origin's other tabs.
 */
export async function applyData(tabId, scope, snapshot, types, storeKey = scope.host) {
  let cookiesApplied = false;
  if (types.cookies && snapshot.cookies) {
    const granted = await requestHostPermission(scope);
    if (granted) {
      await setCookiesForDomain(cookieDomainFor(snapshot, storeKey, scope), snapshot.cookies);
      cookiesApplied = true;
    }
  }

  const storagePayload = {};
  if (types.localStorage   && snapshot.localStorage)   storagePayload.localStorage   = snapshot.localStorage;
  if (types.sessionStorage && snapshot.sessionStorage) storagePayload.sessionStorage = snapshot.sessionStorage;
  if (types.indexedDB      && snapshot.indexedDB)      storagePayload.indexedDB      = snapshot.indexedDB;

  const hasPayload = Object.keys(storagePayload).length > 0;
  if (storeKey !== scope.host) return { storageSkipped: hasPayload, cookiesApplied, sharedStorageApplied: false };

  let sharedStorageApplied = false;
  if (hasPayload) {
    // An unreachable page stays silent here, as before; an error the content
    // script reports (such as an IndexedDB the page keeps open) is surfaced.
    const result = await chrome.tabs.sendMessage(tabId, { type: 'setStorageData', data: storagePayload, types }).catch(() => null);
    if (result?.error) throw new Error(result.error);
    sharedStorageApplied = Boolean(result?.success) && Boolean(storagePayload.localStorage || storagePayload.indexedDB);
  }
  return { storageSkipped: false, cookiesApplied, sharedStorageApplied };
}
