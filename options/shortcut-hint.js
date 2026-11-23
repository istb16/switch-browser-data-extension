import { t } from '../lib/i18n.js';
import { $ } from '../lib/ui.js';

const COMMAND = 'switch-previous';
const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

export async function renderShortcutHint() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find(c => c.name === COMMAND)?.shortcut;
  $('shortcutKey').textContent = shortcut || t('shortcut_unset');
}

// The key is assigned on the browser's shortcuts page, so coming back to this
// page is the moment it may have changed.
export async function initShortcutHint() {
  $('openShortcutsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: SHORTCUTS_URL }).catch(console.error);
  });
  window.addEventListener('focus', () => {
    renderShortcutHint().catch(console.error);
  });
  await renderShortcutHint().catch(console.error);
}
