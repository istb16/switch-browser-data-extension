import { initI18n, t, applyI18n, setLanguage, getSavedLangSetting } from '../lib/i18n.js';
import { getSnapshots, setSnapshots, getSettings, setSettings, getSnapshotOrders } from '../lib/storage.js';
import { deleteSnapshot, setSnapshotOrder } from '../lib/snapshot.js';
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
  row.innerHTML = `
    <span class="drag-handle">⠿</span>
    <div class="snapshot-info">
      <span class="snapshot-name">${escHtml(name)}</span>
      <span class="snapshot-date">${new Date(savedAt).toLocaleString()}</span>
    </div>
    <button class="btn-icon" title="${escHtml(t('btn_delete_title'))}">✕</button>
  `;
  row.querySelector('.btn-icon').addEventListener('click', async () => {
    if (!await showConfirm(t('confirm_delete_snapshot', { name }))) return;
    await deleteSnapshot(domain, name);
    await renderDomainList();
    showStatus($('statusMsg'), t('status_snapshot_deleted', { name }), 'success');
  });
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
