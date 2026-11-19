import { t } from './i18n.js';
import { escHtml } from './ui.js';

// Colors come from the --tk-* tokens of lib/tk-base.css, which every page loads.
// The native <dialog> opened with showModal() gives us the backdrop, focus
// containment, Esc handling and focus return, so none of that is hand-written here.
const STYLES = `
.tk3-dialog {
  background: var(--tk-surface);
  color: var(--tk-ink);
  border: 1px solid var(--tk-line);
  border-radius: var(--tk-radius);
  /* The pages reset every margin to 0; auto keeps the modal centered. */
  margin: auto;
  padding: 20px;
  max-width: 272px;
  width: calc(100% - 32px);
  box-shadow: 0 8px 32px rgb(0 0 0 / 0.25);
}
.tk3-dialog:modal {
  overscroll-behavior: contain;
}
.tk3-dialog::backdrop {
  background: rgb(0 0 0 / 0.45);
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
.tk3-dialog-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.tk3-dialog-msg {
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-line;
  margin: 0 0 16px;
}
.tk3-dialog-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 0 12px;
}
.tk3-dialog-fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.tk3-dialog-fields input:not([type="radio"]):not([type="checkbox"]) {
  padding: 6px 8px;
  border: 1px solid var(--tk-line-strong);
  border-radius: var(--tk-radius-sm);
  background: var(--tk-surface);
  color: var(--tk-ink);
  font: inherit;
  font-size: 13px;
}
.tk3-dialog-fields input:focus-visible {
  outline: 2px solid var(--tk-accent);
  outline-offset: 1px;
}
.tk3-dialog-error {
  color: var(--tk-red);
  font-size: 12px;
  line-height: 1.5;
  margin: 0 0 12px;
}
.tk3-dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin: 0;
}
.tk3-dialog-choices {
  flex-direction: column;
  align-items: stretch;
}
.tk3-dialog-choices .tk3-btn-cancel { margin-top: 4px; }
.tk3-btn {
  padding: 6px 18px;
  border: 1px solid transparent;
  border-radius: var(--tk-radius-pill);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  transition: filter 0.15s, background-color 0.15s;
}
.tk3-btn-cancel {
  background: transparent;
  color: var(--tk-ink);
  border-color: var(--tk-line);
}
.tk3-btn-cancel:hover { background: var(--tk-surface-2); }
.tk3-btn-confirm {
  background: var(--tk-accent);
  color: var(--tk-on-accent);
}
.tk3-btn-confirm:hover { filter: brightness(1.08); }
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

// `build(dialog, labelId)` fills the dialog; `result(returnValue)` maps how it closed.
function openDialog(build, result) {
  injectStyles();

  return new Promise(resolve => {
    const labelId = `tk3-dialog-label-${++nextId}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'tk3-dialog';
    dialog.setAttribute('aria-labelledby', labelId);
    // Also close when clicking outside. Where closedby is unsupported the dialog
    // still closes with Esc and the buttons.
    dialog.setAttribute('closedby', 'any');
    build(dialog, labelId);

    dialog.addEventListener('close', () => {
      // Esc and clicking outside set no returnValue, so they count as cancel.
      const value = result(dialog.returnValue);
      dialog.remove();
      resolve(value);
    }, { once: true });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/**
 * Ask the user to confirm. Resolves true only when the confirm button is used;
 * cancel, Esc and clicking outside the dialog all resolve false.
 */
export function showConfirm(message) {
  return openDialog((dialog, labelId) => {
    // Cancel gets the initial focus: these confirmations precede destructive actions.
    dialog.innerHTML = `
      <p class="tk3-dialog-msg" id="${labelId}">${escHtml(message)}</p>
      <form method="dialog" class="tk3-dialog-actions">
        <button class="tk3-btn tk3-btn-cancel" value="cancel" autofocus>${escHtml(t('btn_cancel'))}</button>
        <button class="tk3-btn tk3-btn-confirm" value="${CONFIRM}">${escHtml(t('btn_ok'))}</button>
      </form>
    `;
  }, value => value === CONFIRM);
}

/**
 * A dialog around fields the caller builds and reads. `content` is a Node placed
 * in the form. `validate()` may return an error message (or a promise of one);
 * while it does, the dialog stays open and shows it. Resolves true when confirmed,
 * false on cancel, Esc or clicking outside.
 */
export function showFormDialog({ title, content, confirmLabel = t('btn_ok'), validate = () => null }) {
  return openDialog((dialog, labelId) => {
    // Not method="dialog": submitting must be able to keep the dialog open.
    dialog.innerHTML = `
      <h2 class="tk3-dialog-title" id="${labelId}">${escHtml(title)}</h2>
      <form novalidate>
        <div class="tk3-dialog-fields"></div>
        <p class="tk3-dialog-error" role="alert" hidden></p>
        <div class="tk3-dialog-actions">
          <button type="button" class="tk3-btn tk3-btn-cancel">${escHtml(t('btn_cancel'))}</button>
          <button type="submit" class="tk3-btn tk3-btn-confirm">${escHtml(confirmLabel)}</button>
        </div>
      </form>
    `;
    dialog.querySelector('.tk3-dialog-fields').append(content);
    const form = dialog.querySelector('form');
    const error = dialog.querySelector('.tk3-dialog-error');
    const confirmBtn = dialog.querySelector('.tk3-btn-confirm');

    dialog.querySelector('.tk3-btn-cancel').addEventListener('click', () => dialog.close('cancel'));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      let message;
      try {
        message = await validate();
      } catch (err) {
        // Shown in the dialog: escaping the listener would leave the user
        // pressing a button that visibly does nothing.
        console.error(err);
        message = t('error_dialog_check_failed');
      } finally {
        confirmBtn.disabled = false;
      }
      if (message) {
        error.textContent = message;
        error.hidden = false;
        return;
      }
      dialog.close(CONFIRM);
    });
  }, value => value === CONFIRM);
}

/**
 * Ask the user to pick one of `choices` ([{ value, label }]), shown as stacked
 * buttons above a cancel button. Resolves the chosen value, or null on cancel,
 * Esc or clicking outside.
 */
export function showChoice(message, choices) {
  return openDialog((dialog, labelId) => {
    // Cancel gets the initial focus: some choices overwrite data.
    dialog.innerHTML = `
      <p class="tk3-dialog-msg" id="${labelId}">${escHtml(message)}</p>
      <form method="dialog" class="tk3-dialog-actions tk3-dialog-choices">
        ${choices.map((c, i) => `<button class="tk3-btn tk3-btn-confirm" value="choice-${i}">${escHtml(c.label)}</button>`).join('')}
        <button class="tk3-btn tk3-btn-cancel" value="cancel" autofocus>${escHtml(t('btn_cancel'))}</button>
      </form>
    `;
  }, value => {
    const match = /^choice-(\d+)$/.exec(value);
    return match ? choices[Number(match[1])].value : null;
  });
}
