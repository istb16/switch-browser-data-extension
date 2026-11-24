import { isWithin, parseHttpUrl } from './domain.js';

// `.domain` cookies reach subdomains even in an exact scope, so every host within
// the domain sees the rewritten jar. Discarded tabs load the new data when they
// are activated, so they are not woken up here.
export function otherSiteTabs(tabs, activeTab, { sameOrigin, cookieDomain }) {
  const activeOrigin = parseHttpUrl(activeTab.url)?.origin;
  return tabs.filter(tab => {
    if (tab.id === activeTab.id || tab.discarded || tab.status === 'unloaded') return false;
    if (Boolean(tab.incognito) !== Boolean(activeTab.incognito)) return false;
    const url = parseHttpUrl(tab.url);
    if (!url) return false;
    if (sameOrigin && activeOrigin && url.origin === activeOrigin) return true;
    return Boolean(cookieDomain) && isWithin(url.hostname, cookieDomain);
  });
}

// chrome.tabs.reload sends a form POST again, without asking, under the account
// just switched to; navigating to the tab's URL loads it with a GET instead. A URL
// with a fragment would only scroll within the page, so those tabs are reloaded.
function loadAgain({ id, url }) {
  if (!url || url.includes('#')) return chrome.tabs.reload(id);
  return chrome.tabs.update(id, { url });
}

export async function reloadTab(tabId) {
  await loadAgain(await chrome.tabs.get(tabId));
  return true;
}

// The service worker reloads the tabs some time after they were chosen; by then a
// tab may show another site or have been discarded, and is then left alone.
async function reloadTabIfStillOn({ id, origin }) {
  const tab = await chrome.tabs.get(id);
  if (tab.discarded || tab.status === 'unloaded' || parseHttpUrl(tab.url)?.origin !== origin) return false;
  await loadAgain(tab);
  return true;
}

async function countReloaded(promises) {
  const results = await Promise.allSettled(promises);
  return results.filter(result => result.status === 'fulfilled' && result.value).length;
}

export async function reloadTabs(tabIds) {
  return countReloaded(tabIds.map(reloadTab));
}

// What a cookie check stores to reload later with reloadTabsStillOn.
export function tabsToReload(tabs) {
  return tabs.map(tab => ({ id: tab.id, origin: parseHttpUrl(tab.url)?.origin }));
}

export async function reloadTabsStillOn(entries) {
  return countReloaded(entries.map(reloadTabIfStillOn));
}
