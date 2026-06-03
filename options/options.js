import { initI18n, t, applyI18n, setLanguage, getSavedLangSetting } from '../lib/i18n.js';
import { getSnapshots, setSnapshots, getSettings, setSettings, getSnapshotOrders } from '../lib/storage.js';
import { deleteSnapshot, renameSnapshot, setSnapshotOrder } from '../lib/snapshot.js';
import { showConfirm } from '../lib/dialog.js';
import { $, escHtml, showStatus } from '../lib/ui.js';

async function init() {
  await initI18n();
  applyI18n();

  $('langSelect').value = await getSavedLangSetting();
  $('langSelect').addEventListener('change', handleLanguageChange);

  const { enabledTypes } = await getSettings();
  $('toggleCookies').checked        = enabledTypes.cookies;
  $('toggleLocalStorage').checked   = enabledTypes.localStorage;
  $('toggleSessionStorage').checked = enabledTypes.sessionStorage;
  $('toggleIndexedDB').checked      = enabledTypes.indexedDB;

  $('saveSettingsBtn').addEventListener('click', handleSaveSettings);
  $('exportBtn').addEventListener('click', handleExport);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', handleImport);
  $('clearAllBtn').addEventListener('click', handleClearAll);

  await renderDomainList();
}

async function handleLanguageChange() {
  await setLanguage($('langSelect').value);
  applyI18n();
  await renderDomainList();
}

async function handleSaveSettings() {
  const settings = await getSettings();
  settings.enabledTypes = {
    cookies:        $('toggleCookies').checked,
    localStorage:   $('toggleLocalStorage').checked,
    sessionStorage: $('toggleSessionStorage').checked,
    indexedDB:      $('toggleIndexedDB').checked,
  };
  await setSettings(settings);
  showStatus($('statusMsg'), t('status_settings_saved'), 'success');
}

async function renderDomainList() {
  const [allSnapshots, allOrders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
  const container = $('domainList');
  container.innerHTML = '';

  const domains = Object.keys(allSnapshots).sort();

  if (domains.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'empty-state';
    empty.textContent = t('empty_snapshots');
    container.appendChild(empty);
    return;
  }

  for (const domain of domains) {
    const domainSnapshots = allSnapshots[domain];
    const allNames  = Object.keys(domainSnapshots);
    const ordered   = (allOrders[domain] ?? []).filter(n => allNames.includes(n));
    const rest      = allNames.filter(n => !ordered.includes(n)).sort();
    const names     = [...ordered, ...rest];

    const item = document.createElement('div');
    item.className = 'domain-item';

    const header = document.createElement('div');
    header.className = 'domain-header';
    header.innerHTML = `
      <div class="domain-header-left">
        <span class="domain-name">${escHtml(domain)}</span>
        <span class="domain-count">${t('count_format', { n: names.length })}</span>
      </div>
      <span class="chevron">▾</span>
    `;
    header.addEventListener('click', () => item.classList.toggle('open'));

    const snapshotList = document.createElement('div');
    snapshotList.className = 'domain-snapshots';

    for (const name of names) {
      const row = buildSnapshotRow(name, domainSnapshots[name].savedAt, domain, snapshotList);
      snapshotList.appendChild(row);
    }

    setupDragDrop(snapshotList, domain);

    item.appendChild(header);
    item.appendChild(snapshotList);
    container.appendChild(item);
  }
}

function buildSnapshotRow(name, savedAt, domain, snapshotList) {
  const row = document.createElement('div');
  row.className = 'snapshot-row';
  row.draggable = true;
  row.dataset.name = name;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

  const info = document.createElement('div');
  info.className = 'snapshot-info';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'snapshot-name';
  nameSpan.textContent = name;

  const dateSpan = document.createElement('span');
  dateSpan.className = 'snapshot-date';
  dateSpan.textContent = new Date(savedAt).toLocaleString();

  info.appendChild(nameSpan);
  info.appendChild(dateSpan);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-icon';
  deleteBtn.title = t('btn_delete_title');
  deleteBtn.textContent = '✕';

  row.appendChild(handle);
  row.appendChild(info);
  row.appendChild(deleteBtn);

  nameSpan.addEventListener('dblclick', startRename);
  deleteBtn.addEventListener('click', async () => {
    const currentName = row.dataset.name;
    if (!await showConfirm(t('confirm_delete_snapshot', { name: currentName }))) return;
    await deleteSnapshot(domain, currentName);
    await renderDomainList();
    showStatus($('statusMsg'), t('status_snapshot_deleted', { name: currentName }), 'success');
  });

  function startRename() {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'snapshot-name-input';
    input.value = row.dataset.name;
    info.replaceChild(input, nameSpan);
    row.draggable = false;
    input.focus();
    input.select();
    input.addEventListener('keydown', async e => {
      if (e.key === 'Enter') { e.preventDefault(); await commitRename(); }
      else if (e.key === 'Escape') cancelRename();
    });
    input.addEventListener('blur', commitRename);
  }

  async function commitRename() {
    const input = info.querySelector('.snapshot-name-input');
    if (!input) return;
    const newName = input.value.trim();
    const oldName = row.dataset.name;
    clearRenameError();
    if (!newName) { showRenameError(t('error_empty_name')); return; }
    if (newName === oldName) { cancelRename(); return; }
    const allSnapshots = await getSnapshots();
    if (allSnapshots[domain]?.[newName]) { showRenameError(t('error_duplicate_name', { name: newName })); return; }
    input.removeEventListener('blur', commitRename);
    await renameSnapshot(domain, oldName, newName);
    await renderDomainList();
    showStatus($('statusMsg'), t('status_snapshot_renamed', { old: oldName, new: newName }), 'success');
  }

  function cancelRename() {
    const input = info.querySelector('.snapshot-name-input');
    if (!input) return;
    input.removeEventListener('blur', commitRename);
    info.replaceChild(nameSpan, input);
    clearRenameError();
    row.draggable = true;
  }

  function showRenameError(msg) {
    let errorSpan = info.querySelector('.rename-error');
    if (!errorSpan) {
      errorSpan = document.createElement('span');
      errorSpan.className = 'rename-error';
      info.appendChild(errorSpan);
    }
    errorSpan.textContent = msg;
  }

  function clearRenameError() {
    info.querySelector('.rename-error')?.remove();
  }

  return row;
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
  });
}

async function handleExport() {
  const snapshots = await getSnapshots();
  const blob = new Blob([JSON.stringify(snapshots, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `browser-data-snapshots-${Date.now()}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  showStatus($('statusMsg'), t('status_exported'), 'success');
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('invalid');
    const existing = await getSnapshots();
    for (const [domain, data] of Object.entries(imported)) {
      existing[domain] = { ...(existing[domain] ?? {}), ...data };
    }
    await setSnapshots(existing);
    await renderDomainList();
    showStatus($('statusMsg'), t('status_imported'), 'success');
  } catch {
    showStatus($('statusMsg'), t('error_import_failed'), 'error');
  } finally {
    e.target.value = '';
  }
}

async function handleClearAll() {
  if (!await showConfirm(t('confirm_clear_all'))) return;
  await setSnapshots({});
  await renderDomainList();
  showStatus($('statusMsg'), t('status_cleared'), 'success');
}

init();
