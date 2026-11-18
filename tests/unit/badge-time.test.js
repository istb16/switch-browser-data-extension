import { describe, it, expect } from 'vitest';
import { badgeText } from '../../lib/badge.js';
import { formatRelative } from '../../lib/time.js';

describe('lib/badge', () => {
  it('takes the first two characters, keeping emoji and combined characters whole', () => {
    expect(badgeText('Admin')).toBe('Ad');
    expect(badgeText('管理者')).toBe('管理');
    expect(badgeText('👨‍👩‍👧 family')).toBe('👨‍👩‍👧 ');
    expect(badgeText('')).toBe('');
    expect(badgeText(null)).toBe('');
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
