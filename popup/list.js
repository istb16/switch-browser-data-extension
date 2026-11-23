import { t, getLang } from '../lib/i18n.js';
import { formatBytes } from '../lib/snapshot-summary.js';
import { describeChanges, TYPE_LABELS } from '../lib/data-compare.js';
import { setupMenu } from '../lib/menu.js';
import { formatRelative } from '../lib/time.js';
import { fillColorChip, memoText } from '../lib/snapshot-view.js';
import { $ } from '../lib/ui.js';
import { openViewer } from '../lib/viewer-link.js';
import { state, entryId, sameEntry, snapshotOf, entryOfRow, loadableTypes, typeNamesOf } from './context.js';

// Below this many snapshots the whole list fits at a glance, so the search box
// would only add noise.
const SEARCH_MIN = 5;

// Short forms keep the preview on one line; the tooltip spells them out.
const PREVIEW_LABELS = { cookies: 'Cookie', localStorage: 'LS', sessionStorage: 'SS', indexedDB: 'IDB' };

let rowActions = {};

export function setRowActions(callbacks) {
  rowActions = callbacks;
}

export function renderList() {
  const { entries } = state;
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
  const isActive = sameEntry(entry, state.activeEntry);
  const isForeign = entry.host !== state.scope.host;
  row.dataset.host = entry.host;
  row.dataset.name = name;
  row.classList.toggle('is-active', isActive);
  const isModified = isActive && state.changes.length > 0;
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
  renderDetails(row, snapshot, state.summaries.get(entryId(entry)));

  const activeBadge = row.querySelector('.badge--active');
  const partialTypes = isActive ? state.activeEntry.types : undefined;
  activeBadge.textContent = t(partialTypes ? 'badge_active_partial' : 'badge_active');
  if (partialTypes) activeBadge.title = t('active_partial_title', { types: typeNamesOf(partialTypes) });
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
  menu.querySelector('[data-action="view"]').textContent = t('menu_view');
  menu.querySelector('[data-action="overwrite"]').textContent = t('menu_overwrite');
  menu.querySelector('[data-action="rename"]').textContent = t('menu_rename');
  menu.querySelector('[data-action="edit"]').textContent = t('menu_edit_details');
  menu.querySelector('[data-action="load-partial"]').textContent = t('menu_load_partial');
  menu.querySelector('[data-action="delete"]').textContent = t('menu_delete');
  // Overwriting would store this page's data under the other host's key.
  if (isForeign) menu.querySelector('[data-action="overwrite"]').remove();
  // Another host's row already loads only its cookies, and one type leaves nothing to choose.
  if (isForeign || loadableTypes(entry).length < 2) menu.querySelector('[data-action="load-partial"]').remove();

  row.querySelector('.snapshot__main').addEventListener('click', () => rowActions.load(entry));
  setupMenu(trigger, menu, action => {
    if (action === 'view') openViewer({ host: entry.host, name, tabId: state.activeTab.id });
    else if (action === 'overwrite') rowActions.overwrite(entry);
    else if (action === 'load-partial') rowActions.loadPartial(entry);
    else if (action === 'rename') rowActions.rename(row, entry);
    else if (action === 'edit') rowActions.editDetails(entry);
    else if (action === 'delete') rowActions.delete(entry);
  });

  return row;
}

function renderDetails(row, snapshot, summary) {
  const chip = row.querySelector('.snapshot__chip');
  if (fillColorChip(chip, snapshot.color, 'snapshot__chip')) chip.classList.remove('hidden');
  else chip.remove();

  const memo = row.querySelector('.snapshot__memo');
  const memoValue = memoText(snapshot);
  if (memoValue) {
    memo.textContent = memoValue;
    memo.title = memoValue;
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

export function renderUndo() {
  const { backup } = state;
  $('undoBar').classList.toggle('hidden', !backup);
  if (backup) $('undoText').textContent = t('undo_text', { time: formatRelative(backup.savedAt, getLang()) });
}

// The "changed" badge opens a menu that names what changed and lets the user
// stop comparing a cookie the site keeps rewriting.
function setupChangesMenu(badge, menu, entry, index) {
  const detail = t('modified_detail', { items: describeChanges(state.changes).join(' / ') });
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
  const canOverwrite = entry.host === state.scope.host;
  if (!canOverwrite) overwrite.remove();
  const cookieChanges = state.changes.filter(c => c.type === 'cookies');
  if (cookieChanges.length) group.prepend(...cookieChanges.map(change => {
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.action = 'ignore';
    item.dataset.key = change.key;
    item.textContent = t('menu_ignore_cookie', { name: change.name });
    return item;
  }), ...(canOverwrite ? [document.createElement('hr')] : []));

  setupMenu(badge, menu, (action, item) => {
    if (action === 'overwrite') rowActions.overwrite(entry);
    else if (action === 'ignore') rowActions.ignoreCookie(entry, state.changes.find(c => c.key === item.dataset.key));
  });
}

export function visibleMains() {
  return [...$('snapshotList').querySelectorAll('.snapshot__main')];
}

export function rowOf(entry) {
  return [...$('snapshotList').children].find(el => sameEntry(entryOfRow(el), entry));
}

export function focusRow(entry) {
  rowOf(entry)?.querySelector('.snapshot__main')?.focus();
}

// After a row disappears, keep keyboard users in the list: the row that took its
// place, else the one above, else the save button.
export function focusRowAt(index) {
  const mains = visibleMains();
  (mains[index] ?? mains.at(-1) ?? $('saveBtn')).focus();
}
