import { initI18n, t, applyI18n } from '../lib/i18n.js';
import { readKeys } from '../lib/storage.js';
import { requestHostPermission, hasHostPermission } from '../lib/data-bridge.js';
import { resolveScope } from '../lib/groups.js';
import { migrateStorage } from '../lib/snapshot.js';
import { fillGroupChip } from '../lib/snapshot-view.js';
import { $ } from '../lib/ui.js';
import { state } from './context.js';
import { renderList, setRowActions } from './list.js';
import {
  refresh, detectChanges, enabledTypeNames, startRename,
  handleLoad, handleLoadPartial, handleOverwrite, handleEditDetails, handleDelete, handleIgnoreCookie,
  handleSaveNew, handleUndo, handleClearSite,
} from './actions.js';
import { openSaveForm, closeSaveForm } from './save-form.js';
import { handleShortcut, handleSearchKey } from './shortcuts.js';
import { showCommandNotice } from './command-notice.js';

setRowActions({
  load: handleLoad,
  loadPartial: handleLoadPartial,
  overwrite: handleOverwrite,
  rename: startRename,
  editDetails: handleEditDetails,
  delete: handleDelete,
  ignoreCookie: handleIgnoreCookie,
});

async function init() {
  const [, [tab]] = await Promise.all([
    initI18n().then(applyI18n),
    chrome.tabs.query({ active: true, currentWindow: true }),
    // The old keys stay on failure and the next open retries; the popup still has to work.
    migrateStorage().catch(console.error),
  ]);
  state.activeTab = tab;

  const isRestrictedUrl = !tab?.url
    || tab.url.startsWith('chrome://')
    || tab.url.startsWith('edge://')
    || tab.url.startsWith('about:');

  let host = null;
  try {
    if (!isRestrictedUrl) host = new URL(tab.url).hostname;
  } catch {
    // Shown as unavailable below.
  }
  if (host === null) {
    await showNotice(tab);
    showUnavailable();
    return;
  }

  $('currentDomain').textContent = host;
  const { settings, groups, commandNotice, ...lists } = await readKeys(['settings', 'groups', 'commandNotice', 'snapshotHosts', 'snapshotOrder', 'activeSnapshots']);
  await showNotice(tab, commandNotice);
  state.settings = settings;
  state.groups = groups;
  state.scope = resolveScope(host, state.groups);
  if (state.scope.group) {
    const chip = $('groupChip');
    fillGroupChip(chip, state.scope.group);
    chip.classList.remove('hidden');
  }

  if (state.settings.enabledTypes.cookies && !await hasHostPermission(state.scope)) {
    showPermissionPanel();
    return;
  }
  await showMain(lists);
}

// Before the permission panel, which a notice about a refused switch may explain.
async function showNotice(tab, notice) {
  if (tab?.id == null) return;
  try {
    await showCommandNotice(tab, notice);
  } catch (e) {
    console.error(e);
  }
}

async function showMain(lists) {
  $('permissionPanel').classList.add('hidden');
  $('mainContent').classList.remove('hidden');
  await refresh(lists);
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
  const { scope } = state;
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
  $('searchInput').addEventListener('keydown', handleSearchKey);

  document.addEventListener('keydown', handleShortcut);
}

// setupListeners() runs partway through init(), after several awaits, so a click
// that lands before then hits a live-looking button and silently does nothing.
// E2E tests wait on this flag before touching the static buttons.
init().finally(() => document.body.setAttribute('data-ready', 'true'));
