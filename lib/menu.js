// A popup menu: a trigger button with commandfor/command="toggle-popover", the
// popover right after it, and a focusgroup="menu nomemory" container inside the
// popover. The invoker and focusgroup do the opening and arrow keys natively;
// this adds keyboard entry, focus restoration and the fallbacks.

const hasInvokers   = 'commandForElement' in HTMLButtonElement.prototype;
const hasFocusgroup = 'focusGroup' in HTMLElement.prototype;
const hasAnchorPos  = globalThis.CSS?.supports?.('position-area: block-end') ?? false;

function isOpen(menu) {
  try {
    return menu.matches(':popover-open');
  } catch {
    return false;
  }
}

function placeBelow(menu, trigger) {
  const gap = 4;
  const rect = trigger.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = menu;
  const left = Math.max(gap, Math.min(rect.right - w, innerWidth - w - gap));
  const below = rect.bottom + gap;
  const top = below + h > innerHeight - gap ? Math.max(gap, rect.top - gap - h) : below;
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;
}

export function setupMenu(trigger, menu, onAction) {
  const group = menu.querySelector('[focusgroup]');
  const items = () => [...group.querySelectorAll('button')].filter(b => !b.disabled);
  let enterOnOpen = false;

  if (!hasFocusgroup) {
    group.setAttribute('role', 'menu');
    items().forEach(item => item.setAttribute('role', 'menuitem'));
  }

  function close({ fromPointer }) {
    trigger.focus({ focusVisible: !fromPointer });
    if (isOpen(menu)) menu.hidePopover();
  }

  // Keeps a pointer press from moving focus, so only keyboard opens enter the menu.
  trigger.addEventListener('pointerdown', e => e.preventDefault());

  trigger.addEventListener('click', e => {
    // A click with detail 0 came from Enter or Space.
    if (e.detail === 0) enterOnOpen = true;
    if (hasInvokers) return;
    e.preventDefault();
    if (isOpen(menu)) close({ fromPointer: e.detail !== 0 });
    else menu.showPopover({ source: trigger });
  });

  trigger.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (isOpen(menu)) {
      items()[0]?.focus();
    } else {
      enterOnOpen = true;
      trigger.click();
    }
  });

  menu.addEventListener('toggle', e => {
    const open = e.newState === 'open';
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!hasAnchorPos) placeBelow(menu, trigger);
      if (enterOnOpen) items()[0]?.focus();
      else trigger.focus({ focusVisible: false });
    }
    enterOnOpen = false;
  });

  group.addEventListener('keydown', e => {
    const list = items();
    const current = list.indexOf(document.activeElement);
    if (current < 0) return;
    let next = null;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (!hasFocusgroup && e.key === 'ArrowDown') next = (current + 1) % list.length;
    else if (!hasFocusgroup && e.key === 'ArrowUp') next = (current - 1 + list.length) % list.length;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    list[next].focus();
  });

  group.addEventListener('pointermove', e => {
    const item = e.target.closest('button');
    if (item && item !== document.activeElement) item.focus({ focusVisible: false });
  });

  group.addEventListener('click', e => {
    const item = e.target.closest('button[data-action]');
    if (!item) return;
    close({ fromPointer: e.detail !== 0 });
    onAction(item.dataset.action);
  });

  menu.addEventListener('focusout', e => {
    if (!menu.contains(e.relatedTarget) && e.relatedTarget !== trigger && isOpen(menu)) menu.hidePopover();
  });
}
