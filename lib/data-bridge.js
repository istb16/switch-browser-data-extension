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
    await chrome.tabs.sendMessage(tabId, { type: 'setStorageData', data: storagePayload, types }).catch(() => {});
  }
}
