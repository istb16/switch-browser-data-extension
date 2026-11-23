import { t, getLang } from '../lib/i18n.js';
import {
  orderedNames, saveSnapshot, deleteSnapshot, renameSnapshot,
  loadSnapshot, setActiveSnapshot, saveBackup, getBackup, updateSnapshotDetails,
} from '../lib/snapshot.js';
import { summarize, sizeOf } from '../lib/snapshot-summary.js';
import { readKeys, SNAPSHOT_PREFIX, BACKUP_PREFIX } from '../lib/storage.js';
import {
  collectData, applyData, clearData, canReachPage, requestHostPermission, cookieDomainFor,
} from '../lib/data-bridge.js';
import { cookiesWithin } from '../lib/cookie-handler.js';
import { memberHosts, activeRef } from '../lib/groups.js';
import { findChanges, withDigests, TYPE_LABELS } from '../lib/data-compare.js';
import { getVolatileCookiesFor, startCookieCheck, ignoreCookieChange, hasPendingCookieCheck, cancelCookieChecksFor } from '../lib/volatile-cookies.js';
import { otherSiteTabs, reloadTabs } from '../lib/site-tabs.js';
import { showConfirm, showFormDialog } from '../lib/dialog.js';
import { bindInlineRename } from '../lib/inline-rename.js';
import { $, showStatus, notify, reportError } from '../lib/ui.js';
import {
  state, entryId, sameEntry, snapshotOf, entryOfRow, activeValue, scopeLabel, comparable,
} from './context.js';
import { renderList, renderUndo, visibleMains, rowOf, focusRow, focusRowAt } from './list.js';
import { closeSaveForm, saveFormDetails, buildDetailFields } from './save-form.js';

// Every action runs alone: a double click or a key held down would otherwise
// start a second load while the first is still writing.
export async function exclusive(action) {
  if (state.busy) return false;
  state.dataVersion++;
  setBusy(true);
  try {
    await action();
  } finally {
    setBusy(false);
  }
  return true;
}

function setBusy(value) {
  state.busy = value;
  $('snapshotList').setAttribute('aria-busy', String(value));
  $('saveBtn').disabled = value;
  $('confirmSaveBtn').disabled = value;
  $('undoBtn').disabled = value;
  $('clearSiteBtn').disabled = value;
}

// Called first in each handler, before any other await, so the permission
// prompt still runs inside the click's user gesture.
async function ensureCookiePermission() {
  if (state.settings.enabledTypes.cookies) await requestHostPermission(state.scope);
}

// `lists` is what init() already read on open; later refreshes read it here.
export async function refresh(lists) {
  const { scope } = state;
  const { snapshotHosts, snapshotOrder, activeSnapshots } = lists
    ?? await readKeys(['snapshotHosts', 'snapshotOrder', 'activeSnapshots']);
  const listed = memberHosts(snapshotHosts, scope, state.groups);
  const backupKey = BACKUP_PREFIX + scope.host;
  const stored = await chrome.storage.local.get([
    ...listed.map(host => SNAPSHOT_PREFIX + host),
    ...(state.settings.autoBackup ? [backupKey] : []),
  ]);
  // A listed host whose key is missing was removed part-way; it has nothing to show.
  const hosts = listed.filter(host => (SNAPSHOT_PREFIX + host) in stored);
  state.snapshots = Object.fromEntries(hosts.map(host => [host, stored[SNAPSHOT_PREFIX + host]]));
  state.backup = stored[backupKey] ?? null;
  state.entries = hosts.flatMap(host => orderedNames(state.snapshots[host], snapshotOrder[host]).map(name => ({ host, name })));
  const now = Date.now();
  // Counts follow what a load applies here; the size stays that of the stored snapshot.
  state.summaries = new Map(state.entries.map(entry => [entryId(entry), {
    ...summarize(comparable(entry, snapshotOf(entry)), now),
    bytes: sizeOf(snapshotOf(entry)),
  }]));
  const ref = activeRef(activeSnapshots[scope.key] ?? null, scope.key);
  state.activeEntry = ref && state.snapshots[ref.host]?.[ref.name] ? { host: ref.host, name: ref.name } : null;
  if (!state.activeEntry) state.changes = [];
  renderList();
  renderUndo();
}

