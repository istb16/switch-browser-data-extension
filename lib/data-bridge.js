// Coordinates data collection / restoration between popup and content script.
// Cookie operations are performed directly here via chrome.cookies (available in extension pages).
// host_permissions for the target domain are requested as optional at runtime.

import { getCookiesForDomain, setCookiesForDomain } from './cookie-handler.js';

function hostOrigin(domain) {
  return `*://${domain}/*`;
}

export async function hasHostPermission(domain) {
  return chrome.permissions.contains({ origins: [hostOrigin(domain)] });
}

export async function requestHostPermission(domain) {
  if (await hasHostPermission(domain)) return true;
  // Must be called within a user gesture — button-click handlers in the popup satisfy this.
  return chrome.permissions.request({ origins: [hostOrigin(domain)] });
}

// interactive: false never shows the permission prompt (it needs a user gesture),
// so cookies are left out when the host permission has not been granted yet.
// digest: true returns IndexedDB as a digest (indexedDBDigest) instead of the
// records, which is enough to compare and avoids passing the whole database.
export async function collectData(tabId, domain, types, { interactive = true, digest = false } = {}) {
  const data = {};

  if (types.cookies) {
    const granted = interactive ? await requestHostPermission(domain) : await hasHostPermission(domain);
    if (granted) {
      data.cookies = await getCookiesForDomain(domain);
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
export async function clearData(tabId, domain, types) {
  let blockedIndexedDB = [];
  const storageTypes = storageTypesOf(types);
  if (Object.values(storageTypes).some(Boolean)) {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'clearStorageData', types: storageTypes });
    if (result?.error) throw new Error(result.error);
    blockedIndexedDB = result?.blockedIndexedDB ?? [];
  }
  if (types.cookies && await requestHostPermission(domain)) {
    await setCookiesForDomain(domain, []);
  }
  return blockedIndexedDB;
}

export async function applyData(tabId, domain, snapshot, types) {
  if (types.cookies && snapshot.cookies) {
    const granted = await requestHostPermission(domain);
    if (granted) {
      await setCookiesForDomain(domain, snapshot.cookies);
    }
  }

  const storagePayload = {};
  if (types.localStorage   && snapshot.localStorage)   storagePayload.localStorage   = snapshot.localStorage;
  if (types.sessionStorage && snapshot.sessionStorage) storagePayload.sessionStorage = snapshot.sessionStorage;
  if (types.indexedDB      && snapshot.indexedDB)      storagePayload.indexedDB      = snapshot.indexedDB;

  if (Object.keys(storagePayload).length > 0) {
    // An unreachable page stays silent here, as before; an error the content
    // script reports (such as an IndexedDB the page keeps open) is surfaced.
    const result = await chrome.tabs.sendMessage(tabId, { type: 'setStorageData', data: storagePayload, types }).catch(() => null);
    if (result?.error) throw new Error(result.error);
  }
}
