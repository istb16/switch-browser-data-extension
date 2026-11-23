import { initI18n, t, applyI18n, setLanguage, getSavedLangSetting } from '../lib/i18n.js';
import { getSettings, setSettings, getGroups } from '../lib/storage.js';
import { clearAllData, migrateStorage } from '../lib/snapshot.js';
import { showConfirm } from '../lib/dialog.js';
import { $, notify } from '../lib/ui.js';
import { renderDomainList, markStale } from './domain-list.js';
import { renderGroups, handleAddGroup } from './groups-pane.js';
import { handleExport, handleImport } from './transfer-ui.js';

const PANES = ['general', 'data-types', 'snapshots', 'data'];

const TOGGLES = [
  { id: 'toggleCookies',        type: 'cookies' },
  { id: 'toggleLocalStorage',   type: 'localStorage' },
  { id: 'toggleSessionStorage', type: 'sessionStorage' },
  { id: 'toggleIndexedDB',      type: 'indexedDB' },
  { id: 'toggleAutoBackup',     key: 'autoBackup' },
  { id: 'toggleAutoReload',     key: 'autoReload' },
  { id: 'toggleReloadOtherTabs', key: 'reloadOtherTabs' },
  { id: 'toggleShowBadge',      key: 'showBadge' },
  { id: 'toggleEncryptExports', key: 'encryptExports' },
];

const onGroupsChange = groups => renderDomainList(groups);

async function renderList() {
  await renderDomainList(await getGroups());
}

async function renderAll() {
  const groups = await getGroups();
  renderGroups(groups, onGroupsChange);
  await renderDomainList(groups);
}

async function init() {
  setupNav();
  await initI18n();
  applyI18n();
  renderVersionFooter();
  // The old keys stay on failure and the next open retries; the page still has to work.
  await migrateStorage().catch(console.error);

  $('langSelect').value = await getSavedLangSetting();
  $('langSelect').addEventListener('change', handleLanguageChange);

  const settings = await getSettings();
  for (const { id, type, key } of TOGGLES) {
    $(id).checked = type ? settings.enabledTypes[type] : settings[key];
    $(id).addEventListener('change', handleSaveSettings);
  }
  syncDependentToggles();
  $('exportBtn').addEventListener('click', () => handleExport({}, $('exportBtn')));
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => handleImport(e, () => {
    markStale();
    return renderList();
  }));
  $('clearAllBtn').addEventListener('click', handleClearAll);
  $('sortSelect').addEventListener('change', renderList);
  $('groupForm').addEventListener('submit', e => handleAddGroup(e, onGroupsChange));

  await renderAll();
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

async function handleLanguageChange() {
  await setLanguage($('langSelect').value);
  applyI18n();
  renderVersionFooter();
  await renderAll();
}

function renderVersionFooter() {
  $('versionFooter').textContent = t('footer_version', { version: chrome.runtime.getManifest().version });
}

// Other tabs are only reloaded along with the current one. A disabled box keeps
// its checked state, so the stored choice survives turning auto reload off.
function syncDependentToggles() {
  $('toggleReloadOtherTabs').disabled = !$('toggleAutoReload').checked;
}

async function handleSaveSettings() {
  syncDependentToggles();
  const settings = await getSettings();
  settings.enabledTypes = {};
  for (const { id, type, key } of TOGGLES) {
    if (type) settings.enabledTypes[type] = $(id).checked;
    else settings[key] = $(id).checked;
  }
  await setSettings(settings);
  notify('status_settings_saved');
}

async function handleClearAll() {
  if (!await showConfirm(t('confirm_clear_all'))) return;
  await clearAllData();
  markStale();
  await renderList();
  notify('status_cleared');
}

// init() attaches the click listeners partway through, after several awaits, so
// a click that lands before then hits a live-looking button and silently does
// nothing. E2E tests wait on this flag before touching the static buttons.
init().finally(() => document.body.setAttribute('data-ready', 'true'));
