import { t } from '../lib/i18n.js';
import { getSnapshots, getSnapshotsFor, getSnapshotOrders, SNAPSHOT_PREFIX } from '../lib/storage.js';
import { deleteSnapshot, renameSnapshot, setSnapshotOrder, orderedNames } from '../lib/snapshot.js';
import { bindInlineRename } from '../lib/inline-rename.js';
import { showConfirm } from '../lib/dialog.js';
import { $, escHtml, notify } from '../lib/ui.js';
import { measureDomains, formatBytes } from '../lib/snapshot-summary.js';
import { fillColorChip, memoText, fillGroupChip, searchQuery, matchesQuery } from '../lib/snapshot-view.js';
import { resolveScope } from '../lib/groups.js';
import { openViewer } from '../lib/viewer-link.js';
import { renderMeter } from './meter.js';
import { buildExportButton, handleExport } from './transfer-ui.js';

let stale = true;
let loading = false;
let loaded = null;
let cache = null;

// Each change carries the new value of a host's key, so the cache takes it as is
// instead of reading the whole store again; the page's own writes arrive here
// too. A change during the first read may be older or newer than that read, so
// it only marks the state for one more read.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!key.startsWith(SNAPSHOT_PREFIX) && key !== 'snapshotOrder') continue;
    if (loading || !cache) {
      stale = true;
      continue;
    }
    if (key === 'snapshotOrder') {
      cache.orders = newValue ?? {};
      continue;
    }
    const host = key.slice(SNAPSHOT_PREFIX.length);
    if (newValue && Object.keys(newValue).length) cache.snapshots[host] = newValue;
    else delete cache.snapshots[host];
  }
});

export function markStale() {
  stale = true;
}

// The flag is cleared before the read starts, so a change that lands during
// the read marks the state stale again and the next render reloads it.
function readListData() {
  if (stale) {
    stale = false;
    loading = true;
    loaded = Promise.all([getSnapshots(), getSnapshotOrders()])
      .then(([snapshots, orders]) => {
        cache = { snapshots, orders };
        return cache;
      })
      .catch(err => {
        stale = true;
        throw err;
      })
      .finally(() => {
        loading = false;
      });
  }
  return loaded;
}

export async function renderDomainList(groups, { meter = true } = {}) {
  const sort = $('sortSelect').value;
  const { snapshots: allSnapshots, orders: allOrders } = await readListData();
  const sizes = measureDomains(allSnapshots);
  if (meter) await renderMeter(sizes);
  // Read after the awaits: a full render parked in the meter must draw the
  // query typed meanwhile, not the one from when it started.
  const query = searchQuery($('snapshotSearch').value);
  const container = $('domainList');
  container.replaceChildren();

  const bySize = sort === 'size';
  // Dragging a filtered or size-sorted view would save an order the user never saw.
  const canDrag = !bySize && !query;
  const domains = sortedDomains(allSnapshots, sizes, bySize);

  if (domains.length === 0) {
    container.appendChild(buildEmptyState('empty_snapshots'));
    return;
  }

  for (const domain of domains) {
    const domainSnapshots = allSnapshots[domain];
    const rowSizes = sizes[domain].snapshots;
    const names = visibleNames(domain, domainSnapshots, allOrders[domain], rowSizes, bySize, query);
    if (!names) continue;
    container.appendChild(buildDomainItem(domain, names, {
      snapshots: domainSnapshots,
      rowSizes,
      bytes: sizes[domain].bytes,
      groups,
      query,
      canDrag,
    }));
  }

  if (!container.firstChild) container.appendChild(buildEmptyState('no_match'));
}

function sortedDomains(snapshots, sizes, bySize) {
  const domains = Object.keys(snapshots).sort();
  if (bySize) domains.sort((a, b) => sizes[b].bytes - sizes[a].bytes);
  return domains;
}

// null when the query hides the whole domain.
function visibleNames(domain, snapshots, order, rowSizes, bySize, query) {
  const names = orderedNames(snapshots, order);
  if (bySize) names.sort((a, b) => rowSizes[b] - rowSizes[a]);
  if (!query || matchesQuery(query, domain)) return names;
  const matched = names.filter(name => matchesQuery(query, name, memoText(snapshots[name])));
  return matched.length ? matched : null;
}

