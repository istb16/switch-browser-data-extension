import { SNAPSHOT_COLORS } from './snapshot-summary.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The badge fits about four Latin letters or two CJK characters.
export function badgeText(name) {
  if (!name) return '';
  return [...segmenter.segment(name)].slice(0, 2).map(s => s.segment).join('');
}

// The badge is drawn by the browser, not a page, so it cannot read the --tk-*
// tokens; these are their light values from lib/tk-base.css. Amber uses
// --tk-icon-yellow with --tk-ink, as --tk-amber is too close to red at this size.
const DEFAULT_COLORS = { background: '#1F63D8', text: '#FFFFFF' };
const LABEL_COLORS = {
  blue:  DEFAULT_COLORS,
  green: { background: '#1E7E45', text: '#FFFFFF' },
  red:   { background: '#C5221F', text: '#FFFFFF' },
  amber: { background: '#F6B820', text: '#1B1C20' },
};

export function badgeColors(color) {
  return SNAPSHOT_COLORS.includes(color) ? LABEL_COLORS[color] : DEFAULT_COLORS;
}

// A tab that closed meanwhile refuses the calls; there is nothing left to draw on.
export function drawBadge(tabId, text, colors) {
  return Promise.all([
    chrome.action.setBadgeText({ tabId, text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ tabId, color: colors.background }).catch(() => {}),
    chrome.action.setBadgeTextColor({ tabId, color: colors.text }).catch(() => {}),
  ]);
}

export function labelColorsOf(snapshots) {
  const colors = new Map();
  if (!snapshots || typeof snapshots !== 'object') return colors;
  for (const [name, snapshot] of Object.entries(snapshots)) {
    if (SNAPSHOT_COLORS.includes(snapshot?.color)) colors.set(name, snapshot.color);
  }
  return colors;
}
