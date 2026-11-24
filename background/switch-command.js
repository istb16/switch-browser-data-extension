// The switch-previous shortcut: loads the snapshot that was active before the
// current one without opening the popup. Failures are told through a "!" on the
// tab's badge and a notice the popup shows when it opens.

import { readKeys, getSnapshotsFor } from '../lib/storage.js';
import { badgeColors, badgeText, drawBadge } from '../lib/badge.js';
import { resolveScope, activeRef } from '../lib/groups.js';
import { hasHostPermission, canReachPage } from '../lib/data-bridge.js';
import { loadWholeSnapshot, pageTypesOf } from '../lib/load-snapshot.js';
import { httpHostOf } from '../lib/domain.js';

const COMMAND = 'switch-previous';
const NOTICE_MS = 60_000;
const FLASH_MS = 4000;

// Key repeat fires the command again while a switch is still running.
let busy = false;

// Tab id → the flash now shown on it. The switch itself changes the active record
// and reloads the tab, and the badge redraws those start would otherwise wipe the
// flash out at once.
const flashes = new Map();

export function isFlashing(tabId) {
  return flashes.has(tabId);
}

// The tab may have navigated within the delay, so it is read again and drawn as it
// is now; a closed tab is skipped.
function flash(tab, redraw, label = '!') {
  const token = {};
  flashes.set(tab.id, token);
  drawBadge(tab.id, label, badgeColors());
  setTimeout(() => {
    // A later flash on the same tab owns its own timer.
    if (flashes.get(tab.id) !== token) return;
    flashes.delete(tab.id);
    chrome.tabs.get(tab.id).then(redraw, () => {}).catch(console.error);
  }, FLASH_MS);
}

// openPopup is missing before Chrome 127 and rejects without a focused window;
// the notice then waits for the user to open the popup on that tab. The host
// keeps it from showing after the tab has gone on to another site.
async function fail(tab, key, redraw) {
  if (key) {
    await chrome.storage.local.set({
      commandNotice: { tabId: tab.id, host: httpHostOf(tab.url), key, until: Date.now() + NOTICE_MS },
    });
  }
  flash(tab, redraw);
  try {
    await chrome.action.openPopup?.();
  } catch (e) {
    console.error(e);
  }
}

// An open popup keeps its own state and would show the switch as stale. Without
// getContexts (before Chrome 116) it cannot be told, so the switch is refused.
async function popupIsOpen() {
  if (!chrome.runtime.getContexts) return true;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).catch(() => null);
  return !contexts || contexts.length > 0;
}

async function previousEntry(scope, active, previous, groups) {
  const ref = previous[scope.key];
  if (!ref || typeof ref.host !== 'string' || typeof ref.name !== 'string') return null;
  // A group removed since then leaves a reference to a host outside this scope.
  if (resolveScope(ref.host, groups).key !== scope.key) return null;
  const current = activeRef(active[scope.key], scope.key);
  if (current && current.host === ref.host && current.name === ref.name) return null;
  const stored = (await getSnapshotsFor([ref.host]))[ref.host];
  if (!stored || !Object.hasOwn(stored, ref.name)) return null;
  return { entry: ref, snapshot: stored[ref.name] };
}

async function switchToPrevious(tab, redraw) {
  if (await popupIsOpen()) {
    flash(tab, redraw);
    return;
  }
  const host = httpHostOf(tab.url);
  if (host === null) return fail(tab, 'unavailable', redraw);

  const { settings, activeSnapshots: active, previousSnapshots: previous, groups } =
    await readKeys(['settings', 'activeSnapshots', 'previousSnapshots', 'groups']);
  const scope = resolveScope(host, groups);
  const types = settings.enabledTypes;
  // The popup opens on its permission panel, which says what to do.
  if (types.cookies && !await hasHostPermission(scope)) return fail(tab, null, redraw);
  // The popup asks before a load it cannot undo; one key press must not skip that.
  if (!settings.autoBackup) return fail(tab, 'shortcut_needs_backup', redraw);

  const found = await previousEntry(scope, active, previous, groups);
  if (!found) return fail(tab, 'shortcut_no_previous', redraw);
  const { entry, snapshot } = found;

  // Nobody watches a status line here, so a page that cannot take its data is
  // refused rather than loaded with the cookies only.
  if (!await canReachPage(tab.id, pageTypesOf(snapshot, types, entry.host, scope))) {
    return fail(tab, 'shortcut_page_unreachable', redraw);
  }

  const result = await loadWholeSnapshot({
    tab, scope, settings, entry, snapshot, activeBefore: active[scope.key] ?? null,
  });
  if (!result.backedUp) return fail(tab, 'shortcut_backup_failed', redraw);
  // With the badge off the switch would show nothing at all when auto reload is off
  // too, so the name is shown for a moment either way.
  if (!settings.showBadge) flash(tab, redraw, badgeText(entry.name));
}

async function runCommand(tab, redraw) {
  if (busy) return;
  busy = true;
  let target = tab;
  try {
    target ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (target) await switchToPrevious(target, redraw);
  } catch (e) {
    console.error(e);
    if (target) await fail(target, 'error_load_failed', redraw).catch(console.error);
  } finally {
    busy = false;
  }
}

// Added synchronously, so a command that wakes the worker finds its listener.
export function registerSwitchCommand({ redraw }) {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === COMMAND) return runCommand(tab, redraw);
  });
}