function buildEmptyState(key) {
  const empty = document.createElement('div');
  empty.className   = 'empty-state';
  empty.textContent = t(key);
  return empty;
}

function buildDomainItem(domain, names, { snapshots, rowSizes, bytes, groups, query, canDrag }) {
  const item = document.createElement('div');
  item.className = query ? 'domain-item open' : 'domain-item';

  const header = document.createElement('div');
  header.className = 'domain-header';
  header.innerHTML = `
    <div class="domain-header-left">
      <span class="domain-name">${escHtml(domain)}</span>
      <span class="domain-count">${t('count_format', { n: names.length })}</span>
    </div>
    <div class="domain-header-right">
      <span class="domain-size">${formatBytes(bytes)}</span>
      <span class="chevron">▾</span>
    </div>
  `;
  const { group } = resolveScope(domain, groups);
  if (group) {
    const chip = document.createElement('span');
    chip.className = 'group-chip';
    fillGroupChip(chip, group);
    header.querySelector('.domain-header-left').appendChild(chip);
  }
  header.addEventListener('click', () => item.classList.toggle('open'));
  const domainExportBtn = buildExportButton(t('export_domain_title', { domain }), btn => handleExport({ domain }, btn));
  header.querySelector('.domain-header-right').prepend(domainExportBtn);

  const snapshotList = document.createElement('div');
  snapshotList.className = 'domain-snapshots';

  for (const name of names) {
    snapshotList.appendChild(buildSnapshotRow({
      name,
      snapshot: snapshots[name],
      bytes: rowSizes[name],
      domain,
      snapshotList,
      header,
      draggable: canDrag,
    }));
  }

  if (canDrag) setupDragDrop(snapshotList, domain);

  item.appendChild(header);
  item.appendChild(snapshotList);
  return item;
}

function buildSnapshotRow({ name, snapshot, bytes, domain, snapshotList, header, draggable }) {
  const row = document.createElement('div');
  row.className = 'snapshot-row';
  row.draggable = draggable;
  row.dataset.name = name;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

  const { info, nameSpan } = buildRowInfo(name, snapshot, bytes);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-icon';
  deleteBtn.title = t('btn_delete_title');
  deleteBtn.textContent = '✕';

  if (draggable) row.appendChild(handle);
  const chip = document.createElement('span');
  chip.className = 'snapshot-chip';
  chip.setAttribute('role', 'img');
  if (fillColorChip(chip, snapshot.color, 'snapshot-chip')) row.appendChild(chip);
  row.appendChild(info);
  const viewBtn = buildViewButton(domain, row);
  row.appendChild(viewBtn);
  row.appendChild(buildExportButton(t('export_snapshot_title', { name }), btn =>
    handleExport({ domain, name: row.dataset.name }, btn)));
  row.appendChild(deleteBtn);

  const ctx = { row, info, nameSpan, viewBtn, domain, snapshotList, header, draggable };
  nameSpan.addEventListener('dblclick', () => startRowRename(ctx));
  deleteBtn.addEventListener('click', () => deleteRow(ctx));

  return row;
}

function buildRowInfo(name, snapshot, bytes) {
  const info = document.createElement('div');
  info.className = 'snapshot-info';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'snapshot-name';
  nameSpan.textContent = name;

  const meta = document.createElement('span');
  meta.className = 'snapshot-meta';

  const dateSpan = document.createElement('span');
  dateSpan.className = 'snapshot-date';
  dateSpan.textContent = new Date(snapshot.savedAt).toLocaleString();

  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'snapshot-size';
  sizeSpan.textContent = formatBytes(bytes);

  meta.append(dateSpan, sizeSpan);
  info.appendChild(nameSpan);
  const memo = memoText(snapshot);
  if (memo) {
    const memoSpan = document.createElement('span');
    memoSpan.className = 'snapshot-memo';
    memoSpan.textContent = memo;
    memoSpan.title = memo;
    info.appendChild(memoSpan);
  }
  info.appendChild(meta);
  return { info, nameSpan };
}

function buildViewButton(domain, row) {
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn-icon btn-icon--neutral';
  setViewTitle(viewBtn, row.dataset.name);
  viewBtn.textContent = '⌕';
  viewBtn.addEventListener('click', () => openViewer({ host: domain, name: row.dataset.name }));
  return viewBtn;
}

