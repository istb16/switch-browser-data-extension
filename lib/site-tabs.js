import { isWithin } from './domain.js';

function parseWebUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

// `.domain` cookies reach subdomains even in an exact scope, so every host within
// the domain sees the rewritten jar. Discarded tabs load the new data when they
// are activated, so they are not woken up here.
export function otherSiteTabs(tabs, activeTab, { sameOrigin, cookieDomain }) {
  const activeOrigin = parseWebUrl(activeTab.url)?.origin;
  return tabs.filter(tab => {
    if (tab.id === activeTab.id || tab.discarded || tab.status === 'unloaded') return false;
    if (Boolean(tab.incognito) !== Boolean(activeTab.incognito)) return false;
    const url = parseWebUrl(tab.url);
    if (!url) return false;
    if (sameOrigin && activeOrigin && url.origin === activeOrigin) return true;
    return Boolean(cookieDomain) && isWithin(url.hostname, cookieDomain);
  });
}

// chrome.tabs.reload sends a form POST again, without asking, under the account
// just switched to; navigating to the tab's URL loads it with a GET instead. A URL
// with a fragment would only scroll within the page, so those tabs are reloaded.
async function reloadTab(tabId) {
  const { url } = await chrome.tabs.get(tabId);
  if (!url || url.includes('#')) return chrome.tabs.reload(tabId);
  return chrome.tabs.update(tabId, { url });
}

export async function reloadTabs(tabIds) {
  const results = await Promise.allSettled(tabIds.map(reloadTab));
  return results.filter(result => result.status === 'fulfilled').length;
}
