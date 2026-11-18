const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The badge fits about four Latin letters or two CJK characters.
export function badgeText(name) {
  if (!name) return '';
  return [...segmenter.segment(name)].slice(0, 2).map(s => s.segment).join('');
}
