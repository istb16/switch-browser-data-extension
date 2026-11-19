import { initI18n, t, applyI18n, getLang } from '../lib/i18n.js';
import {
  orderedNames, saveSnapshot, deleteSnapshot, renameSnapshot,
  loadSnapshot, getActiveSnapshot, setActiveSnapshot, saveBackup, getBackup, updateSnapshotDetails,
} from '../lib/snapshot.js';
import { summarize, byteSize, formatBytes, SNAPSHOT_COLORS, MEMO_MAX } from '../lib/snapshot-summary.js';
import { getSettings, getSnapshots, getSnapshotOrders, getGroups } from '../lib/storage.js';
import {
  collectData, applyData, clearData, canReachPage, requestHostPermission, hasHostPermission, cookieDomainFor,
} from '../lib/data-bridge.js';
import { cookiesWithin } from '../lib/cookie-handler.js';
import { resolveScope, memberHosts, activeRef } from '../lib/groups.js';
import { findChanges, describeChanges, withDigests, TYPE_LABELS } from '../lib/data-compare.js';
import { getVolatileCookiesFor, startCookieCheck, ignoreCookieChange, hasPendingCookieCheck, cancelCookieChecksFor } from '../lib/volatile-cookies.js';
import { showConfirm, showFormDialog } from '../lib/dialog.js';
import { setupMenu } from '../lib/menu.js';
import { bindInlineRename } from '../lib/inline-rename.js';
import { formatRelative } from '../lib/time.js';
import { $, showStatus } from '../lib/ui.js';

// Below this many snapshots the whole list fits at a glance, so the search box
// would only add noise.
const SEARCH_MIN = 5;

// Short forms keep the preview on one line; the tooltip spells them out.
const PREVIEW_LABELS = { cookies: 'Cookie', localStorage: 'LS', sessionStorage: 'SS', indexedDB: 'IDB' };

