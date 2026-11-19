import { t } from './i18n.js';

export const $ = id => document.getElementById(id);

export function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showStatus(element, msg, type) {
  element.textContent = msg;
  element.className = `status-msg ${type}`;
  element.classList.remove('hidden');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.add('hidden'), 3000);
}

export function notify(key, vars = {}, type = 'success') {
  showStatus($('statusMsg'), t(key, vars), type);
}

export function reportError(key, error) {
  showStatus($('statusMsg'), t(key), 'error');
  console.error(error);
}
