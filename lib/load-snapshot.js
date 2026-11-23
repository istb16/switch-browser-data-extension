// A whole load without the popup's state or a permission prompt, for the service
// worker. The popup keeps its own load (popup/actions.js), which also does partial loads.

import { collectData, applyData, cookieDomainFor } from './data-bridge.js';
import { cookiesWithin } from './cookie-handler.js';
import { saveBackup, setActiveSnapshot } from './snapshot.js';
import { otherSiteTabs, tabsToReload, reloadTab, reloadTabs } from './site-tabs.js';
import { startCookieCheck } from './volatile-cookies.js';

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Only the origin counts: the page may move within the site meanwhile, but its
// data must never be read from or written to another site.
export async function stillOnOrigin(tab) {
  const current = await chrome.tabs.get(tab.id);
  if (originOf(current.url) !== originOf(tab.url)) throw new Error('tab left the origin');
}

async function selectOtherTabs(tab, settings, target) {
  if (!settings.autoReload || !settings.reloadOtherTabs) return [];
  try {
    return otherSiteTabs(await chrome.tabs.query({}), tab, target);
  } catch (e) {
    console.error(e);
    return [];
  }
}

// The data is already switched by then, so a closed tab must not fail the load.
async function reloadIfEnabled(tab, settings) {
  if (!settings.autoReload) return;
  try {
    await reloadTab(tab.id);
  } catch (e) {
    console.error(e);
  }
}

async function reloadAfterApply({ tab, scope, settings, entry, snapshot }, applied) {
  const within = cookieDomainFor(snapshot, entry.host, scope);
  const others = await selectOtherTabs(tab, settings, {
    sameOrigin: applied.sharedStorageApplied,
    cookieDomain: applied.cookiesApplied ? within.domain : null,
  });
  // Started before the reload, so the service worker finds it when the page completes
  // and reloads the other tabs only after learning from this one.
  const deferred = Boolean(settings.enabledTypes.cookies && snapshot.cookies && applied.cookiesApplied);
  if (deferred) {
    await startCookieCheck(tab.id, scope.key, cookiesWithin(snapshot.cookies, within), {
      origins: scope.origins, cookieDomain: within.domain, cookieExact: within.exact,
      reloadTabs: tabsToReload(others),
    });
  }
  await reloadIfEnabled(tab, settings);
  if (deferred) return others.length;
  return reloadTabs(others.map(other => other.id));
}

/**
 * The page storage types loading `snapshot` (stored under `storeKey`) writes on
 * `scope`'s host; none on another host of a group, where only cookies apply.
 */
export function pageTypesOf(snapshot, types, storeKey, scope) {
  const here = storeKey === scope.host;
  return {
    localStorage:   Boolean(here && types.localStorage   && snapshot.localStorage),
    sessionStorage: Boolean(here && types.sessionStorage && snapshot.sessionStorage),
    indexedDB:      Boolean(here && types.indexedDB      && snapshot.indexedDB),
  };
}

// The backup is the only way back from a key press, so whatever is about to be
// overwritten must be in it.
function assertCaptured(current, snapshot, types, pageTypes) {
  if (types.cookies && snapshot.cookies && !Array.isArray(current.cookies)) throw new Error('cookies not read');
  for (const [type, written] of Object.entries(pageTypes)) {
    if (written && !Object.hasOwn(current, type)) throw new Error(`${type} not read`);
  }
}

/**
 * Backs up the tab's data, then loads `snapshot` (stored under `entry.host`) whole
 * and records it as active. Unlike the popup, a backup that cannot be written stops
 * the load before anything is applied: nobody confirmed it and it could not be undone.
 * Throws when the tab leaves its origin, the page cannot be read for the backup, or
 * the page refuses or misses the write.
 */
export async function loadWholeSnapshot({ tab, scope, settings, entry, snapshot, activeBefore }) {
  const origin = originOf(tab.url);
  const types = settings.enabledTypes;
  const pageTypes = pageTypesOf(snapshot, types, entry.host, scope);
  const writesPage = Object.values(pageTypes).some(Boolean);

  await stillOnOrigin(tab);
  const current = await collectData(tab.id, scope, types, { interactive: false, origin, strict: writesPage });
  assertCaptured(current, snapshot, types, pageTypes);
  await stillOnOrigin(tab);
  try {
    await saveBackup(scope.host, current, activeBefore);
  } catch (e) {
    console.error(e);
    return { backedUp: false };
  }

  await stillOnOrigin(tab);
  const applied = await applyData(tab.id, scope, snapshot, types, entry.host, { interactive: false, origin });
  // The ping before the switch does not promise the write still reaches the page.
  if (writesPage && !applied.storageApplied) throw new Error('page storage not written');
  await setActiveSnapshot(scope.key, scope.group ? { host: entry.host, name: entry.name } : entry.name);
  const reloaded = await reloadAfterApply({ tab, scope, settings, entry, snapshot }, applied);
  return { backedUp: true, applied, reloaded };
}
