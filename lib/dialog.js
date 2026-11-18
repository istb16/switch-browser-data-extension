import { t } from './i18n.js';
import { escHtml } from './ui.js';

// The native <dialog> opened with showModal() gives us the backdrop, focus
// containment, Esc handling and focus return, so none of that is hand-written here.
const STYLES = `
.tk3-dialog {
  background: #24273a;
  color: #cdd6f4;
  border: 1px solid #45475a;
  border-radius: 10px;
  padding: 20px;
  max-width: 272px;
  width: calc(100% - 32px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.tk3-dialog:modal {
  overscroll-behavior: contain;
}
.tk3-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
  overflow: hidden;
  overscroll-behavior: contain;
}
@media (prefers-reduced-motion: no-preference) {
  .tk3-dialog[open] { animation: tk3-slide-up 0.12s ease; }
  .tk3-dialog[open]::backdrop { animation: tk3-fade-in 0.1s ease; }
}
@keyframes tk3-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes tk3-slide-up {
  from { transform: translateY(6px); opacity: 0; }
  to   { transform: translateY(0);   opacity: 1; }
}
.tk3-dialog-msg {
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-line;
  margin: 0 0 16px;
}
.tk3-dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin: 0;
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

const CONFIRM = 'confirm';
let nextId = 0;

function injectStyles() {
  if (document.getElementById('tk3-dialog-css')) return;
  const el = document.createElement('style');
  el.id = 'tk3-dialog-css';
  el.textContent = STYLES;
  document.head.appendChild(el);
}

/**
 * Ask the user to confirm. Resolves true only when the confirm button is used;
 * cancel, Esc and clicking outside the dialog all resolve false.
 */
export function showConfirm(message) {
  injectStyles();

  return new Promise(resolve => {
    const msgId = `tk3-dialog-msg-${++nextId}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'tk3-dialog';
    dialog.setAttribute('aria-labelledby', msgId);
    // Also close when clicking outside. Where closedby is unsupported the dialog
    // still closes with Esc and the buttons.
    dialog.setAttribute('closedby', 'any');
    // Cancel gets the initial focus: these confirmations precede destructive actions.
    dialog.innerHTML = `
      <p class="tk3-dialog-msg" id="${msgId}">${escHtml(message)}</p>
      <form method="dialog" class="tk3-dialog-actions">
        <button class="tk3-btn tk3-btn-cancel" value="cancel" autofocus>${escHtml(t('btn_cancel'))}</button>
        <button class="tk3-btn tk3-btn-confirm" value="${CONFIRM}">${escHtml(t('btn_ok'))}</button>
      </form>
    `;

    dialog.addEventListener('close', () => {
      // Esc and clicking outside set no returnValue, so they count as cancel.
      const confirmed = dialog.returnValue === CONFIRM;
      dialog.remove();
      resolve(confirmed);
    }, { once: true });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
