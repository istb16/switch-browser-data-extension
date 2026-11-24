// The reload that follows a write to a site's data: the active tab, the other tabs
// the write reaches, and the cookie check that has to be started before them.

import { cookieDomainFor } from './data-bridge.js';
import { cookiesWithin } from './cookie-handler.js';
import { otherSiteTabs, tabsToReload, reloadTab, reloadTabs } from './site-tabs.js';
import { startCookieCheck } from './volatile-cookies.js';

/** The other tabs that show `target`, or none unless the settings reload them. */
export async function selectOtherTabs(tab, settings, target) {
  if (!settings.autoReload || !settings.reloadOtherTabs) return [];
  try {
    return otherSiteTabs(await chrome.tabs.query({}), tab, target);
  } catch (e) {
    console.error(e);
    return [];
  }
}

// The data is already switched by then, so a tab closed meanwhile must not turn
// the change into an error or keep the site's other tabs from reloading.
async function reloadActiveTab(tab, settings) {
  if (!settings.autoReload) return;
  try {
    await reloadTab(tab.id);
  } catch (e) {
    console.error(e);
  }
}

/**
 * Reloads `tab`, then `others` unless the service worker reloads them after its
 * cookie check (`deferred`). Resolves with the number of other tabs reloaded or handed over.
 */
export async function reloadAfterChange(tab, settings, others, deferred) {
  await reloadActiveTab(tab, settings);
  if (deferred) return others.length;
  return reloadTabs(others.map(other => other.id));
}

// Must run before the reload, so the service worker finds the check when the
// reloaded page completes, and reloads the other tabs only after learning from it.
async function startCheck({ tab, scope, settings, data }, within, cookiesApplied, others) {
  if (!settings.enabledTypes.cookies || !data.cookies || !cookiesApplied) return false;
  await startCookieCheck(tab.id, scope.key, cookiesWithin(data.cookies, within), {
    origins: scope.origins, cookieDomain: within.domain, cookieExact: within.exact,
    reloadTabs: tabsToReload(others),
  });
  return true;
}

/**
 * Reloads after `data` (stored under `storeKey`, see applyData) was applied to
 * `tab`, as `applied` reports. Resolves with the number of other tabs reloaded or handed over.
 */
export async function reloadAfterApply({ tab, scope, settings, storeKey, data }, applied) {
  const within = cookieDomainFor(data, storeKey, scope);
  const others = await selectOtherTabs(tab, settings, {
    sameOrigin: applied.sharedStorageApplied,
    cookieDomain: applied.cookiesApplied ? within.domain : null,
  });
  const deferred = await startCheck({ tab, scope, settings, data }, within, applied.cookiesApplied, others);
  return reloadAfterChange(tab, settings, others, deferred);
}