export async function detectChanges() {
  const entry = state.activeEntry;
  if (!entry) return;
  const { scope, settings, activeTab } = state;
  const version = state.dataVersion;
  const [current, volatile, learning] = await Promise.all([
    collectData(activeTab.id, scope, settings.enabledTypes, { interactive: false, digest: true }),
    getVolatileCookiesFor(scope.key),
    hasPendingCookieCheck(activeTab.id),
  ]);
  if (version !== state.dataVersion || !sameEntry(entry, state.activeEntry)) return;
  // Until the service worker has seen which cookies the site rewrites after the
  // load, those rewrites would all look like changes.
  const types = learning ? { ...settings.enabledTypes, cookies: false } : settings.enabledTypes;
  state.changes = findChanges(comparable(entry, snapshotOf(entry)), comparable(entry, current), types, volatile);
  if (state.changes.length) renderList();
}

export async function handleIgnoreCookie(entry, change) {
  if (!change) return;
  await ignoreCookieChange(state.scope.key, change);
  state.changes = state.changes.filter(c => c !== change);
  renderList();
  notify('status_cookie_ignored', { name: change.name });
  const row = rowOf(entry);
  (row?.querySelector('.badge--modified') ?? row?.querySelector('.snapshot__main'))?.focus();
}

export async function handleSaveNew() {
  let saved = false;
  await exclusive(async () => {
    const name = $('newSnapshotName').value.trim();
    if (!name) {
      notify('error_enter_name', {}, 'error');
      return;
    }
    await ensureCookiePermission();
    if (state.snapshots[state.scope.host]?.[name] && !await showConfirm(t('confirm_overwrite', { name }))) return;
    saved = await saveCurrentAs(name, saveFormDetails());
  });
  if (saved) closeSaveForm();
  else $('newSnapshotName').focus();
}

export async function handleOverwrite(entry) {
  await exclusive(async () => {
    await ensureCookiePermission();
    if (!await showConfirm(t('confirm_overwrite', { name: entry.name }))) return;
    await saveCurrentAs(entry.name);
  });
  focusRow(entry);
}

async function saveCurrentAs(name, details) {
  const { scope } = state;
  try {
    const data = await collectData(state.activeTab.id, scope, state.settings.enabledTypes);
    await saveSnapshot(scope.host, name, withDigests(data), details);
    await setActiveSnapshot(scope.key, activeValue({ host: scope.host, name }));
    state.changes = [];
    await refresh();
    notify('status_saved', { name });
    return true;
  } catch (e) {
    reportError('error_save_failed', e);
    return false;
  }
}

// Must run before the reload, so the service worker finds the check when the
// reloaded page completes. The service worker reloads `others` after it, so
// resolves with whether a check was started to do that.
// `storeKey` is the host the applied data is stored under (see applyData).
async function watchCookiesAfterApply(storeKey, data, cookiesApplied, others) {
  const { scope } = state;
  if (!state.settings.enabledTypes.cookies || !data.cookies || !cookiesApplied) return false;
  const within = cookieDomainFor(data, storeKey, scope);
  await startCookieCheck(state.activeTab.id, scope.key, cookiesWithin(data.cookies, within), {
    origins: scope.origins, cookieDomain: within.domain, cookieExact: within.exact,
    reloadTabs: others.map(tab => tab.id),
  });
  return true;
}

// The other tabs that see what was just written; `target` is as for otherSiteTabs.
async function selectOtherTabs(target) {
  const { settings, activeTab } = state;
  if (!settings.autoReload || !settings.reloadOtherTabs) return [];
  try {
    return otherSiteTabs(await chrome.tabs.query({}), activeTab, target);
  } catch (e) {
    console.error(e);
    return [];
  }
}

// Resolves with how many other tabs were reloaded, or handed to the service
// worker when `deferred`.
async function reloadAfterChange(others, deferred) {
  await reloadIfEnabled();
  if (deferred) return others.length;
  return reloadTabs(others.map(tab => tab.id));
}

