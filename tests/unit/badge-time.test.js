import { describe, it, expect } from 'vitest';
import { badgeText, badgeColors, labelColorsOf } from '../../lib/badge.js';
import { formatRelative } from '../../lib/time.js';

describe('lib/badge', () => {
  it('takes the first two characters, keeping emoji and combined characters whole', () => {
    expect(badgeText('Admin')).toBe('Ad');
    expect(badgeText('管理者')).toBe('管理');
    expect(badgeText('👨‍👩‍👧 family')).toBe('👨‍👩‍👧 ');
    expect(badgeText('')).toBe('');
    expect(badgeText(null)).toBe('');
  });

  const DEFAULT = { background: '#1F63D8', text: '#FFFFFF' };

  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('badgeColors returns the default for no, unknown or inherited-name label', () => {
    for (const color of [undefined, null, 'pink', 'constructor', '__proto__', 'toString']) {
      expect(badgeColors(color)).toEqual(DEFAULT);
    }
    expect(badgeColors('blue')).toEqual(DEFAULT);
    expect(badgeColors('red')).toEqual({ background: '#C5221F', text: '#FFFFFF' });
    expect(badgeColors('green')).toEqual({ background: '#1E7E45', text: '#FFFFFF' });
    expect(badgeColors('amber')).toEqual({ background: '#F6B820', text: '#1B1C20' });
  });

  it('every badge pair reaches 4.5:1', () => {
    for (const color of [undefined, 'blue', 'green', 'red', 'amber']) {
      const { background, text } = badgeColors(color);
      expect(contrast(background, text)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('amber differs from red in luminance', () => {
    expect(contrast(badgeColors('amber').background, badgeColors('red').background)).toBeGreaterThanOrEqual(3);
  });

  it('labelColorsOf keeps only valid labels', () => {
    const colors = labelColorsOf({
      Admin: { color: 'red' },
      User: {},
      Guest: { color: 'pink' },
      Broken: null,
      Text: 'not a snapshot',
      Owner: { color: 'amber' },
    });
    expect(colors).toEqual(new Map([['Admin', 'red'], ['Owner', 'amber']]));
    expect(labelColorsOf(undefined)).toEqual(new Map());
    expect(labelColorsOf('x')).toEqual(new Map());
  });

  it('labelColorsOf treats __proto__ and constructor as plain names', () => {
    const snapshots = JSON.parse('{"__proto__": {"color": "red"}, "constructor": {"color": "green"}, "toString": {}}');
    const colors = labelColorsOf(snapshots);
    expect(colors.get('__proto__')).toBe('red');
    expect(colors.get('constructor')).toBe('green');
    expect(colors.has('toString')).toBe(false);
    expect(colors.size).toBe(2);

    expect(labelColorsOf(JSON.parse('{"__proto__": {}, "constructor": {}}')).size).toBe(0);
  });
});

describe('lib/time', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');

  it('formats past times relative to now', () => {
    expect(formatRelative('2026-01-10T11:59:50Z', 'en', now)).toBe('now');
    expect(formatRelative('2026-01-10T11:55:00Z', 'en', now)).toBe('5 minutes ago');
    expect(formatRelative('2026-01-09T12:00:00Z', 'en', now)).toBe('yesterday');
    expect(formatRelative('2026-01-08T12:00:00Z', 'ja', now)).toBe('一昨日');
  });
});
