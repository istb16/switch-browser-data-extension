// A whole load without the popup's state or a permission prompt, for the service
// worker. The popup keeps its own load (popup/actions.js), which also does partial loads.

import { collectData, applyData, hasPageType } from './data-bridge.js';
import { PAGE_TYPES } from './data-types.js';
import { activeValueFor } from './groups.js';
import { saveBackup, setActiveSnapshot } from './snapshot.js';
import { reloadAfterApply } from './tab-reload.js';

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Only the origin counts: the page may move within the site meanwhile, but its
// data must never be read from or written to another site.
async function stillOnOrigin(tab) {
  const current = await chrome.tabs.get(tab.id);
  if (originOf(current.url) !== originOf(tab.url)) throw new Error('tab left the origin');
}

/**
 * The page storage types loading `snapshot` (stored under `storeKey`) writes on
 * `scope`'s host; none on another host of a group, where only cookies apply.
 */
export function pageTypesOf(snapshot, types, storeKey, scope) {
  const here = storeKey === scope.host;
  return Object.fromEntries(PAGE_TYPES.map(type => [type, Boolean(here && types[type] && snapshot[type])]));
}

// The backup is the only way back from a key press, so whatever is about to be
// overwritten must be in it.
function assertCaptured(current, snapshot, types, pageTypes) {
  if (types.cookies && snapshot.cookies && !Array.isArray(current.cookies)) throw new Error('cookies not read');
  for (const [type, written] of Object.entries(pageTypes)) {
    if (written && !Object.hasOwn(current, type)) throw new Error(`${type} not read`);
  }
}

const NO_PAGE = Object.fromEntries(PAGE_TYPES.map(type => [type, false]));

// The page goes first and the cookies only after it took the data, as a clear does:
// a page that refuses (it left the origin, or the write did not arrive) then leaves
// the cookies, and so the signed-in account, as they were. Whatever failed part-way
// is put back from the backup just taken, as far as the page and the jar still take it.
async function applyInOrder({ tab, scope, entry, snapshot, types, writesPage, origin }, current) {
  const options = { interactive: false, origin };
  const pageOnly = { ...types, cookies: false };
  const cookiesOnly = { ...NO_PAGE, cookies: types.cookies };
  const putBack = async restored => {
    await applyData(tab.id, scope, current, restored, scope.host, options).catch(console.error);
  };
  let page;
  try {
    page = await applyData(tab.id, scope, snapshot, pageOnly, entry.host, options);
    // The ping before the switch does not promise the write still reaches the page.
    if (writesPage && !page.storageApplied) throw new Error('page storage not written');
  } catch (e) {
    if (writesPage) await putBack(pageOnly);
    throw e;
  }
  let cookies;
  try {
    cookies = await applyData(tab.id, scope, snapshot, cookiesOnly, entry.host, options);
  } catch (e) {
    // Apart, page first: the jar that just failed may fail the cookies' put-back too.
    if (writesPage) await putBack(pageOnly);
    await putBack(cookiesOnly);
    throw e;
  }
  return { ...page, cookiesApplied: cookies.cookiesApplied };
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
  const writesPage = hasPageType(pageTypes);

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
  const applied = await applyInOrder({ tab, scope, entry, snapshot, types, writesPage, origin }, current);
  // Built here rather than passing `entry`, so a whole load never records `types`.
  await setActiveSnapshot(scope.key, activeValueFor(scope, { host: entry.host, name: entry.name }));
  const reloaded = await reloadAfterApply({ tab, scope, settings, storeKey: entry.host, data: snapshot }, applied);
  return { backedUp: true, applied, reloaded };
}
