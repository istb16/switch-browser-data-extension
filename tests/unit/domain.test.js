import { describe, it, expect } from 'vitest';
import { isWithin, toCookieScope, httpHostOf } from '../../lib/domain.js';

describe('lib/domain httpHostOf', () => {
  it('returns the lowercase host name of an http(s) URL, without the port', () => {
    expect(httpHostOf('https://example.com/app?x=1#y')).toBe('example.com');
    expect(httpHostOf('http://a.com:8080/x')).toBe('a.com');
    expect(httpHostOf('https://APP.Example.COM/')).toBe('app.example.com');
    expect(httpHostOf('http://[::1]:3000/')).toBe('[::1]');
  });

  it('returns null for other schemes and for what is not a URL', () => {
    expect(httpHostOf('file:///C:/page.html')).toBeNull();
    expect(httpHostOf('chrome://extensions/')).toBeNull();
    expect(httpHostOf('chrome-extension://abc/popup/popup.html')).toBeNull();
    expect(httpHostOf('about:blank')).toBeNull();
    expect(httpHostOf('not a url')).toBeNull();
    expect(httpHostOf('')).toBeNull();
    expect(httpHostOf(undefined)).toBeNull();
    expect(httpHostOf(null)).toBeNull();
  });
});

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
