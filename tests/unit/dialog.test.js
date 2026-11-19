import { describe, it, expect } from 'vitest';
import { showConfirm, showFormDialog, showChoice } from '../../lib/dialog.js';

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

describe('lib/dialog showFormDialog', () => {
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('showFormDialog resolves true on confirm and false on Esc/cancel', async () => {
    const input = document.createElement('input');
    let error = 'too short';
    const promise = showFormDialog({
      title: 'Passphrase',
      content: input,
      confirmLabel: 'Export',
      validate: () => error,
    });

    const d = dialog();
    const title = d.querySelector('.tk3-dialog-title');
    expect(title.textContent).toBe('Passphrase');
    expect(d.getAttribute('aria-labelledby')).toBe(title.id);
    expect(d.querySelector('.tk3-dialog-fields').contains(input)).toBe(true);
    const confirm = d.querySelector('.tk3-btn-confirm');
    expect(confirm.textContent).toBe('Export');

    confirm.click();
    await flush();
    expect(d.open).toBe(true);
    const errorEl = d.querySelector('.tk3-dialog-error');
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('too short');

    error = null;
    confirm.click();
    expect(await promise).toBe(true);
    expect(dialog()).toBeNull();

    const cancelled = showFormDialog({ title: 't', content: document.createElement('input') });
    dialog().querySelector('.tk3-btn-cancel').click();
    expect(await cancelled).toBe(false);

    const escaped = showFormDialog({ title: 't', content: document.createElement('input') });
    dialog().close();
    expect(await escaped).toBe(false);
  });
});

describe('lib/dialog showChoice', () => {
  it('showChoice resolves the chosen value, null on Esc', async () => {
    const choices = [
      { value: 'overwrite', label: 'Overwrite' },
      { value: 'skip', label: 'Skip' },
      { value: 'keepBoth', label: '<b>Keep both</b>' },
    ];
    const promise = showChoice('2 conflicts', choices);
    const d = dialog();
    expect(d.querySelector('.tk3-dialog-msg').textContent).toBe('2 conflicts');
    const buttons = [...d.querySelectorAll('.tk3-btn-confirm')];
    expect(buttons.map(b => b.textContent)).toEqual(['Overwrite', 'Skip', '<b>Keep both</b>']);
    buttons[1].click();
    expect(await promise).toBe('skip');

    const escaped = showChoice('again', choices);
    dialog().close();
    expect(await escaped).toBeNull();

    const cancelled = showChoice('again', choices);
    dialog().querySelector('.tk3-btn-cancel').click();
    expect(await cancelled).toBeNull();
  });
});
