import { initI18n, t, applyI18n, getLang } from '../lib/i18n.js';
import {
  getSnapshotsForDomain, getOrderedSnapshotNames, saveSnapshot, deleteSnapshot, renameSnapshot,
  loadSnapshot, getActiveSnapshot, setActiveSnapshot, saveBackup, getBackup,
} from '../lib/snapshot.js';
import { getSettings } from '../lib/storage.js';
import { collectData, applyData, clearData, canReachPage, requestHostPermission, hasHostPermission } from '../lib/data-bridge.js';
import { findChanges, describeChanges, withDigests, TYPE_LABELS } from '../lib/data-compare.js';
import { getVolatileCookiesFor, startCookieCheck, ignoreCookieChange, hasPendingCookieCheck, cancelCookieCheck } from '../lib/volatile-cookies.js';
import { showConfirm } from '../lib/dialog.js';
import { setupMenu } from '../lib/menu.js';
import { bindInlineRename } from '../lib/inline-rename.js';
import { formatRelative } from '../lib/time.js';
import { $, showStatus } from '../lib/ui.js';

// Below this many snapshots the whole list fits at a glance, so the search box
// would only add noise.
const SEARCH_MIN = 5;

let currentDomain = null;
let activeTab = null;
let settings = null;
let snapshots = {};
let names = [];
let activeName = null;
// What differs from the active snapshot (see findChanges); empty when nothing does.
let changes = [];
let busy = false;
// Bumped by every action that changes the page data or the active snapshot, so a
// change check that started before it can tell its result is stale.
let dataVersion = 0;

async function init() {
  await initI18n();
  applyI18n();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  const isRestrictedUrl = !tab?.url
    || tab.url.startsWith('chrome://')
    || tab.url.startsWith('edge://')
    || tab.url.startsWith('about:');

  if (isRestrictedUrl) {
    showUnavailable();
    return;
  }

  try {
    currentDomain = new URL(tab.url).hostname;
  } catch {
    showUnavailable();
    return;
  }

  $('currentDomain').textContent = currentDomain;
  settings = await getSettings();

  if (settings.enabledTypes.cookies && !await hasHostPermission(currentDomain)) {
    showPermissionPanel();
    return;
  }
  await showMain();
}

async function showMain() {
  $('permissionPanel').classList.add('hidden');
  $('mainContent').classList.remove('hidden');
  await refresh();
  // With every data type turned off there is nothing to clear.
  $('clearSiteBtn').classList.toggle('hidden', enabledTypeNames().length === 0);
  setupListeners();
  // Not awaited: the check reads the page, and the list is usable without it.
  detectChanges().catch(e => console.error(e));
}

