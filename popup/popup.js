import { initI18n, t, applyI18n } from '../lib/i18n.js';
import { getSnapshotsForDomain, getOrderedSnapshotNames, saveSnapshot, deleteSnapshot, loadSnapshot } from '../lib/snapshot.js';
import { getSettings } from '../lib/storage.js';
import { collectData, applyData } from '../lib/data-bridge.js';
import { showConfirm } from '../lib/dialog.js';
import { $, showStatus } from '../lib/ui.js';

let currentDomain = null;
let snapshots = {};
let activeTab = null;

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
    $('currentDomain').textContent = '-';
    $('unavailableMsg').classList.remove('hidden');
    return;
  }

  try {
    currentDomain = new URL(tab.url).hostname;
  } catch {
    $('currentDomain').textContent = '-';
    $('unavailableMsg').classList.remove('hidden');
    return;
  }

  $('currentDomain').textContent = currentDomain;
  $('mainContent').classList.remove('hidden');

  await refreshSnapshots();
  setupListeners();
}

async function refreshSnapshots() {
  const [domainSnapshots, names] = await Promise.all([
    getSnapshotsForDomain(currentDomain),
    getOrderedSnapshotNames(currentDomain),
  ]);
  snapshots = domainSnapshots;

  const snapshotSelect  = $('snapshotSelect');
  const overwriteSelect = $('overwriteSelect');

  snapshotSelect.innerHTML  = '';
  overwriteSelect.innerHTML = '';
  snapshotSelect.appendChild(new Option(t('snapshot_placeholder'), ''));
  overwriteSelect.appendChild(new Option(t('overwrite_placeholder'), ''));

  for (const name of names) {
    snapshotSelect.appendChild(new Option(name, name));
    overwriteSelect.appendChild(new Option(name, name));
  }

  updateActionButtons();
}

function updateActionButtons() {
  const selected = $('snapshotSelect').value;
  $('loadBtn').disabled   = !selected;
  $('deleteBtn').disabled = !selected;

  $('snapshotMeta').textContent = (selected && snapshots[selected])
    ? t('saved_at', { date: new Date(snapshots[selected].savedAt).toLocaleString() })
    : '';
}

function setupListeners() {
  $('snapshotSelect').addEventListener('change', updateActionButtons);
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('saveBtn').addEventListener('click', () => $('savePanel').classList.toggle('hidden'));
  $('cancelSaveBtn').addEventListener('click', () => {
    $('savePanel').classList.add('hidden');
    $('newSnapshotName').value = '';
  });

  document.querySelectorAll('input[name="saveMode"]').forEach(radio => {
    radio.addEventListener('change', e => {
      const isNew = e.target.value === 'new';
      $('newNameArea').classList.toggle('hidden', !isNew);
      $('overwriteArea').classList.toggle('hidden', isNew);
    });
  });

  $('newSnapshotName').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
  });
  $('confirmSaveBtn').addEventListener('click', handleSave);
  $('loadBtn').addEventListener('click', handleLoad);
  $('deleteBtn').addEventListener('click', handleDelete);
}

async function handleSave() {
  const mode = document.querySelector('input[name="saveMode"]:checked').value;
  const name = mode === 'new' ? $('newSnapshotName').value.trim() : $('overwriteSelect').value;

  if (!name) {
    showStatus($('statusMsg'), t(mode === 'new' ? 'error_enter_name' : 'error_select_overwrite'), 'error');
    return;
  }

  $('confirmSaveBtn').disabled = true;
  try {
    const { enabledTypes } = await getSettings();
    const data = await collectData(activeTab.id, currentDomain, enabledTypes);
    await saveSnapshot(currentDomain, name, data);
    $('savePanel').classList.add('hidden');
    $('newSnapshotName').value = '';
    await refreshSnapshots();
    $('snapshotSelect').value = name;
    updateActionButtons();
    showStatus($('statusMsg'), t('status_saved', { name }), 'success');
  } catch (e) {
    showStatus($('statusMsg'), t('error_save_failed'), 'error');
    console.error(e);
  } finally {
    $('confirmSaveBtn').disabled = false;
  }
}

async function handleLoad() {
  const name = $('snapshotSelect').value;
  if (!name) return;

  if (!await showConfirm(t('confirm_load', { name }))) return;

  const snapshot = await loadSnapshot(currentDomain, name);
  if (!snapshot) return;

  const { enabledTypes } = await getSettings();
  $('loadBtn').disabled = true;
  try {
    await applyData(activeTab.id, currentDomain, snapshot, enabledTypes);
    showStatus($('statusMsg'), t('status_loaded', { name }), 'success');
  } catch (e) {
    showStatus($('statusMsg'), t('error_load_failed'), 'error');
    console.error(e);
  } finally {
    $('loadBtn').disabled = false;
  }
}

async function handleDelete() {
  const name = $('snapshotSelect').value;
  if (!name) return;

  if (!await showConfirm(t('confirm_delete_snapshot', { name }))) return;

  await deleteSnapshot(currentDomain, name);
  await refreshSnapshots();
  showStatus($('statusMsg'), t('status_deleted', { name }), 'success');
}

init();
