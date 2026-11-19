import { $ } from '../lib/ui.js';
import { entryOfRow } from './context.js';
import { renderList, visibleMains } from './list.js';
import { handleDelete } from './actions.js';

export function handleSearchKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    // The Enter that confirms an IME conversion (Japanese input) must not load.
    // keyCode 229 covers Safari, which reports isComposing too late.
    if (e.isComposing || e.keyCode === 229) return;
    visibleMains()[0]?.click();
  } else if (e.key === 'Escape' && $('searchInput').value) {
    e.preventDefault();
    $('searchInput').value = '';
    renderList();
  }
}

export function handleShortcut(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  const target = e.target;
  if (target.closest?.('[popover]')) return;
  const editable = target.matches?.('input, textarea, select, [contenteditable]');
  const mains = visibleMains();
  const searchVisible = !$('searchBox').classList.contains('hidden');

  if (e.key === '/' && !editable && searchVisible) {
    e.preventDefault();
    $('searchInput').focus();
    return;
  }

  if (!editable && /^[1-9]$/.test(e.key)) {
    const main = mains[Number(e.key) - 1];
    if (main) {
      e.preventDefault();
      main.click();
    }
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const down = e.key === 'ArrowDown';
    let next = null;
    if (target === $('searchInput')) {
      next = down ? mains[0] : null;
    } else {
      const index = mains.indexOf(target);
      if (index < 0) return;
      next = down ? mains[index + 1] : (mains[index - 1] ?? (searchVisible ? $('searchInput') : null));
    }
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  if (e.key === 'Delete' && mains.includes(target)) {
    e.preventDefault();
    handleDelete(entryOfRow(target.closest('.snapshot')));
  }
}
