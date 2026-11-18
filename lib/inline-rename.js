import { t } from './i18n.js';

/**
 * Wires a text input used to rename something in place. Enter and blur commit,
 * Escape cancels. onError(message) shows a validation error and keeps the input
 * open; onError(null) clears it. Exactly one of onCommit(newName) or onCancel()
 * runs, once.
 */
export function bindInlineRename(input, { oldName, exists, onError, onCommit, onCancel }) {
  let settled = false;
  let checking = false;

  async function commit() {
    if (settled || checking) return;
    const newName = input.value.trim();
    onError(null);
    if (!newName) {
      onError(t('error_empty_name'));
      return;
    }
    if (newName === oldName) {
      cancel();
      return;
    }
    checking = true;
    const duplicate = await exists(newName);
    checking = false;
    if (settled) return;
    if (duplicate) {
      onError(t('error_duplicate_name', { name: newName }));
      return;
    }
    settled = true;
    await onCommit(newName);
  }

  function cancel() {
    if (settled) return;
    settled = true;
    onError(null);
    onCancel();
  }

  input.addEventListener('keydown', e => {
    // Keys typed into the name must not reach list shortcuts or drag handling.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      // The Enter that confirms an IME conversion (Japanese input) must not commit.
      // keyCode 229 covers Safari, which reports isComposing too late.
      if (e.isComposing || e.keyCode === 229) return;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', commit);
}