// Chrome closes the popup as soon as its permission prompt appears, so asking in
// the middle of a save or load would drop that action without a word. Asking up
// front, with nothing else to lose, and telling the user to reopen avoids that.
function showPermissionPanel() {
  $('permissionPanel').classList.remove('hidden');
  $('grantPermissionBtn').addEventListener('click', async () => {
    $('permissionDenied').classList.add('hidden');
    // Where the popup survives the prompt (it is answered quickly, or the browser
    // keeps the popup open), carry on without making the user reopen it.
    if (await requestHostPermission(currentDomain)) await showMain();
    else $('permissionDenied').classList.remove('hidden');
  });
  $('skipCookiesBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function showUnavailable() {
  $('currentDomain').textContent = '-';
  $('unavailableMsg').classList.remove('hidden');
}

async function refresh() {
  const [domainSnapshots, orderedNames, active] = await Promise.all([
    getSnapshotsForDomain(currentDomain),
    getOrderedSnapshotNames(currentDomain),
    getActiveSnapshot(currentDomain),
  ]);
  snapshots = domainSnapshots;
  names = orderedNames;
  activeName = active && snapshots[active] ? active : null;
  if (!activeName) changes = [];
  renderList();
  await renderUndo();
}

async function detectChanges() {
  const name = activeName;
  if (!name) return;
  const version = dataVersion;
  const [current, volatile, learning] = await Promise.all([
    collectData(activeTab.id, currentDomain, settings.enabledTypes, { interactive: false, digest: true }),
    getVolatileCookiesFor(currentDomain),
    hasPendingCookieCheck(activeTab.id),
  ]);
  if (version !== dataVersion || name !== activeName) return;
  // Until the service worker has seen which cookies the site rewrites after the
  // load, those rewrites would all look like changes.
  const types = learning ? { ...settings.enabledTypes, cookies: false } : settings.enabledTypes;
  changes = findChanges(snapshots[name], current, types, volatile);
  if (changes.length) renderList();
}

function renderList() {
  const query = $('searchInput').value.trim().toLowerCase();
  const visible = query ? names.filter(n => n.toLowerCase().includes(query)) : names;

  $('searchBox').classList.toggle('hidden', names.length < SEARCH_MIN && !query);
  $('emptyState').classList.toggle('hidden', names.length > 0);
  $('noMatch').classList.toggle('hidden', names.length === 0 || visible.length > 0);

  const list = $('snapshotList');
  list.replaceChildren(...visible.map(buildRow));
}

function buildRow(name, index) {
  const row = $('snapshotRowTemplate').content.firstElementChild.cloneNode(true);
  const snapshot = snapshots[name];
  const isActive = name === activeName;
  row.dataset.name = name;
  row.classList.toggle('is-active', isActive);
  const isModified = isActive && changes.length > 0;
  row.classList.toggle('is-modified', isModified);

  row.querySelector('.snapshot__name').textContent = name;
  const meta = row.querySelector('.snapshot__meta');
  meta.textContent = formatRelative(snapshot.savedAt, getLang());
  meta.title = t('saved_at', { date: new Date(snapshot.savedAt).toLocaleString() });

  const activeBadge = row.querySelector('.badge--active');
  activeBadge.textContent = t('badge_active');
  activeBadge.classList.toggle('hidden', !isActive);
  const modifiedBadge = row.querySelector('.badge--modified');
  const changesMenu = row.querySelector('.changes-menu');
  if (isModified) setupChangesMenu(modifiedBadge, changesMenu, name, index);
  else changesMenu.remove();

  const key = row.querySelector('.snapshot__key');
  if (index < 9) key.textContent = String(index + 1);
  else key.remove();

  const trigger = row.querySelector('.snapshot__more');
  const menu = row.querySelector('.actions-menu');
  trigger.id = `snapshot-more-${index}`;
  menu.id = `snapshot-menu-${index}`;
  trigger.setAttribute('commandfor', menu.id);
  trigger.setAttribute('aria-label', t('btn_more', { name }));
  trigger.title = t('btn_more', { name });
  menu.querySelector('[focusgroup]').setAttribute('aria-labelledby', trigger.id);
  menu.querySelector('[data-action="overwrite"]').textContent = t('menu_overwrite');
  menu.querySelector('[data-action="rename"]').textContent = t('menu_rename');
  menu.querySelector('[data-action="delete"]').textContent = t('menu_delete');

  row.querySelector('.snapshot__main').addEventListener('click', () => handleLoad(name));
  setupMenu(trigger, menu, action => {
    if (action === 'overwrite') handleOverwrite(name);
    else if (action === 'rename') startRename(row, name);
    else if (action === 'delete') handleDelete(name);
  });

  return row;
}

async function renderUndo() {
  const backup = settings.autoBackup ? await getBackup(currentDomain) : null;
  $('undoBar').classList.toggle('hidden', !backup);
  if (backup) $('undoText').textContent = t('undo_text', { time: formatRelative(backup.savedAt, getLang()) });
}

// The "changed" badge opens a menu that names what changed and lets the user
// stop comparing a cookie the site keeps rewriting.
function setupChangesMenu(badge, menu, name, index) {
  const detail = t('modified_detail', { items: describeChanges(changes).join(' / ') });
  badge.textContent = t('badge_modified');
  badge.title = detail;
  badge.setAttribute('aria-label', `${t('badge_modified')}: ${detail}`);
  badge.classList.remove('hidden');
  badge.id = `snapshot-changes-${index}`;
  menu.id = `snapshot-changes-menu-${index}`;
  badge.setAttribute('commandfor', menu.id);

  const group = menu.querySelector('[focusgroup]');
  group.setAttribute('aria-labelledby', badge.id);
  const overwrite = group.querySelector('[data-action="overwrite"]');
  overwrite.textContent = t('menu_overwrite');
  const cookieChanges = changes.filter(c => c.type === 'cookies');
  if (cookieChanges.length) group.prepend(...cookieChanges.map(change => {
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.action = 'ignore';
    item.dataset.key = change.key;
    item.textContent = t('menu_ignore_cookie', { name: change.name });
    return item;
  }), document.createElement('hr'));

  setupMenu(badge, menu, (action, item) => {
    if (action === 'overwrite') handleOverwrite(name);
    else if (action === 'ignore') handleIgnoreCookie(name, changes.find(c => c.key === item.dataset.key));
  });
}

async function handleIgnoreCookie(name, change) {
  if (!change) return;
  await ignoreCookieChange(currentDomain, change);
  changes = changes.filter(c => c !== change);
  renderList();
  showStatus($('statusMsg'), t('status_cookie_ignored', { name: change.name }), 'success');
  const row = [...$('snapshotList').children].find(el => el.dataset.name === name);
  (row?.querySelector('.badge--modified') ?? row?.querySelector('.snapshot__main'))?.focus();
}

function visibleMains() {
  return [...$('snapshotList').querySelectorAll('.snapshot__main')];
}

function focusRow(name) {
  const row = [...$('snapshotList').children].find(el => el.dataset.name === name);
  row?.querySelector('.snapshot__main')?.focus();
}

// After a row disappears, keep keyboard users in the list: the row that took its
// place, else the one above, else the save button.
function focusRowAt(index) {
  const mains = visibleMains();
  (mains[index] ?? mains.at(-1) ?? $('saveBtn')).focus();
}

// Every action runs alone: a double click or a key held down would otherwise
// start a second load while the first is still writing.
async function exclusive(action) {
  if (busy) return false;
  dataVersion++;
  setBusy(true);
  try {
    await action();
  } finally {
    setBusy(false);
  }
  return true;
}

function setBusy(value) {
  busy = value;
  $('snapshotList').setAttribute('aria-busy', String(value));
  $('saveBtn').disabled = value;
  $('confirmSaveBtn').disabled = value;
  $('undoBtn').disabled = value;
  $('clearSiteBtn').disabled = value;
}

// Called first in each handler, before any other await, so the permission
// prompt still runs inside the click's user gesture.
async function ensureCookiePermission() {
  if (settings.enabledTypes.cookies) await requestHostPermission(currentDomain);
}

function setupListeners() {
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('saveBtn').addEventListener('click', openSaveForm);
  $('cancelSaveBtn').addEventListener('click', closeSaveForm);
  $('saveForm').addEventListener('submit', e => {
    e.preventDefault();
    handleSaveNew();
  });
  $('saveForm').addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSaveForm();
    }
  });

  $('undoBtn').addEventListener('click', handleUndo);
  $('clearSiteBtn').addEventListener('click', handleClearSite);

  $('searchInput').addEventListener('input', renderList);
  $('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // The Enter that confirms an IME conversion (Japanese input) must not load.
      // keyCode 229 covers Safari, which reports isComposing too late.
      if (e.isComposing || e.keyCode === 229) return;
      visibleMains()[0]?.click();
    } else if (e.key === 'Escape' && $('searchInput').value) {
      e.preventDefault();
      $('searchInput').value = '';
      renderList();
    }
  });

  document.addEventListener('keydown', handleShortcut);
}

