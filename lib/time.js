const UNITS = [
  ['year',   365 * 24 * 60 * 60],
  ['month',   30 * 24 * 60 * 60],
  ['week',     7 * 24 * 60 * 60],
  ['day',          24 * 60 * 60],
  ['hour',              60 * 60],
  ['minute',                 60],
];

export function formatRelative(date, lang, now = Date.now()) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}
