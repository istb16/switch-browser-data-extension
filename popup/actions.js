import { t } from '../lib/i18n.js';
import {
  orderedNames, saveSnapshot, deleteSnapshot, renameSnapshot,
  loadSnapshot, setActiveSnapshot, saveBackup, getBackup, updateSnapshotDetails, replaceSnapshotFields,
} from '../lib/snapshot.js';
import { summarize, sizeOf } from '../lib/snapshot-summary.js';
import { readKeys, SNAPSHOT_PREFIX, BACKUP_PREFIX } from '../lib/storage.js';
import {
  collectData, applyData, clearData, canReachPage, requestHostPermission,
} from '../lib/data-bridge.js';
import { memberHosts, activeRef } from '../lib/groups.js';
import { findChanges, withDigests } from '../lib/data-compare.js';
import { DATA_TYPES } from '../lib/data-types.js';
import { getVolatileCookiesFor, ignoreCookieChange, hasPendingCookieCheck, cancelCookieChecksFor } from '../lib/volatile-cookies.js';
import { selectOtherTabs, reloadAfterChange, reloadAfterApply } from '../lib/tab-reload.js';
import { showConfirm, showFormDialog } from '../lib/dialog.js';
import { bindInlineRename } from '../lib/inline-rename.js';
import { $, showStatus, notify, reportError } from '../lib/ui.js';
import {
  state, entryId, sameEntry, snapshotOf, entryOfRow, activeValue, scopeLabel, comparable,
  listedEntry, enabledOf, comparedTypes, loadableTypes, typeNamesOf,
} from './context.js';
import { renderList, renderUndo, visibleMains, rowOf, focusRow, focusRowAt } from './list.js';
import { closeSaveForm, saveFormDetails, buildDetailFields } from './save-form.js';
import { buildTypePicker } from './type-picker.js';

const TYPE_FIELDS = {
  cookies: ['cookies', 'cookieDomain'],
  localStorage: ['localStorage'],
  sessionStorage: ['sessionStorage'],
  indexedDB: ['indexedDB', 'indexedDBDigest'],
};

// Every action runs alone: a double click or a key held down would otherwise
// start a second load while the first is still writing.
async function exclusive(action) {
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
  state.activeEntry = listedEntry(activeRef(activeSnapshots[scope.key] ?? null, scope.key));
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
  const compared = comparedTypes(entry.types);
  const types = learning ? { ...compared, cookies: false } : compared;
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
      notify('error_empty_name', {}, 'error');
      return;
    }
    await ensureCookiePermission();
    if (state.snapshots[state.scope.host]?.[name] && !await confirmOverwrite(name)) return;
    saved = await saveCurrentAs(name, saveFormDetails());
  });
  if (saved) closeSaveForm();
  else $('newSnapshotName').focus();
}

export async function handleOverwrite(entry) {
  await exclusive(async () => {
    await ensureCookiePermission();
    if (!await confirmOverwrite(entry.name)) return;
    await saveCurrentAs(entry.name);
  });
  focusRow(entry);
}

function isPartlyActive(name) {
  const active = state.activeEntry;
  return Boolean(active?.types && active.host === state.scope.host && active.name === name);
}

async function confirmOverwrite(name) {
  if (!isPartlyActive(name)) return showConfirm(t('confirm_overwrite', { name }));
  const types = enabledOf(state.activeEntry.types);
  if (!types.length) {
    notify('error_overwrite_no_types', {}, 'error');
    return false;
  }
  return showConfirm(t('confirm_overwrite_partial', { name, types: typeNamesOf(types) }));
}

// Only the types loaded from the snapshot are taken from the page: the rest of
// the page may belong to another account and never came from this snapshot.
// Resolves with the types it replaced.
async function overwritePartly(name, details) {
  const { scope } = state;
  const { types } = state.activeEntry;
  const collected = withDigests(await collectData(state.activeTab.id, scope, comparedTypes(types)));
  const replaced = types.filter(type => type in collected);
  // Saving the snapshot unchanged would report a save that captured nothing.
  if (!replaced.length) throw new Error('no recorded type could be read');
  const fields = {};
  const removed = [];
  for (const field of replaced.flatMap(type => TYPE_FIELDS[type])) {
    if (field in collected) fields[field] = collected[field];
    else removed.push(field);
  }
  // A full save here would store the types never loaded from it after all.
  if (!await replaceSnapshotFields(scope.host, name, fields, removed, details)) throw new Error('snapshot is gone');
  await setActiveSnapshot(scope.key, activeValue({ host: scope.host, name, types }));
  return replaced;
}