function handleShortcut(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  const target = e.target;
  if (target.closest?.('[popover]')) return;
  const editable = target.matches?.('input, textarea, select, [contenteditable]');
  const mains = visibleMains();
  const searchVisible = !$('searchBox').classList.contains('hidden');

  if (e.key === '/' && !editable && searchVisible) {
    e.preventDefault();
    $('searchInput').focus();
    return;
  }

  if (!editable && /^[1-9]$/.test(e.key)) {
    const main = mains[Number(e.key) - 1];
    if (main) {
      e.preventDefault();
      main.click();
    }
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const down = e.key === 'ArrowDown';
    let next = null;
    if (target === $('searchInput')) {
      next = down ? mains[0] : null;
    } else {
      const index = mains.indexOf(target);
      if (index < 0) return;
      next = down ? mains[index + 1] : (mains[index - 1] ?? (searchVisible ? $('searchInput') : null));
    }
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  if (e.key === 'Delete' && mains.includes(target)) {
    e.preventDefault();
    handleDelete(target.closest('.snapshot').dataset.name);
  }
}

function openSaveForm() {
  $('saveBtn').classList.add('hidden');
  $('saveForm').classList.remove('hidden');
  $('newSnapshotName').focus();
}

function closeSaveForm() {
  $('saveForm').classList.add('hidden');
  $('saveBtn').classList.remove('hidden');
  $('newSnapshotName').value = '';
  $('saveBtn').focus();
}

async function handleSaveNew() {
  let saved = false;
  await exclusive(async () => {
    const name = $('newSnapshotName').value.trim();
    if (!name) {
      showStatus($('statusMsg'), t('error_enter_name'), 'error');
      return;
    }
    await ensureCookiePermission();
    if (snapshots[name] && !await showConfirm(t('confirm_overwrite', { name }))) return;
    saved = await saveCurrentAs(name);
  });
  if (saved) closeSaveForm();
  else $('newSnapshotName').focus();
}

async function handleOverwrite(name) {
  await exclusive(async () => {
    await ensureCookiePermission();
    if (!await showConfirm(t('confirm_overwrite', { name }))) return;
    await saveCurrentAs(name);
  });
  focusRow(name);
}

async function saveCurrentAs(name) {
  try {
    const data = await collectData(activeTab.id, currentDomain, settings.enabledTypes);
    await saveSnapshot(currentDomain, name, withDigests(data));
    await setActiveSnapshot(currentDomain, name);
    changes = [];
    await refresh();
    showStatus($('statusMsg'), t('status_saved', { name }), 'success');
    return true;
  } catch (e) {
    showStatus($('statusMsg'), t('error_save_failed'), 'error');
    console.error(e);
    return false;
  }
}

// Must run before the reload, so the service worker finds the check when the
// reloaded page completes.
async function watchCookiesAfterApply(data) {
  if (settings.enabledTypes.cookies && data.cookies) await startCookieCheck(activeTab.id, currentDomain, data.cookies);
}

// The backup is a convenience: a full chrome.storage.local must not cost the
// user the load itself, which then just cannot be undone.
async function tryBackup(data) {
  try {
    await saveBackup(currentDomain, data, activeName);
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function handleLoad(name) {
  return exclusive(async () => {
    await ensureCookiePermission();
    // With a backup the load can be undone, so it runs without asking first.
    if (!settings.autoBackup && !await showConfirm(t('confirm_load', { name }))) return;

    const snapshot = await loadSnapshot(currentDomain, name);
    if (!snapshot) return;

    const types = settings.enabledTypes;
    try {
      let backedUp = true;
      if (settings.autoBackup) {
        const current = await collectData(activeTab.id, currentDomain, types, { interactive: false });
        backedUp = await tryBackup(current);
      }
      await applyData(activeTab.id, currentDomain, snapshot, types);
      await setActiveSnapshot(currentDomain, name);
      changes = [];
      await watchCookiesAfterApply(snapshot);
      if (settings.autoReload) await chrome.tabs.reload(activeTab.id);
      showStatus($('statusMsg'), t(backedUp ? 'status_loaded' : 'status_loaded_no_backup', { name }), 'success');
    } catch (e) {
      showStatus($('statusMsg'), t('error_load_failed'), 'error');
      console.error(e);
    }
    await refresh();
    focusRow(name);
  });
}

function enabledTypeNames() {
  return Object.keys(TYPE_LABELS).filter(type => settings.enabledTypes[type]).map(type => TYPE_LABELS[type]);
}

function handleClearSite() {
  return exclusive(async () => {
    const types = settings.enabledTypes;
    const typeNames = enabledTypeNames().join(getLang() === 'ja' ? '・' : ', ');
    await ensureCookiePermission();
    const confirmKey = settings.autoBackup ? 'confirm_clear_site_undoable' : 'confirm_clear_site';
    if (!await showConfirm(t(confirmKey, { domain: currentDomain, types: typeNames }))) return;

    try {
      // Checked before the backup, so a page that can't be cleared never
      // replaces the backup that is still useful.
      if (!await canReachPage(activeTab.id, types)) throw new Error('content script unreachable');
      let backedUp = true;
      if (settings.autoBackup) {
        const current = await collectData(activeTab.id, currentDomain, types, { interactive: false });
        backedUp = await tryBackup(current);
      }
      const blocked = await clearData(activeTab.id, currentDomain, types);
      await setActiveSnapshot(currentDomain, null);
      changes = [];
      // A check left from a recent load would compare that snapshot's cookies
      // with the emptied jar and mark them all as rewritten by the site.
      await cancelCookieCheck(activeTab.id);
      if (settings.autoReload) await chrome.tabs.reload(activeTab.id);
      let statusKey = backedUp ? 'status_site_cleared' : 'status_site_cleared_no_backup';
      if (blocked.length && !settings.autoReload) statusKey = 'status_site_cleared_reload_needed';
      showStatus($('statusMsg'), t(statusKey, { domain: currentDomain }), 'success');
    } catch (e) {
      showStatus($('statusMsg'), t('error_clear_site_failed'), 'error');
      console.error(e);
    }
    await refresh();
  });
}

// Restoring the backup first backs up what it replaces, so pressing it again
// swaps back.
async function handleUndo() {
  await exclusive(async () => {
    await ensureCookiePermission();
    const backup = await getBackup(currentDomain);
    if (!backup) return;

    const types = settings.enabledTypes;
    try {
      const current = await collectData(activeTab.id, currentDomain, types, { interactive: false });
      await applyData(activeTab.id, currentDomain, backup, types);
      await tryBackup(current);
      const restoredName = backup.activeName && snapshots[backup.activeName] ? backup.activeName : null;
      await setActiveSnapshot(currentDomain, restoredName);
      changes = restoredName
        ? findChanges(snapshots[restoredName], backup, types, await getVolatileCookiesFor(currentDomain))
        : [];
      await watchCookiesAfterApply(backup);
      if (settings.autoReload) await chrome.tabs.reload(activeTab.id);
      showStatus($('statusMsg'), t('status_restored'), 'success');
    } catch (e) {
      showStatus($('statusMsg'), t('error_restore_failed'), 'error');
      console.error(e);
    }
    await refresh();
  });
  if (!$('undoBar').classList.contains('hidden')) $('undoBtn').focus();
}

async function handleDelete(name) {
  const index = visibleMains().findIndex(main => main.closest('.snapshot').dataset.name === name);
  let deleted = false;
  await exclusive(async () => {
    if (!await showConfirm(t('confirm_delete_snapshot', { name }))) return;
    await deleteSnapshot(currentDomain, name);
    await refresh();
    showStatus($('statusMsg'), t('status_deleted', { name }), 'success');
    deleted = true;
  });
  if (deleted) focusRowAt(index);
  else focusRow(name);
}

function startRename(row, name) {
  if (busy || row.querySelector('.snapshot__rename')) return;
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
    exists: newName => Boolean(snapshots[newName]),
    onError: msg => {
      if (msg) showStatus($('statusMsg'), msg, 'error');
    },
    onCancel: () => {
      renderList();
      focusRow(name);
    },
    onCommit: async newName => {
      const ran = await exclusive(async () => {
        await renameSnapshot(currentDomain, name, newName);
        await refresh();
        showStatus($('statusMsg'), t('status_snapshot_renamed', { old: name, new: newName }), 'success');
      });
      if (!ran) renderList();
      focusRow(ran ? newName : name);
    },
  });
  input.focus();
  input.select();
}

// setupListeners() runs partway through init(), after several awaits, so a click
// that lands before then hits a live-looking button and silently does nothing.
// E2E tests wait on this flag before touching the static buttons.
init().finally(() => document.body.setAttribute('data-ready', 'true'));
