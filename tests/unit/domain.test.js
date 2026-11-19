import { describe, it, expect } from 'vitest';
import { isWithin, toCookieScope } from '../../lib/domain.js';

describe('lib/domain isWithin', () => {
  it('holds for the base itself and its subdomains', () => {
    expect(isWithin('example.com', 'example.com')).toBe(true);
    expect(isWithin('app.example.com', 'example.com')).toBe(true);
    expect(isWithin('a.b.example.com', 'example.com')).toBe(true);
  });

  it('does not hold for a sibling, a parent or a lookalike', () => {
    expect(isWithin('www.example.com', 'app.example.com')).toBe(false);
    expect(isWithin('example.com', 'app.example.com')).toBe(false);
    expect(isWithin('notexample.com', 'example.com')).toBe(false);
  });
});

describe('lib/domain toCookieScope', () => {
  it('reads a string as the domain with its subdomains', () => {
    expect(toCookieScope('example.com')).toEqual({ domain: 'example.com', exact: false });
  });

  it('keeps the domain and exact of an object, and only those', () => {
    expect(toCookieScope({ domain: 'example.com', exact: true, extra: 1 })).toEqual({ domain: 'example.com', exact: true });
    expect(toCookieScope({ domain: 'example.com' })).toEqual({ domain: 'example.com', exact: false });
  });
});
