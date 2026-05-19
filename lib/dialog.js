import { t } from './i18n.js';
import { escHtml } from './ui.js';

const STYLES = `
.tk3-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  animation: tk3-fade-in 0.1s ease;
}
@keyframes tk3-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.tk3-dialog {
  background: #24273a;
  border: 1px solid #45475a;
  border-radius: 10px;
  padding: 20px;
  max-width: 272px;
  width: calc(100% - 32px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  animation: tk3-slide-up 0.12s ease;
}
@keyframes tk3-slide-up {
  from { transform: translateY(6px); opacity: 0; }
  to   { transform: translateY(0);   opacity: 1; }
}
.tk3-dialog-msg {
  color: #cdd6f4;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-line;
  margin: 0 0 16px;
}
.tk3-dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.tk3-btn {
  padding: 6px 18px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: filter 0.15s;
}
.tk3-btn-cancel {
  background: #313244;
  color: #cdd6f4;
}
.tk3-btn-cancel:hover { filter: brightness(1.25); }
.tk3-btn-confirm {
  background: #89b4fa;
  color: #1e1e2e;
}
.tk3-btn-confirm:hover { filter: brightness(1.1); }
`;

function injectStyles() {
  if (document.getElementById('tk3-dialog-css')) return;
  const el = document.createElement('style');
  el.id = 'tk3-dialog-css';
  el.textContent = STYLES;
  document.head.appendChild(el);
}

export function showConfirm(message) {
  injectStyles();

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'tk3-overlay';
    overlay.innerHTML = `
      <div class="tk3-dialog" role="dialog" aria-modal="true">
        <p class="tk3-dialog-msg">${escHtml(message)}</p>
        <div class="tk3-dialog-actions">
          <button class="tk3-btn tk3-btn-cancel">${escHtml(t('btn_cancel'))}</button>
          <button class="tk3-btn tk3-btn-confirm">${escHtml(t('btn_ok'))}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn  = overlay.querySelector('.tk3-btn-cancel');
    const confirmBtn = overlay.querySelector('.tk3-btn-confirm');
    cancelBtn.focus();

    function close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }

    cancelBtn.addEventListener('click',  () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
  });
}