function setViewTitle(btn, name) {
  btn.title = t('btn_view_title', { name });
  btn.setAttribute('aria-label', btn.title);
}

// The name is read from the row when the action runs: an inline rename may have
// changed it since the row was built.
async function deleteRow({ row, domain, snapshotList, header }) {
  const currentName = row.dataset.name;
  if (!await showConfirm(t('confirm_delete_snapshot', { name: currentName }))) return;
  await deleteSnapshot(domain, currentName);
  row.remove();
  const countEl = header.querySelector('.domain-count');
  if (countEl) countEl.textContent = t('count_format', { n: snapshotList.querySelectorAll('.snapshot-row').length });
  const { snapshots, orders } = await readListData();
  forgetInCache(snapshots, orders, domain, currentName);
  const sizes = measureDomains(snapshots);
  header.querySelector('.domain-size').textContent = formatBytes(sizes[domain]?.bytes ?? 0);
  await renderMeter(sizes);
  notify('status_snapshot_deleted', { name: currentName });
}

function forgetInCache(snapshots, orders, domain, name) {
  if (snapshots[domain]) {
    delete snapshots[domain][name];
    if (Object.keys(snapshots[domain]).length === 0) delete snapshots[domain];
  }
  if (orders[domain]) {
    orders[domain] = orders[domain].filter(n => n !== name);
    if (orders[domain].length === 0) delete orders[domain];
  }
}

function renameInCache(snapshots, orders, domain, oldName, newName) {
  if (snapshots[domain]?.[oldName]) {
    snapshots[domain][newName] = snapshots[domain][oldName];
    delete snapshots[domain][oldName];
  }
  const index = orders[domain]?.indexOf(oldName) ?? -1;
  if (index !== -1) orders[domain][index] = newName;
}

function startRowRename({ row, info, nameSpan, viewBtn, domain, draggable }) {
  if (info.querySelector('.snapshot-name-input')) return;
  const oldName = row.dataset.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'snapshot-name-input';
  input.value = oldName;
  info.replaceChild(input, nameSpan);
  row.draggable = false;

  const restore = () => {
    info.replaceChild(nameSpan, input);
    row.draggable = draggable;
  };
  bindInlineRename(input, {
    oldName,
    exists: async newName => Boolean((await getSnapshotsFor([domain]))[domain]?.[newName]),
    onError: msg => (msg ? showRenameError(info, msg) : clearRenameError(info)),
    onCancel: restore,
    onCommit: async newName => {
      await renameSnapshot(domain, oldName, newName);
      const { snapshots, orders } = await readListData();
      renameInCache(snapshots, orders, domain, oldName, newName);
      row.dataset.name = newName;
      nameSpan.textContent = newName;
      setViewTitle(viewBtn, newName);
      restore();
      notify('status_snapshot_renamed', { old: oldName, new: newName });
    },
  });
  input.focus();
  input.select();
}

function showRenameError(info, msg) {
  let errorSpan = info.querySelector('.rename-error');
  if (!errorSpan) {
    errorSpan = document.createElement('span');
    errorSpan.className = 'rename-error';
    info.appendChild(errorSpan);
  }
  errorSpan.textContent = msg;
}

function clearRenameError(info) {
  info.querySelector('.rename-error')?.remove();
}

function setupDragDrop(snapshotList, domain) {
  let dragSrc = null;

  snapshotList.addEventListener('dragstart', e => {
    dragSrc = e.target.closest('.snapshot-row');
    if (!dragSrc) return;
    dragSrc.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });

  snapshotList.addEventListener('dragend', () => {
    dragSrc?.classList.remove('dragging');
    dragSrc = null;
  });

  snapshotList.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragSrc) return;
    const target = e.target.closest('.snapshot-row');
    if (!target || target === dragSrc) return;
    const { top, height } = target.getBoundingClientRect();
    const insertBefore = e.clientY < top + height / 2;
    snapshotList.insertBefore(dragSrc, insertBefore ? target : target.nextSibling);
  });

  snapshotList.addEventListener('drop', async e => {
    e.preventDefault();
    const newOrder = [...snapshotList.querySelectorAll('.snapshot-row')].map(el => el.dataset.name);
    await setSnapshotOrder(domain, newOrder);
    (await readListData()).orders[domain] = newOrder;
  });
}