function notifyDone(key, vars, count) {
  const suffix = count > 0 ? t('status_other_tabs_reloaded', { count }) : '';
  showStatus($('statusMsg'), t(key, vars) + suffix, 'success');
}

async function reloadAfterApply(storeKey, data, applied) {
  const within = cookieDomainFor(data, storeKey, state.scope);
  const others = await selectOtherTabs({
    sameOrigin: applied.storageApplied,
    cookieDomain: applied.cookiesApplied ? within.domain : null,
  });
  const deferred = await watchCookiesAfterApply(storeKey, data, applied.cookiesApplied, others);
  return reloadAfterChange(others, deferred);
}

// The backup is a convenience: a full chrome.storage.local must not cost the
// user the load itself, which then just cannot be undone.
async function tryBackup(data) {
  try {
    await saveBackup(state.scope.host, data, state.activeEntry && activeValue(state.activeEntry));
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// True with automatic backups off too, so the status does not warn of a missing backup.
async function backupCurrent() {
  if (!state.settings.autoBackup) return true;
  const current = await collectData(state.activeTab.id, state.scope, state.settings.enabledTypes, { interactive: false });
  return tryBackup(current);
}

async function reloadIfEnabled() {
  if (state.settings.autoReload) await chrome.tabs.reload(state.activeTab.id);
}

function loadedStatusKey(backedUp, storageSkipped) {
  if (storageSkipped) return backedUp ? 'status_loaded_cookies_only' : 'status_loaded_cookies_only_no_backup';
  return backedUp ? 'status_loaded' : 'status_loaded_no_backup';
}

export function handleLoad(entry) {
  const { name } = entry;
  return exclusive(async () => {
    const { scope, settings } = state;
    await ensureCookiePermission();
    // With a backup the load can be undone, so it runs without asking first.
    if (!settings.autoBackup && !await showConfirm(t('confirm_load', { name }))) return;

    const snapshot = await loadSnapshot(entry.host, name);
    if (!snapshot) return;

    try {
      const backedUp = await backupCurrent();
      const applied = await applyData(state.activeTab.id, scope, snapshot, settings.enabledTypes, entry.host);
      await setActiveSnapshot(scope.key, activeValue(entry));
      state.changes = [];
      const reloaded = await reloadAfterApply(entry.host, snapshot, applied);
      notifyDone(loadedStatusKey(backedUp, applied.storageSkipped), { name, host: entry.host }, reloaded);
    } catch (e) {
      reportError('error_load_failed', e);
    }
    await refresh();
    focusRow(entry);
  });
}

export function enabledTypeNames() {
  return Object.keys(TYPE_LABELS).filter(type => state.settings.enabledTypes[type]).map(type => TYPE_LABELS[type]);
}

export function handleClearSite() {
  return exclusive(async () => {
    const { scope, settings } = state;
    const types = settings.enabledTypes;
    const typeNames = enabledTypeNames().join(getLang() === 'ja' ? '・' : ', ');
    await ensureCookiePermission();
    const confirmKey = settings.autoBackup ? 'confirm_clear_site_undoable' : 'confirm_clear_site';
    if (!await showConfirm(t(confirmKey, { domain: scopeLabel(), types: typeNames }))) return;

    try {
      // Checked before the backup, so a page that can't be cleared never
      // replaces the backup that is still useful.
      if (!await canReachPage(state.activeTab.id, types)) throw new Error('content script unreachable');
      const backedUp = await backupCurrent();
      // A check left from a recent load, in this tab or any other tab sharing
      // the jar, would compare that snapshot's cookies with the emptied jar and
      // mark them all as rewritten by the site.
      let clearedCookies = null;
      const blocked = await clearData(state.activeTab.id, scope, types, {
        beforeCookies: async cookieScope => {
          clearedCookies = cookieScope;
          await cancelCookieChecksFor(cookieScope);
        },
      });
      await setActiveSnapshot(scope.key, null);
      state.changes = [];
      const others = await selectOtherTabs({
        sameOrigin: types.localStorage || types.sessionStorage || types.indexedDB,
        cookieDomain: clearedCookies?.domain ?? null,
      });
      const reloaded = await reloadAfterChange(others, false);
      let statusKey = backedUp ? 'status_site_cleared' : 'status_site_cleared_no_backup';
      if (blocked.length && !settings.autoReload) statusKey = 'status_site_cleared_reload_needed';
      notifyDone(statusKey, { domain: scopeLabel() }, reloaded);
    } catch (e) {
      reportError('error_clear_site_failed', e);
    }
    await refresh();
  });
}

// Restoring the backup first backs up what it replaces, so pressing it again
// swaps back.
export async function handleUndo() {
  await exclusive(async () => {
    const { scope } = state;
    await ensureCookiePermission();
    const backup = await getBackup(scope.host);
    if (!backup) return;

    const types = state.settings.enabledTypes;
    try {
      const current = await collectData(state.activeTab.id, scope, types, { interactive: false });
      const applied = await applyData(state.activeTab.id, scope, backup, types, scope.host);
      await tryBackup(current);
      const ref = activeRef(backup.activeName, scope.host);
      const restored = ref && snapshotOf(ref) ? { host: ref.host, name: ref.name } : null;
      await setActiveSnapshot(scope.key, restored && activeValue(restored));
      state.changes = restored
        ? findChanges(comparable(restored, snapshotOf(restored)), comparable(restored, backup), types, await getVolatileCookiesFor(scope.key))
        : [];
      const reloaded = await reloadAfterApply(scope.host, backup, applied);
      notifyDone('status_restored', {}, reloaded);
    } catch (e) {
      reportError('error_restore_failed', e);
    }
    await refresh();
  });
  if (!$('undoBar').classList.contains('hidden')) $('undoBtn').focus();
}

export async function handleDelete(entry) {
  const { name } = entry;
  const index = visibleMains().findIndex(main => sameEntry(entryOfRow(main.closest('.snapshot')), entry));
  let deleted = false;
  await exclusive(async () => {
    if (!await showConfirm(t('confirm_delete_snapshot', { name }))) return;
    await deleteSnapshot(entry.host, name);
    await refresh();
    notify('status_deleted', { name });
    deleted = true;
  });
  if (deleted) focusRowAt(index);
  else focusRow(entry);
}

export async function handleEditDetails(entry) {
  const { name } = entry;
  await exclusive(async () => {
    const snapshot = snapshotOf(entry);
    if (!snapshot) return;
    const fields = buildDetailFields(snapshot);
    const confirmed = await showFormDialog({
      title: t('edit_details_title', { name }),
      content: fields.content,
      confirmLabel: t('btn_save'),
    });
    if (!confirmed) return;
    try {
      await updateSnapshotDetails(entry.host, name, fields.read());
      await refresh();
      notify('status_details_saved', { name });
    } catch (e) {
      reportError('error_details_failed', e);
    }
  });
  focusRow(entry);
}

export function startRename(row, entry) {
  const { name } = entry;
  if (state.busy || row.querySelector('.snapshot__rename')) return;
  const main = row.querySelector('.snapshot__main');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'snapshot__rename';
  input.value = name;
  input.setAttribute('aria-label', t('rename_label'));
  main.querySelector('.snapshot__text').replaceChildren(input);
  // A button may not contain interactive content, so while the name is edited
  // the row trades its button for a plain container.
  const container = document.createElement('div');
  container.className = main.className;
  container.append(...main.childNodes);
  main.replaceWith(container);
  // The row's menu would act on the old name while it is being changed.
  row.querySelector('.snapshot__more').disabled = true;

  bindInlineRename(input, {
    oldName: name,
    exists: newName => Boolean(state.snapshots[entry.host]?.[newName]),
    onError: msg => {
      if (msg) showStatus($('statusMsg'), msg, 'error');
    },
    onCancel: () => {
      renderList();
      focusRow(entry);
    },
    onCommit: async newName => {
      const ran = await exclusive(async () => {
        await renameSnapshot(entry.host, name, newName);
        await refresh();
        notify('status_snapshot_renamed', { old: name, new: newName });
      });
      if (!ran) renderList();
      focusRow(ran ? { host: entry.host, name: newName } : entry);
    },
  });
  input.focus();
  input.select();
}