// See resolveScope() in lib/groups.js: `host` is the tab's host, `key` the group
// base (or the host outside a group).
let scope = null;
let groups = [];
let activeTab = null;
let settings = null;
// Snapshots of every listed host: { host: { name: snapshot } }.
let snapshots = {};
// The listed rows, { host, name }; in a group they come from every member host.
let entries = [];
// Per-entry summarize() results, computed once per refresh rather than per render,
// since search re-renders on every keystroke.
let summaries = new Map();
let activeEntry = null;
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

  let host;
  try {
    host = new URL(tab.url).hostname;
  } catch {
    showUnavailable();
    return;
  }

  $('currentDomain').textContent = host;
  [settings, groups] = await Promise.all([getSettings(), getGroups()]);
  scope = resolveScope(host, groups);
  if (scope.group) {
    const chip = $('groupChip');
    chip.textContent = t('group_chip', { group: scope.group });
    chip.title = t('group_chip_title', { group: scope.group });
    chip.classList.remove('hidden');
  }

  if (settings.enabledTypes.cookies && !await hasHostPermission(scope)) {
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
  if (scope.group) $('permissionBody').textContent = t('permission_body_group', { group: scope.group });
  $('grantPermissionBtn').addEventListener('click', async () => {
    $('permissionDenied').classList.add('hidden');
    // Where the popup survives the prompt (it is answered quickly, or the browser
    // keeps the popup open), carry on without making the user reopen it.
    if (await requestHostPermission(scope)) await showMain();
    else $('permissionDenied').classList.remove('hidden');
  });
  $('skipCookiesBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function showUnavailable() {
  $('currentDomain').textContent = '-';
  $('unavailableMsg').classList.remove('hidden');
}

const entryId = entry => `${entry.host}\n${entry.name}`;
const sameEntry = (a, b) => Boolean(a && b && a.host === b.host && a.name === b.name);
const snapshotOf = entry => snapshots[entry.host]?.[entry.name];
const entryOfRow = row => ({ host: row.dataset.host, name: row.dataset.name });

// In a group the active snapshot is one reference for every member host, so it
// has to say which host's snapshot it is.
function activeValue(entry) {
  return scope.group ? { host: entry.host, name: entry.name } : entry.name;
}

function scopeLabel() {
  return scope.group ? t('scope_label_group', { host: scope.host, group: scope.group }) : scope.host;
}

// What of `data` this entry's snapshot can be compared on here: the cookies it
// was captured with (never wider than this scope), and page data only when it
// was saved on this host, since that is all a load of it applies.
function comparable(entry, data) {
  const result = { ...data };
  if (data.cookies) result.cookies = cookiesWithin(data.cookies, cookieDomainFor(snapshotOf(entry), entry.host, scope));
  if (entry.host !== scope.host) {
    for (const type of ['localStorage', 'sessionStorage', 'indexedDB', 'indexedDBDigest']) delete result[type];
  }
  return result;
}

async function refresh() {
  const [allSnapshots, allOrders, active] = await Promise.all([
    getSnapshots(), getSnapshotOrders(), getActiveSnapshot(scope.key),
  ]);
  const hosts = memberHosts(Object.keys(allSnapshots), scope, groups);
  snapshots = Object.fromEntries(hosts.map(host => [host, allSnapshots[host]]));
  entries = hosts.flatMap(host => orderedNames(allSnapshots[host], allOrders[host]).map(name => ({ host, name })));
  const now = Date.now();
  // Counts follow what a load applies here; the size stays that of the stored snapshot.
  summaries = new Map(entries.map(entry => [entryId(entry), {
    ...summarize(comparable(entry, snapshotOf(entry)), now),
    bytes: byteSize(snapshotOf(entry)),
  }]));
  const ref = activeRef(active, scope.key);
  activeEntry = ref && snapshots[ref.host]?.[ref.name] ? { host: ref.host, name: ref.name } : null;
  if (!activeEntry) changes = [];
  renderList();
  await renderUndo();
}

async function detectChanges() {
  const entry = activeEntry;
  if (!entry) return;
  const version = dataVersion;
  const [current, volatile, learning] = await Promise.all([
    collectData(activeTab.id, scope, settings.enabledTypes, { interactive: false, digest: true }),
    getVolatileCookiesFor(scope.key),
    hasPendingCookieCheck(activeTab.id),
  ]);
  if (version !== dataVersion || !sameEntry(entry, activeEntry)) return;
  // Until the service worker has seen which cookies the site rewrites after the
  // load, those rewrites would all look like changes.
  const types = learning ? { ...settings.enabledTypes, cookies: false } : settings.enabledTypes;
  changes = findChanges(comparable(entry, snapshotOf(entry)), comparable(entry, current), types, volatile);
  if (changes.length) renderList();
}

function renderList() {
  const query = $('searchInput').value.trim().toLowerCase();
  const matches = entry => entry.name.toLowerCase().includes(query)
    || Boolean(snapshotOf(entry).memo?.toLowerCase().includes(query));
  const visible = query ? entries.filter(matches) : entries;

  $('searchBox').classList.toggle('hidden', entries.length < SEARCH_MIN && !query);
  $('emptyState').classList.toggle('hidden', entries.length > 0);
  $('noMatch').classList.toggle('hidden', entries.length === 0 || visible.length > 0);

  const list = $('snapshotList');
  list.replaceChildren(...visible.map(buildRow));
}

function buildRow(entry, index) {
  const { name } = entry;
  const row = $('snapshotRowTemplate').content.firstElementChild.cloneNode(true);
  const snapshot = snapshotOf(entry);
  const isActive = sameEntry(entry, activeEntry);
  const isForeign = entry.host !== scope.host;
  row.dataset.host = entry.host;
  row.dataset.name = name;
  row.classList.toggle('is-active', isActive);
  const isModified = isActive && changes.length > 0;
  row.classList.toggle('is-modified', isModified);

  row.querySelector('.snapshot__name').textContent = name;
  const host = row.querySelector('.snapshot__host');
  if (isForeign) {
    host.textContent = entry.host;
    host.title = t('row_host_title', { host: entry.host });
    host.classList.remove('hidden');
  } else {
    host.remove();
  }
  const meta = row.querySelector('.snapshot__meta');
  meta.textContent = formatRelative(snapshot.savedAt, getLang());
  meta.title = t('saved_at', { date: new Date(snapshot.savedAt).toLocaleString() });
  renderDetails(row, snapshot, summaries.get(entryId(entry)));

  const activeBadge = row.querySelector('.badge--active');
  activeBadge.textContent = t('badge_active');
  activeBadge.classList.toggle('hidden', !isActive);
  const modifiedBadge = row.querySelector('.badge--modified');
  const changesMenu = row.querySelector('.changes-menu');
  if (isModified) setupChangesMenu(modifiedBadge, changesMenu, entry, index);
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
  menu.querySelector('[data-action="edit"]').textContent = t('menu_edit_details');
  menu.querySelector('[data-action="delete"]').textContent = t('menu_delete');
  // Overwriting would store this page's data under the other host's key.
  if (isForeign) menu.querySelector('[data-action="overwrite"]').remove();

  row.querySelector('.snapshot__main').addEventListener('click', () => handleLoad(entry));
  setupMenu(trigger, menu, action => {
    if (action === 'overwrite') handleOverwrite(entry);
    else if (action === 'rename') startRename(row, entry);
    else if (action === 'edit') handleEditDetails(entry);
    else if (action === 'delete') handleDelete(entry);
  });

  return row;
}

function renderDetails(row, snapshot, summary) {
  const chip = row.querySelector('.snapshot__chip');
  if (SNAPSHOT_COLORS.includes(snapshot.color)) {
    chip.classList.add(`snapshot__chip--${snapshot.color}`);
    chip.setAttribute('aria-label', t('chip_label', { color: t(`color_${snapshot.color}`) }));
    chip.classList.remove('hidden');
  } else {
    chip.remove();
  }

  const memo = row.querySelector('.snapshot__memo');
  if (typeof snapshot.memo === 'string' && snapshot.memo) {
    memo.textContent = snapshot.memo;
    memo.title = snapshot.memo;
    memo.classList.remove('hidden');
  } else {
    memo.remove();
  }

  const types = Object.keys(PREVIEW_LABELS).filter(type => summary[type] !== null);
  const size = formatBytes(summary.bytes);
  const preview = row.querySelector('.snapshot__preview');
  preview.textContent = [...types.map(type => `${PREVIEW_LABELS[type]} ${summary[type]}`), size].join(' · ');
  preview.title = types.length
    ? t('preview_title', { items: types.map(type => `${TYPE_LABELS[type]} ${summary[type]}`).join(' · '), size })
    : t('preview_size', { size });

  const warning = row.querySelector('.snapshot__warning');
  if (summary.expiredCookies > 0) {
    const text = t('warning_expired_cookies', { n: summary.expiredCookies });
    warning.title = text;
    warning.setAttribute('aria-label', text);
    warning.classList.remove('hidden');
  } else {
    warning.remove();
  }
}

async function renderUndo() {
  const backup = settings.autoBackup ? await getBackup(scope.host) : null;
  $('undoBar').classList.toggle('hidden', !backup);
  if (backup) $('undoText').textContent = t('undo_text', { time: formatRelative(backup.savedAt, getLang()) });
}

// The "changed" badge opens a menu that names what changed and lets the user
// stop comparing a cookie the site keeps rewriting.
function setupChangesMenu(badge, menu, entry, index) {
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
  const canOverwrite = entry.host === scope.host;
  if (!canOverwrite) overwrite.remove();
  const cookieChanges = changes.filter(c => c.type === 'cookies');
  if (cookieChanges.length) group.prepend(...cookieChanges.map(change => {
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.action = 'ignore';
    item.dataset.key = change.key;
    item.textContent = t('menu_ignore_cookie', { name: change.name });
    return item;
  }), ...(canOverwrite ? [document.createElement('hr')] : []));

  setupMenu(badge, menu, (action, item) => {
    if (action === 'overwrite') handleOverwrite(entry);
    else if (action === 'ignore') handleIgnoreCookie(entry, changes.find(c => c.key === item.dataset.key));
  });
}

async function handleIgnoreCookie(entry, change) {
  if (!change) return;
  await ignoreCookieChange(scope.key, change);
  changes = changes.filter(c => c !== change);
  renderList();
  showStatus($('statusMsg'), t('status_cookie_ignored', { name: change.name }), 'success');
  const row = rowOf(entry);
  (row?.querySelector('.badge--modified') ?? row?.querySelector('.snapshot__main'))?.focus();
}

function visibleMains() {
  return [...$('snapshotList').querySelectorAll('.snapshot__main')];
}

function rowOf(entry) {
  return [...$('snapshotList').children].find(el => sameEntry(entryOfRow(el), entry));
}

function focusRow(entry) {
  rowOf(entry)?.querySelector('.snapshot__main')?.focus();
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
  if (settings.enabledTypes.cookies) await requestHostPermission(scope);
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
    handleDelete(entryOfRow(target.closest('.snapshot')));
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
  $('newSnapshotMemo').value = '';
  $('saveForm').querySelector('input[name="newSnapshotColor"][value=""]').checked = true;
  $('saveBtn').focus();
}

// Only what the user filled in, so saving over an existing name keeps the
// memo and colour it already has.
function saveFormDetails() {
  const details = {};
  const memo = $('newSnapshotMemo').value.trim();
  const color = $('saveForm').querySelector('input[name="newSnapshotColor"]:checked')?.value;
  if (memo) details.memo = memo;
  if (color) details.color = color;
  return details;
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
    if (snapshots[scope.host]?.[name] && !await showConfirm(t('confirm_overwrite', { name }))) return;
    saved = await saveCurrentAs(name, saveFormDetails());
  });
  if (saved) closeSaveForm();
  else $('newSnapshotName').focus();
}

