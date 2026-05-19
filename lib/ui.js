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
