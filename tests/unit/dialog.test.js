import { describe, it, expect } from 'vitest';
import { showConfirm } from '../../lib/dialog.js';

const dialog = () => document.querySelector('dialog.tk3-dialog');

describe('lib/dialog showConfirm', () => {
  it('opens a native modal dialog with the message and resolves true on confirm', async () => {
    const promise = showConfirm('本当に削除しますか？');

    expect(dialog()).not.toBeNull();
    expect(dialog().open).toBe(true);
    expect(dialog().querySelector('.tk3-dialog-msg').textContent).toBe('本当に削除しますか？');

    dialog().querySelector('.tk3-btn-confirm').click();
    expect(await promise).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('resolves false when cancel is clicked', async () => {
    const promise = showConfirm('confirm?');
    dialog().querySelector('.tk3-btn-cancel').click();
    expect(await promise).toBe(false);
  });

  it('resolves false when closed without a button (Esc or clicking outside)', async () => {
    const promise = showConfirm('confirm?');
    dialog().close();
    expect(await promise).toBe(false);
  });

  it('is named by its message, light-dismissable, and focuses cancel first', async () => {
    const promise = showConfirm('confirm?');
    const d = dialog();
    const msg = d.querySelector('.tk3-dialog-msg');
    expect(d.getAttribute('aria-labelledby')).toBe(msg.id);
    expect(d.getAttribute('closedby')).toBe('any');
    expect(d.hasAttribute('role')).toBe(false);
    expect(d.querySelector('.tk3-btn-cancel').hasAttribute('autofocus')).toBe(true);
    d.close();
    await promise;
  });

  it('escapes HTML in the message', async () => {
    const promise = showConfirm('<img src=x>');
    expect(dialog().querySelector('.tk3-dialog-msg').innerHTML).toBe('&lt;img src=x&gt;');
    dialog().querySelector('.tk3-btn-cancel').click();
    await promise;
  });

  it('only injects the stylesheet once across multiple dialogs', async () => {
    const first = showConfirm('one');
    dialog().querySelector('.tk3-btn-cancel').click();
    await first;

    const second = showConfirm('two');
    expect(document.querySelectorAll('#tk3-dialog-css')).toHaveLength(1);
    dialog().querySelector('.tk3-btn-cancel').click();
    await second;
  });
});
