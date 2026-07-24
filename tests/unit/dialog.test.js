import { describe, it, expect } from 'vitest';
import { showConfirm } from '../../lib/dialog.js';

describe('lib/dialog showConfirm', () => {
  it('renders an overlay with the message and resolves true on confirm', async () => {
    const promise = showConfirm('本当に削除しますか？');

    const overlay = document.querySelector('.tk3-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.tk3-dialog-msg').textContent).toBe('本当に削除しますか？');

    overlay.querySelector('.tk3-btn-confirm').click();
    expect(await promise).toBe(true);
    expect(document.querySelector('.tk3-overlay')).toBeNull();
  });

  it('resolves false when cancel is clicked', async () => {
    const promise = showConfirm('confirm?');
    document.querySelector('.tk3-btn-cancel').click();
    expect(await promise).toBe(false);
  });

  it('resolves false on Escape', async () => {
    const promise = showConfirm('confirm?');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await promise).toBe(false);
  });

  it('resolves false when clicking the backdrop outside the dialog', async () => {
    const promise = showConfirm('confirm?');
    document.querySelector('.tk3-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await promise).toBe(false);
  });

  it('escapes HTML in the message', async () => {
    const promise = showConfirm('<img src=x>');
    expect(document.querySelector('.tk3-dialog-msg').innerHTML).toBe('&lt;img src=x&gt;');
    document.querySelector('.tk3-btn-cancel').click();
    await promise;
  });

  it('only injects the stylesheet once across multiple dialogs', async () => {
    const first = showConfirm('one');
    document.querySelector('.tk3-btn-cancel').click();
    await first;

    const second = showConfirm('two');
    expect(document.querySelectorAll('#tk3-dialog-css')).toHaveLength(1);
    document.querySelector('.tk3-btn-cancel').click();
    await second;
  });
});
