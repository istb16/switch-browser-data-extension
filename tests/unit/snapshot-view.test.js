import { describe, it, expect } from 'vitest';
import { fillColorChip, memoText, fillGroupChip, searchQuery, matchesQuery } from '../../lib/snapshot-view.js';
import { MESSAGES } from '../../lib/i18n.js';

describe('lib/snapshot-view', () => {
  it('fillColorChip adds the colour class and label for a known colour', () => {
    const el = document.createElement('span');
    el.className = 'snapshot__chip';
    expect(fillColorChip(el, 'green', 'snapshot__chip')).toBe(true);
    expect(el.className).toBe('snapshot__chip snapshot__chip--green');
    expect(el.getAttribute('aria-label'))
      .toBe(MESSAGES.ja.chip_label.replace('{color}', MESSAGES.ja.color_green));
  });

  it('fillColorChip returns false and leaves the element alone for an unknown colour', () => {
    const el = document.createElement('span');
    el.className = 'snapshot-chip';
    expect(fillColorChip(el, 'pink', 'snapshot-chip')).toBe(false);
    expect(fillColorChip(el, undefined, 'snapshot-chip')).toBe(false);
    expect(el.className).toBe('snapshot-chip');
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('memoText returns the memo, or empty for a missing or non-string one', () => {
    expect(memoText({ memo: 'admin' })).toBe('admin');
    expect(memoText({})).toBe('');
    expect(memoText({ memo: 123 })).toBe('');
  });

  it('matchesQuery trims, ignores case and skips non-strings', () => {
    const query = searchQuery('  WoRk ');
    expect(query).toBe('work');
    expect(matchesQuery(query, 'Admin', 'My Work account')).toBe(true);
    expect(matchesQuery(query, 'Admin', 'home')).toBe(false);
    expect(matchesQuery(query, undefined, null, 42, { memo: 'work' })).toBe(false);
    expect(matchesQuery(searchQuery(''), 'anything')).toBe(true);
  });

  it('fillGroupChip sets the text and title', () => {
    const el = document.createElement('span');
    fillGroupChip(el, 'example.com');
    expect(el.textContent).toBe(MESSAGES.ja.group_chip.replace('{group}', 'example.com'));
    expect(el.title).toBe(MESSAGES.ja.group_chip_title.replace('{group}', 'example.com'));
  });
});