async function handleOverwrite(entry) {
  await exclusive(async () => {
    await ensureCookiePermission();
    if (!await showConfirm(t('confirm_overwrite', { name: entry.name }))) return;
    await saveCurrentAs(entry.name);
  });
  focusRow(entry);
}

async function saveCurrentAs(name, details) {
  try {
    const data = await collectData(activeTab.id, scope, settings.enabledTypes);
    await saveSnapshot(scope.host, name, withDigests(data), details);
    await setActiveSnapshot(scope.key, activeValue({ host: scope.host, name }));
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
// `storeKey` is the host the applied data is stored under (see applyData).
async function watchCookiesAfterApply(storeKey, data) {
  if (!settings.enabledTypes.cookies || !data.cookies) return;
  const within = cookieDomainFor(data, storeKey, scope);
  await startCookieCheck(activeTab.id, scope.key, cookiesWithin(data.cookies, within), {
    origins: scope.origins, cookieDomain: within.domain, cookieExact: within.exact,
  });
}

// The backup is a convenience: a full chrome.storage.local must not cost the
// user the load itself, which then just cannot be undone.
async function tryBackup(data) {
  try {
    await saveBackup(scope.host, data, activeEntry && activeValue(activeEntry));
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function loadedStatusKey(backedUp, storageSkipped) {
  if (storageSkipped) return backedUp ? 'status_loaded_cookies_only' : 'status_loaded_cookies_only_no_backup';
  return backedUp ? 'status_loaded' : 'status_loaded_no_backup';
}

function handleLoad(entry) {
  const { name } = entry;
  return exclusive(async () => {
    await ensureCookiePermission();
    // With a backup the load can be undone, so it runs without asking first.
    if (!settings.autoBackup && !await showConfirm(t('confirm_load', { name }))) return;

    const snapshot = await loadSnapshot(entry.host, name);
    if (!snapshot) return;

    const types = settings.enabledTypes;
    try {
      let backedUp = true;
      if (settings.autoBackup) {
        const current = await collectData(activeTab.id, scope, types, { interactive: false });
        backedUp = await tryBackup(current);
      }
      const { storageSkipped } = await applyData(activeTab.id, scope, snapshot, types, entry.host);
      await setActiveSnapshot(scope.key, activeValue(entry));
      changes = [];
      await watchCookiesAfterApply(entry.host, snapshot);
      if (settings.autoReload) await chrome.tabs.reload(activeTab.id);
      showStatus($('statusMsg'), t(loadedStatusKey(backedUp, storageSkipped), { name, host: entry.host }), 'success');
    } catch (e) {
      showStatus($('statusMsg'), t('error_load_failed'), 'error');
      console.error(e);
    }
    await refresh();
    focusRow(entry);
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
    if (!await showConfirm(t(confirmKey, { domain: scopeLabel(), types: typeNames }))) return;

    try {
      // Checked before the backup, so a page that can't be cleared never
      // replaces the backup that is still useful.
      if (!await canReachPage(activeTab.id, types)) throw new Error('content script unreachable');
      let backedUp = true;
      if (settings.autoBackup) {
        const current = await collectData(activeTab.id, scope, types, { interactive: false });
        backedUp = await tryBackup(current);
      }
      // A check left from a recent load, in this tab or any other tab sharing
      // the jar, would compare that snapshot's cookies with the emptied jar and
      // mark them all as rewritten by the site.
      const blocked = await clearData(activeTab.id, scope, types, { beforeCookies: cancelCookieChecksFor });
      await setActiveSnapshot(scope.key, null);
      changes = [];
      if (settings.autoReload) await chrome.tabs.reload(activeTab.id);
      let statusKey = backedUp ? 'status_site_cleared' : 'status_site_cleared_no_backup';
      if (blocked.length && !settings.autoReload) statusKey = 'status_site_cleared_reload_needed';
      showStatus($('statusMsg'), t(statusKey, { domain: scopeLabel() }), 'success');
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
    const backup = await getBackup(scope.host);
    if (!backup) return;

    const types = settings.enabledTypes;
    try {
      const current = await collectData(activeTab.id, scope, types, { interactive: false });
      await applyData(activeTab.id, scope, backup, types, scope.host);
      await tryBackup(current);
      const ref = activeRef(backup.activeName, scope.host);
      const restored = ref && snapshotOf(ref) ? { host: ref.host, name: ref.name } : null;
      await setActiveSnapshot(scope.key, restored && activeValue(restored));
      changes = restored
        ? findChanges(comparable(restored, snapshotOf(restored)), comparable(restored, backup), types, await getVolatileCookiesFor(scope.key))
        : [];
      await watchCookiesAfterApply(scope.host, backup);
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

async function handleDelete(entry) {
  const { name } = entry;
  const index = visibleMains().findIndex(main => sameEntry(entryOfRow(main.closest('.snapshot')), entry));
  let deleted = false;
  await exclusive(async () => {
    if (!await showConfirm(t('confirm_delete_snapshot', { name }))) return;
    await deleteSnapshot(entry.host, name);
    await refresh();
    showStatus($('statusMsg'), t('status_deleted', { name }), 'success');
    deleted = true;
  });
  if (deleted) focusRowAt(index);
  else focusRow(entry);
}

async function handleEditDetails(entry) {
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
      showStatus($('statusMsg'), t('status_details_saved', { name }), 'success');
    } catch (e) {
      showStatus($('statusMsg'), t('error_details_failed'), 'error');
      console.error(e);
    }
  });
  focusRow(entry);
}

function buildDetailFields({ memo, color }) {
  const content = document.createDocumentFragment();

  const memoLabel = document.createElement('label');
  const memoInput = document.createElement('input');
  memoInput.type = 'text';
  memoInput.className = 'detail-memo';
  memoInput.autocomplete = 'off';
  memoInput.maxLength = MEMO_MAX;
  memoInput.value = typeof memo === 'string' ? memo : '';
  memoLabel.append(t('memo_label'), memoInput);

  const swatches = document.createElement('fieldset');
  swatches.className = 'swatches';
  const legend = document.createElement('legend');
  legend.className = 'swatches__legend';
  legend.textContent = t('color_label');
  swatches.append(legend);
  const current = SNAPSHOT_COLORS.includes(color) ? color : '';
  for (const value of ['', ...SNAPSHOT_COLORS]) {
    const text = t(value ? `color_${value}` : 'color_none');
    const label = document.createElement('label');
    label.className = `swatch swatch--${value || 'none'}`;
    label.title = text;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'editSnapshotColor';
    radio.value = value;
    radio.checked = value === current;
    const hidden = document.createElement('span');
    hidden.className = 'tk-visually-hidden';
    hidden.textContent = text;
    label.append(radio, hidden);
    swatches.append(label);
  }

  content.append(memoLabel, swatches);
  return {
    content,
    read: () => ({
      memo: memoInput.value,
      color: swatches.querySelector('input:checked')?.value,
    }),
  };
}

function startRename(row, entry) {
  const { name } = entry;
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
    exists: newName => Boolean(snapshots[entry.host]?.[newName]),
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
        showStatus($('statusMsg'), t('status_snapshot_renamed', { old: name, new: newName }), 'success');
      });
      if (!ran) renderList();
      focusRow(ran ? { host: entry.host, name: newName } : entry);
    },
  });
  input.focus();
  input.select();
}

// setupListeners() runs partway through init(), after several awaits, so a click
// that lands before then hits a live-looking button and silently does nothing.
// E2E tests wait on this flag before touching the static buttons.
init().finally(() => document.body.setAttribute('data-ready', 'true'));
