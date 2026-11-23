import { t } from './i18n.js';
import { SNAPSHOT_COLORS } from './snapshot-summary.js';

export function fillColorChip(el, color, baseClass) {
  if (!SNAPSHOT_COLORS.includes(color)) return false;
  el.classList.add(`${baseClass}--${color}`);
  el.setAttribute('aria-label', t('chip_label', { color: t(`color_${color}`) }));
  return true;
}

export function memoText(snapshot) {
  return typeof snapshot.memo === 'string' ? snapshot.memo : '';
}

export function searchQuery(value) {
  return value.trim().toLowerCase();
}

export function matchesQuery(query, ...texts) {
  return texts.some(text => typeof text === 'string' && text.toLowerCase().includes(query));
}

export function fillGroupChip(el, group) {
  el.textContent = t('group_chip', { group });
  el.title = t('group_chip_title', { group });
}
