import { t } from '../lib/i18n.js';
import { readKeys } from '../lib/storage.js';
import { httpHostOf } from '../lib/domain.js';
import { $, showStatus } from '../lib/ui.js';

// The notice comes from storage, so only these keys may reach t(); anything else is dropped.
const NOTICE_KEYS = new Set([
  'shortcut_needs_backup',
  'shortcut_no_previous',
  'shortcut_page_unreachable',
  'shortcut_backup_failed',
  'unavailable',
  'error_load_failed',
]);

// `stored` is the notice init() already read with its other keys; otherwise it is read here.
export async function showCommandNotice(tab, stored) {
  const notice = stored === undefined ? (await readKeys(['commandNotice'])).commandNotice : stored;
  if (!notice) return;
  const expired = !(notice.until > Date.now());
  // Another tab's notice stays for when the popup is opened there.
  if (!expired && notice.tabId !== tab.id) return;
  await chrome.storage.local.remove('commandNotice');
  if (expired || !NOTICE_KEYS.has(notice.key)) return;
  // A notice about the site this tab has since left would read as this site's error.
  if (notice.host !== httpHostOf(tab.url)) return;
  showStatus($('statusMsg'), t(notice.key), 'error');
}
