// Coordinates data collection / restoration between popup and content script.
// Cookie operations are performed directly here via chrome.cookies (available in extension pages).
// host_permissions for the target domain are requested as optional at runtime.

import { getCookiesForDomain, setCookiesForDomain } from './cookie-handler.js';

async function requestHostPermission(domain) {
  const origin = `*://${domain}/*`;
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  // Must be called within a user gesture — button-click handlers in the popup satisfy this.
  return chrome.permissions.request({ origins: [origin] });
}

export async function collectData(tabId, domain, types) {
  const data = {};

  if (types.cookies) {
    const granted = await requestHostPermission(domain);
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
      const result = await chrome.tabs.sendMessage(tabId, { type: 'getStorageData', types: storageTypes });
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
