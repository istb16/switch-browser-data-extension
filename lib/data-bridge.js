// Coordinates data collection / restoration between popup and content script.
// Cookie operations are performed directly here via chrome.cookies (available in extension pages).
// host_permissions for the target domain are requested as optional at runtime.
// `scope` is the result of resolveScope() in lib/groups.js.

import { getCookiesForDomain, setCookiesForDomain } from './cookie-handler.js';

export async function hasHostPermission(scope) {
  return chrome.permissions.contains({ origins: scope.origins });
}

export async function requestHostPermission(scope) {
  if (await hasHostPermission(scope)) return true;
  // Must be called within a user gesture — button-click handlers in the popup satisfy this.
  return chrome.permissions.request({ origins: scope.origins });
}

function isWithin(host, base) {
  return host === base || host.endsWith(`.${base}`);
}

// The cookie scope a snapshot was captured with, narrowed to the current one: a
// pre-group snapshot holds only its host's cookies, and restoring it over the
// whole group would delete the parent domain's session.
export function cookieDomainFor(snapshot, storeKey, scope) {
  const domain = snapshot.cookieDomain ?? storeKey;
  return typeof domain === 'string' && isWithin(domain, scope.key) ? domain : scope.key;
}

// interactive: false never shows the permission prompt (it needs a user gesture),
// so cookies are left out when the host permission has not been granted yet.
// digest: true returns IndexedDB as a digest (indexedDBDigest) instead of the
// records, which is enough to compare and avoids passing the whole database.
export async function collectData(tabId, scope, types, { interactive = true, digest = false } = {}) {
  const data = {};

  if (types.cookies) {
    const granted = interactive ? await requestHostPermission(scope) : await hasHostPermission(scope);
    if (granted) {
      data.cookies = await getCookiesForDomain(scope.key);
      if (scope.group) data.cookieDomain = scope.key;
    }
  }

  const storageTypes = {
    localStorage:   types.localStorage,
    sessionStorage: types.sessionStorage,
    indexedDB:      types.indexedDB,
  };

  if (Object.values(storageTypes).some(Boolean)) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'getStorageData', types: storageTypes, digest });
      if (result && !result.error) Object.assign(data, result);
    } catch {
      // content script not available on this page (e.g. new tab, chrome:// pages)
    }
  }

  return data;
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
export async function clearData(tabId, scope, types) {
  let blockedIndexedDB = [];
  const storageTypes = storageTypesOf(types);
  if (Object.values(storageTypes).some(Boolean)) {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'clearStorageData', types: storageTypes });
    if (result?.error) throw new Error(result.error);
    blockedIndexedDB = result?.blockedIndexedDB ?? [];
  }
  if (types.cookies && await requestHostPermission(scope)) {
    await setCookiesForDomain(scope.key, []);
  }
  return blockedIndexedDB;
}

/**
 * `storeKey` is the host the snapshot is stored under. Page data belongs to that
 * host's origin, so on another host of a group only the cookies are applied and
 * `storageSkipped` says the page data was left out.
 */
export async function applyData(tabId, scope, snapshot, types, storeKey = scope.host) {
  if (types.cookies && snapshot.cookies) {
    const granted = await requestHostPermission(scope);
    if (granted) {
      await setCookiesForDomain(cookieDomainFor(snapshot, storeKey, scope), snapshot.cookies);
    }
  }

  const storagePayload = {};
  if (types.localStorage   && snapshot.localStorage)   storagePayload.localStorage   = snapshot.localStorage;
  if (types.sessionStorage && snapshot.sessionStorage) storagePayload.sessionStorage = snapshot.sessionStorage;
  if (types.indexedDB      && snapshot.indexedDB)      storagePayload.indexedDB      = snapshot.indexedDB;

  const hasPayload = Object.keys(storagePayload).length > 0;
  if (storeKey !== scope.host) return { storageSkipped: hasPayload };

  if (hasPayload) {
    // An unreachable page stays silent here, as before; an error the content
    // script reports (such as an IndexedDB the page keeps open) is surfaced.
    const result = await chrome.tabs.sendMessage(tabId, { type: 'setStorageData', data: storagePayload, types }).catch(() => null);
    if (result?.error) throw new Error(result.error);
  }
  return { storageSkipped: false };
}
