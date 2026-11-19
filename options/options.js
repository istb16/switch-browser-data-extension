import { initI18n, t, applyI18n, setLanguage, getSavedLangSetting } from '../lib/i18n.js';
import { getSnapshots, setSnapshots, getSettings, setSettings, getSnapshotOrders, setSnapshotOrders, getGroups } from '../lib/storage.js';
import { deleteSnapshot, renameSnapshot, setSnapshotOrder, clearAllData, withSnapshotLock } from '../lib/snapshot.js';
import { bindInlineRename } from '../lib/inline-rename.js';
import { showConfirm, showFormDialog, showChoice } from '../lib/dialog.js';
import { $, escHtml, showStatus } from '../lib/ui.js';
import { SNAPSHOT_COLORS, measureDomains, formatBytes } from '../lib/snapshot-summary.js';
import { encryptText, decryptEnvelope } from '../lib/crypto.js';
import { IMPORT_MAX_BYTES, buildExport, exportFileName, parseImport, findConflicts, mergeImport } from '../lib/transfer.js';
import { normalizeGroupDomain, validateNewGroup, groupOrigins, resolveScope, addGroup, removeGroup } from '../lib/groups.js';

const PANES = ['general', 'data-types', 'snapshots', 'data'];
const PASSPHRASE_MIN = 8;
const CONFLICT_NAMES_SHOWN = 5;
const METER_DOMAIN_SEGMENTS = 5;
// unlimitedStorage lifts the quota, but the popup reads and rewrites the whole
// snapshots value on every open and save, so size still costs speed.
const METER_ADVISORY_BYTES = 50 * 1024 * 1024;

async function init() {
  setupNav();
  await initI18n();
  applyI18n();
  renderVersionFooter();

  $('langSelect').value = await getSavedLangSetting();
  $('langSelect').addEventListener('change', handleLanguageChange);

  const settings = await getSettings();
  $('toggleCookies').checked        = settings.enabledTypes.cookies;
  $('toggleLocalStorage').checked   = settings.enabledTypes.localStorage;
  $('toggleSessionStorage').checked = settings.enabledTypes.sessionStorage;
  $('toggleIndexedDB').checked      = settings.enabledTypes.indexedDB;
  $('toggleAutoBackup').checked     = settings.autoBackup;
  $('toggleAutoReload').checked     = settings.autoReload;
  $('toggleShowBadge').checked      = settings.showBadge;
  $('toggleEncryptExports').checked = settings.encryptExports;

  for (const toggle of document.querySelectorAll('.toggle-item input[type="checkbox"]')) {
    toggle.addEventListener('change', handleSaveSettings);
  }
  $('exportBtn').addEventListener('click', () => handleExport({}, $('exportBtn')));
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', handleImport);
  $('clearAllBtn').addEventListener('click', handleClearAll);
  $('sortSelect').addEventListener('change', () => renderDomainList());
  $('groupForm').addEventListener('submit', handleAddGroup);

  await renderGroups();
  await renderDomainList();
}

function setupNav() {
  showPane();
  window.addEventListener('hashchange', showPane);
}