async function saveCurrentAs(name, details) {
  const { scope } = state;
  try {
    let replaced = null;
    let wanted = 0;
    if (isPartlyActive(name)) {
      wanted = enabledOf(state.activeEntry.types).length;
      replaced = await overwritePartly(name, details);
    } else {
      const data = await collectData(state.activeTab.id, scope, state.settings.enabledTypes);
      await saveSnapshot(scope.host, name, withDigests(data), details);
      await setActiveSnapshot(scope.key, activeValue({ host: scope.host, name }));
    }
    // A recorded type the page could not give still differs from what is stored.
    state.changes = replaced ? state.changes.filter(change => !replaced.includes(change.type)) : [];
    await refresh();
    if (replaced && replaced.length < wanted) {
      notify('status_saved_partial', { name, types: typeNamesOf(replaced) });
    } else {
      notify('status_saved', { name });
    }
    return true;
  } catch (e) {
    reportError('error_save_failed', e);
    return false;
  }
}

function notifyDone(key, vars, count) {
  const suffixKey = count === 1 ? 'status_other_tab_reloaded' : 'status_other_tabs_reloaded';
  const suffix = count > 0 ? t(suffixKey, { count }) : '';
  showStatus($('statusMsg'), t(key, vars) + suffix, 'success');
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

function loadedStatusKey(backedUp, storageSkipped, partial) {
  if (partial) return backedUp ? 'status_loaded_partial' : 'status_loaded_partial_no_backup';
  if (storageSkipped) return backedUp ? 'status_loaded_cookies_only' : 'status_loaded_cookies_only_no_backup';
  return backedUp ? 'status_loaded' : 'status_loaded_no_backup';
}

export function handleLoad(entry) {
  const { name } = entry;
  return exclusive(async () => {
    await ensureCookiePermission();
    // With a backup the load can be undone, so it runs without asking first.
    if (!state.settings.autoBackup && !await showConfirm(t('confirm_load', { name }))) return;
    await loadEntry(entry);
  });
}

// The types a partial load leaves recorded: what it applied, added to what an
// earlier partial load of the same snapshot applied. Covering every loadable
// type makes it a full record again.
function recordAfterPartialLoad(entry, applied) {
  const active = state.activeEntry;
  const types = sameEntry(entry, active) && active.types
    ? DATA_TYPES.filter(type => active.types.includes(type) || applied.includes(type))
    : applied;
  const full = loadableTypes(entry).every(type => types.includes(type));
  return full ? { host: entry.host, name: entry.name } : { host: entry.host, name: entry.name, types };
}

// The types a partial load writes, or null for a full load.
function pickTypes(entry, chosen) {
  if (!chosen) return null;
  const loadable = loadableTypes(entry);
  const picked = loadable.filter(type => chosen.includes(type));
  if (!picked.length) throw new Error('no loadable type chosen');
  // Every loadable type chosen is a full load, with nothing partial about it.
  return picked.length === loadable.length ? null : picked;
}

function partialOutcome(entry, picked, applied) {
  if (!picked) return { record: { host: entry.host, name: entry.name }, appliedTypes: null, kept: [] };
  const appliedTypes = picked.filter(type => (type === 'cookies' ? applied.cookiesApplied : applied.storageApplied));
  if (!appliedTypes.length) throw new Error('nothing was applied');
  const record = recordAfterPartialLoad(entry, appliedTypes);
  // Types an earlier partial load of this snapshot recorded stay compared,
  // and this load left their differences as they were.
  const active = state.activeEntry;
  const kept = sameEntry(entry, active) && active.types
    ? state.changes.filter(change => !appliedTypes.includes(change.type))
    : [];
  return { record, appliedTypes, kept };
}

export async function loadEntry(entry, chosen) {
  const { scope, settings } = state;
  const { name } = entry;
  const snapshot = await loadSnapshot(entry.host, name);
  if (!snapshot) return;

  try {
    const picked = pickTypes(entry, chosen);
    const types = picked ? comparedTypes(picked) : settings.enabledTypes;
    // Checked before the backup, so a page that can't take the data never
    // replaces the backup that is still useful.
    if (picked && !types.cookies && !await canReachPage(state.activeTab.id, types)) throw new Error('content script unreachable');
    const backedUp = await backupCurrent();
    const applied = await applyData(state.activeTab.id, scope, snapshot, types, entry.host);
    const { record, appliedTypes, kept } = partialOutcome(entry, picked, applied);
    await setActiveSnapshot(scope.key, activeValue(record));
    state.changes = kept;
    const reloaded = await reloadAfterApply({
      tab: state.activeTab, scope, settings, storeKey: entry.host, data: snapshot,
    }, applied);
    const vars = { name, host: entry.host, ...(appliedTypes && { types: typeNamesOf(appliedTypes) }) };
    notifyDone(loadedStatusKey(backedUp, applied.storageSkipped, Boolean(appliedTypes)), vars, reloaded);
  } catch (e) {
    reportError('error_load_failed', e);
  }
  await refresh();
  focusRow(entry);
}

export async function handleLoadPartial(entry) {
  if (entry.host !== state.scope.host || loadableTypes(entry).length < 2) return;
  await exclusive(async () => {
    await ensureCookiePermission();
    const picker = buildTypePicker(
      loadableTypes(entry),
      state.settings.autoBackup ? null : t('load_partial_no_undo'),
    );
    const confirmed = await showFormDialog({
      title: t('load_partial_title', { name: entry.name }),
      content: picker.content,
      confirmLabel: t('btn_load'),
      validate: () => (picker.read().length ? null : t('error_choose_type')),
    });
    if (!confirmed) {
      focusRow(entry);
      return;
    }
    await loadEntry(entry, picker.read());
  });
}

async function clearSite(types) {
  const { scope, settings } = state;
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
  const others = await selectOtherTabs(state.activeTab, settings, {
    sameOrigin: types.localStorage || types.indexedDB,
    cookieDomain: clearedCookies?.domain ?? null,
  });
  const reloaded = await reloadAfterChange(state.activeTab, settings, others, false);
  return { backedUp, blocked, reloaded };
}

export function handleClearSite() {
  return exclusive(async () => {
    const { settings } = state;
    const types = settings.enabledTypes;
    const typeNames = typeNamesOf(enabledOf(DATA_TYPES));
    await ensureCookiePermission();
    const confirmKey = settings.autoBackup ? 'confirm_clear_site_undoable' : 'confirm_clear_site';
    if (!await showConfirm(t(confirmKey, { domain: scopeLabel(), types: typeNames }))) return;

    try {
      const { backedUp, blocked, reloaded } = await clearSite(types);
      let statusKey = backedUp ? 'status_site_cleared' : 'status_site_cleared_no_backup';
      if (blocked.length && !settings.autoReload) statusKey = 'status_site_cleared_reload_needed';
      notifyDone(statusKey, { domain: scopeLabel() }, reloaded);
    } catch (e) {
      reportError('error_clear_site_failed', e);
    }
    await refresh();
  });
}

// The listed snapshot the backup was taken under, with the types it recorded.
function restoredEntry(backup) {
  return listedEntry(activeRef(backup.activeName, state.scope.host));
}

async function changesAgainst(entry, data) {
  return findChanges(
    comparable(entry, snapshotOf(entry)),
    comparable(entry, data),
    comparedTypes(entry.types),
    await getVolatileCookiesFor(state.scope.key),
  );
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
      const restored = restoredEntry(backup);
      await setActiveSnapshot(scope.key, restored && activeValue(restored));
      state.changes = restored ? await changesAgainst(restored, backup) : [];
      const reloaded = await reloadAfterApply({
        tab: state.activeTab, scope, settings: state.settings, storeKey: scope.host, data: backup,
      }, applied);
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
    notify('status_snapshot_deleted', { name });
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