function showPane() {
  const requested = location.hash.slice(1);
  const current = PANES.includes(requested) ? requested : PANES[0];
  for (const pane of document.querySelectorAll('.pane')) {
    pane.hidden = pane.dataset.pane !== current;
  }
  for (const link of document.querySelectorAll('.nav-link')) {
    if (link.dataset.pane === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderMeter(allSnapshots) {
  const [total, backups] = await Promise.all([
    chrome.storage.local.getBytesInUse(null),
    chrome.storage.local.getBytesInUse('backups'),
  ]);
  const largest = Object.entries(measureDomains(allSnapshots))
    .map(([domain, { bytes }]) => ({ domain, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.domain.localeCompare(b.domain))
    .slice(0, METER_DOMAIN_SEGMENTS);
  const listed = largest.reduce((sum, d) => sum + d.bytes, 0) + backups;
  const segments = [
    ...largest.map((d, i) => ({ kind: `domain-${i + 1}`, label: d.domain, bytes: d.bytes })),
    { kind: 'backups', label: t('meter_backups'), bytes: backups },
    { kind: 'other',   label: t('meter_other'),   bytes: Math.max(0, total - listed) },
  ];

  $('meterTotal').textContent = formatBytes(total);
  $('meterBar').setAttribute('aria-label', t('meter_label', { size: formatBytes(total) }));
  $('meterBar').replaceChildren(...segments.map(segment => {
    const el = document.createElement('span');
    el.className = `meter-segment meter-segment--${segment.kind}`;
    el.dataset.bytes = String(segment.bytes);
    el.style.width = total > 0 ? `${(segment.bytes / total) * 100}%` : '0';
    el.title = `${segment.label}: ${formatBytes(segment.bytes)}`;
    return el;
  }));
  $('meterLegend').replaceChildren(...segments.map(segment => {
    const li = document.createElement('li');
    li.className = 'meter-legend-item';
    const swatch = document.createElement('span');
    swatch.className = `meter-swatch meter-segment--${segment.kind}`;
    const label = document.createElement('span');
    label.className = 'meter-legend-label';
    label.textContent = segment.label;
    const size = document.createElement('span');
    size.className = 'meter-legend-size';
    size.textContent = formatBytes(segment.bytes);
    li.append(swatch, label, size);
    return li;
  }));
  $('meterAdvisory').classList.toggle('hidden', total < METER_ADVISORY_BYTES);
}

async function handleLanguageChange() {
  await setLanguage($('langSelect').value);
  applyI18n();
  renderVersionFooter();
  await renderGroups();
  await renderDomainList();
}

function renderVersionFooter() {
  $('versionFooter').textContent = t('footer_version', { version: chrome.runtime.getManifest().version });
}

async function handleSaveSettings() {
  const settings = await getSettings();
  settings.enabledTypes = {
    cookies:        $('toggleCookies').checked,
    localStorage:   $('toggleLocalStorage').checked,
    sessionStorage: $('toggleSessionStorage').checked,
    indexedDB:      $('toggleIndexedDB').checked,
  };
  settings.autoBackup = $('toggleAutoBackup').checked;
  settings.autoReload = $('toggleAutoReload').checked;
  settings.showBadge  = $('toggleShowBadge').checked;
  settings.encryptExports = $('toggleEncryptExports').checked;
  await setSettings(settings);
  showStatus($('statusMsg'), t('status_settings_saved'), 'success');
}

async function renderGroups() {
  const groups = await getGroups();
  const list = $('groupList');
  if (groups.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'group-empty';
    empty.textContent = t('empty_groups');
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...groups.map(group => {
    const li = document.createElement('li');
    li.className = 'group-item';
    li.dataset.group = group;
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group;
    const scope = document.createElement('span');
    scope.className = 'group-scope';
    scope.textContent = `*.${group}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-icon';
    removeBtn.title = t('btn_remove_group_title', { group });
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => handleRemoveGroup(group));
    li.append(name, scope, removeBtn);
    return li;
  }));
}

async function handleAddGroup(e) {
  e.preventDefault();
  const input = $('groupInput');
  try {
    const base = normalizeGroupDomain(input.value);
    const error = validateNewGroup(input.value, await getGroups());
    if (error) {
      showStatus($('statusMsg'), t(`error_group_${error.replace('-', '_')}`, { group: base }), 'error');
      return;
    }
    if (!await showConfirm(t('confirm_add_group', { group: base }))) return;
    const { enabledTypes } = await getSettings();
    const granted = enabledTypes.cookies ? await chrome.permissions.request({ origins: groupOrigins(base) }) : true;
    await addGroup(base);
    input.value = '';
    await renderGroups();
    await renderDomainList();
    showStatus($('statusMsg'), t(granted ? 'status_group_added' : 'status_group_added_no_permission', { group: base }), 'success');
  } catch (err) {
    showStatus($('statusMsg'), t('error_group_failed'), 'error');
    console.error(err);
  }
}

async function handleRemoveGroup(base) {
  try {
    if (!await showConfirm(t('confirm_remove_group', { group: base }))) return;
    await removeGroup(base);
    // *://base/* stays: the base host goes on using it as its own scope.
    await chrome.permissions.remove({ origins: [`*://*.${base}/*`] });
    await renderGroups();
    await renderDomainList();
    showStatus($('statusMsg'), t('status_group_removed', { group: base }), 'success');
  } catch (err) {
    showStatus($('statusMsg'), t('error_group_failed'), 'error');
    console.error(err);
  }
}

async function renderDomainList(sort = $('sortSelect').value) {
  const [allSnapshots, allOrders, groups] = await Promise.all([getSnapshots(), getSnapshotOrders(), getGroups()]);
  await renderMeter(allSnapshots);
  const container = $('domainList');
  container.replaceChildren();

  const sizes = measureDomains(allSnapshots);
  const bySize = sort === 'size';
  const domains = Object.keys(allSnapshots).sort();
  if (bySize) domains.sort((a, b) => sizes[b].bytes - sizes[a].bytes);

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
    const rowSizes  = sizes[domain].snapshots;
    if (bySize) names.sort((a, b) => rowSizes[b] - rowSizes[a]);

    const item = document.createElement('div');
    item.className = 'domain-item';

    const header = document.createElement('div');
    header.className = 'domain-header';
    header.innerHTML = `
      <div class="domain-header-left">
        <span class="domain-name">${escHtml(domain)}</span>
        <span class="domain-count">${t('count_format', { n: names.length })}</span>
      </div>
      <div class="domain-header-right">
        <span class="domain-size">${formatBytes(sizes[domain].bytes)}</span>
        <span class="chevron">▾</span>
      </div>
    `;
    const { group } = resolveScope(domain, groups);
    if (group) {
      const chip = document.createElement('span');
      chip.className = 'group-chip';
      chip.textContent = t('group_chip', { group });
      chip.title = t('group_chip_title', { group });
      header.querySelector('.domain-header-left').appendChild(chip);
    }
    header.addEventListener('click', () => item.classList.toggle('open'));
    const domainExportBtn = buildExportButton(t('export_domain_title', { domain }), btn => handleExport({ domain }, btn));
    header.querySelector('.domain-header-right').prepend(domainExportBtn);

    const snapshotList = document.createElement('div');
    snapshotList.className = 'domain-snapshots';

    for (const name of names) {
      const row = buildSnapshotRow(name, domainSnapshots[name], rowSizes[name], domain, snapshotList, header, !bySize);
      snapshotList.appendChild(row);
    }

    // Dragging in a size-sorted view would save an order the user never saw.
    if (!bySize) setupDragDrop(snapshotList, domain);

    item.appendChild(header);
    item.appendChild(snapshotList);
    container.appendChild(item);
  }
}

function buildSnapshotRow(name, snapshot, bytes, domain, snapshotList, header, draggable) {
  const row = document.createElement('div');
  row.className = 'snapshot-row';
  row.draggable = draggable;
  row.dataset.name = name;

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

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
  if (typeof snapshot.memo === 'string' && snapshot.memo) {
    const memoSpan = document.createElement('span');
    memoSpan.className = 'snapshot-memo';
    memoSpan.textContent = snapshot.memo;
    memoSpan.title = snapshot.memo;
    info.appendChild(memoSpan);
  }
  info.appendChild(meta);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-icon';
  deleteBtn.title = t('btn_delete_title');
  deleteBtn.textContent = '✕';

  if (draggable) row.appendChild(handle);
  if (SNAPSHOT_COLORS.includes(snapshot.color)) {
    const chip = document.createElement('span');
    chip.className = `snapshot-chip snapshot-chip--${snapshot.color}`;
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', t('chip_label', { color: t(`color_${snapshot.color}`) }));
    row.appendChild(chip);
  }
  row.appendChild(info);
  row.appendChild(buildExportButton(t('export_snapshot_title', { name }), btn =>
    handleExport({ domain, name: row.dataset.name }, btn)));
  row.appendChild(deleteBtn);

  nameSpan.addEventListener('dblclick', startRename);
  deleteBtn.addEventListener('click', async () => {
    const currentName = row.dataset.name;
    if (!await showConfirm(t('confirm_delete_snapshot', { name: currentName }))) return;
    await deleteSnapshot(domain, currentName);
    row.remove();
    const countEl = header.querySelector('.domain-count');
    if (countEl) countEl.textContent = t('count_format', { n: snapshotList.querySelectorAll('.snapshot-row').length });
    const allSnapshots = await getSnapshots();
    header.querySelector('.domain-size').textContent =
      formatBytes(measureDomains({ [domain]: allSnapshots[domain] ?? {} })[domain].bytes);
    await renderMeter(allSnapshots);
    showStatus($('statusMsg'), t('status_snapshot_deleted', { name: currentName }), 'success');
  });

  function startRename() {
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
      exists: async newName => Boolean((await getSnapshots())[domain]?.[newName]),
      onError: msg => (msg ? showRenameError(msg) : clearRenameError()),
      onCancel: restore,
      onCommit: async newName => {
        await renameSnapshot(domain, oldName, newName);
        row.dataset.name = newName;
        nameSpan.textContent = newName;
        restore();
        showStatus($('statusMsg'), t('status_snapshot_renamed', { old: oldName, new: newName }), 'success');
      },
    });
    input.focus();
    input.select();
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

function buildExportButton(title, onExport) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-export';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.textContent = '⤓';
  btn.addEventListener('click', e => {
    // The domain header toggles open on click; exporting should not.
    e.stopPropagation();
    onExport(btn);
  });
  return btn;
}

// scope: {} for everything, { domain } or { domain, name }.
async function handleExport(scope, button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const { encryptExports } = await getSettings();
    const text = JSON.stringify(buildExport(await getSnapshots(), scope), null, 2);
    if (!encryptExports) {
      downloadExport(text, scope);
      showStatus($('statusMsg'), t('status_exported_plain'), 'success');
      return;
    }
    const passphrase = await askNewPassphrase();
    if (passphrase === null) return;
    downloadExport(JSON.stringify(await encryptText(text, passphrase)), scope);
    showStatus($('statusMsg'), t('status_exported'), 'success');
  } catch (e) {
    showStatus($('statusMsg'), t('error_export_failed'), 'error');
    console.error(e);
  } finally {
    button.disabled = false;
  }
}

function downloadExport(text, scope) {
  const blob = new Blob([text], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: exportFileName(scope),
  });
  a.click();
  URL.revokeObjectURL(url);
}

function passphraseField(labelKey, autocomplete) {
  const label = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = t(labelKey);
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'passphrase-input';
  input.autocomplete = autocomplete;
  label.append(text, input);
  return { label, input };
}

// Resolves the new passphrase, or null when cancelled.
async function askNewPassphrase() {
  const first = passphraseField('passphrase_label', 'new-password');
  const second = passphraseField('passphrase_confirm_label', 'new-password');
  const hint = document.createElement('p');
  hint.className = 'passphrase-hint';
  hint.textContent = t('hint_passphrase_unrecoverable');
  const content = document.createDocumentFragment();
  content.append(first.label, second.label, hint);

  const confirmed = await showFormDialog({
    title: t('passphrase_new_title'),
    content,
    confirmLabel: t('btn_export_confirm'),
    validate: () => {
      if (first.input.value.length < PASSPHRASE_MIN) return t('error_passphrase_short', { n: PASSPHRASE_MIN });
      if (first.input.value !== second.input.value) return t('error_passphrase_mismatch');
      return null;
    },
  });
  return confirmed ? first.input.value : null;
}

// Resolves the entered passphrase, or null when cancelled.
async function askPassphrase() {
  const field = passphraseField('passphrase_label', 'current-password');
  const confirmed = await showFormDialog({
    title: t('passphrase_title'),
    content: field.label,
    confirmLabel: t('btn_import_confirm'),
    validate: () => (field.input.value ? null : t('error_enter_passphrase')),
  });
  return confirmed ? field.input.value : null;
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > IMPORT_MAX_BYTES) {
      showStatus($('statusMsg'), t('error_import_too_large', { size: formatBytes(IMPORT_MAX_BYTES) }), 'error');
      return;
    }
    let parsed = parseImport(await file.text());
    if (parsed.encrypted) {
      const passphrase = await askPassphrase();
      if (passphrase === null) return;
      parsed = parseImport(await decryptEnvelope(parsed.envelope, passphrase), { decrypted: true });
    }

    const conflicts = findConflicts(await getSnapshots(), parsed.data);
    let strategy = 'skip';
    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, CONFLICT_NAMES_SHOWN).map(c => `${c.domain} / ${c.name}`);
      if (conflicts.length > CONFLICT_NAMES_SHOWN) shown.push('…');
      strategy = await showChoice(t('confirm_import_conflicts', { n: conflicts.length, names: shown.join('\n') }), [
        { value: 'overwrite', label: t('choice_overwrite') },
        { value: 'skip',      label: t('choice_skip') },
        { value: 'keepBoth',  label: t('choice_keep_both') },
      ]);
      if (strategy === null) return;
    }

    // Read again after the dialog: the popup may have saved, renamed or deleted
    // snapshots while it was open, and merging into the earlier read would undo that.
    const merged = await withSnapshotLock(async () => {
      const [existing, orders] = await Promise.all([getSnapshots(), getSnapshotOrders()]);
      const result = mergeImport(existing, orders, parsed.data, strategy);
      await Promise.all([setSnapshots(result.snapshots), setSnapshotOrders(result.orders)]);
      return result;
    });
    await renderDomainList();
    showStatus($('statusMsg'), t('status_imported', merged.counts), 'success');
  } catch (err) {
    const wrong = err?.message === 'wrong-passphrase';
    showStatus($('statusMsg'), t(wrong ? 'error_wrong_passphrase' : 'error_import_failed'), 'error');
  } finally {
    e.target.value = '';
  }
}

async function handleClearAll() {
  if (!await showConfirm(t('confirm_clear_all'))) return;
  await clearAllData();
  await renderDomainList();
  showStatus($('statusMsg'), t('status_cleared'), 'success');
}

// init() attaches the click listeners partway through, after several awaits, so
// a click that lands before then hits a live-looking button and silently does
// nothing. E2E tests wait on this flag before touching the static buttons.
init().finally(() => document.body.setAttribute('data-ready', 'true'));
