import { describe, it, expect } from 'vitest';
import { isWithin, toCookieScope, httpHostOf, parseHttpUrl, isScopeWithin } from '../../lib/domain.js';

describe('lib/domain parseHttpUrl', () => {
  it('parseHttpUrl returns the URL for http(s) and null otherwise', () => {
    expect(parseHttpUrl('https://example.com:8443/a?b#c')).toMatchObject({
      protocol: 'https:', hostname: 'example.com', origin: 'https://example.com:8443',
    });
    expect(parseHttpUrl('http://a.com/')?.origin).toBe('http://a.com');
    for (const url of ['file:///a', 'chrome://extensions/', 'chrome-extension://abc/x.html', 'about:blank', '', undefined, 'not a url']) {
      expect(parseHttpUrl(url)).toBeNull();
    }
  });
});

describe('lib/domain isScopeWithin', () => {
  const exact = domain => ({ domain, exact: true });
  const wide = domain => ({ domain, exact: false });

  it('isScopeWithin: exact scopes', () => {
    expect(isScopeWithin(exact('a.example.com'), exact('a.example.com'))).toBe(true);
    expect(isScopeWithin(exact('a.example.com'), exact('b.example.com'))).toBe(false);
    expect(isScopeWithin(exact('a.example.com'), exact('example.com'))).toBe(false);
  });

  it('isScopeWithin: wide scopes', () => {
    expect(isScopeWithin(wide('example.com'), wide('example.com'))).toBe(true);
    expect(isScopeWithin(wide('app.example.com'), wide('example.com'))).toBe(true);
    expect(isScopeWithin(wide('example.com'), wide('app.example.com'))).toBe(false);
    expect(isScopeWithin(wide('example.com'), wide('other.com'))).toBe(false);
    expect(isScopeWithin(wide('notexample.com'), wide('example.com'))).toBe(false);
  });

  it('isScopeWithin: mixed', () => {
    expect(isScopeWithin(exact('app.example.com'), wide('example.com'))).toBe(true);
    expect(isScopeWithin(exact('example.com'), wide('example.com'))).toBe(true);
    expect(isScopeWithin(exact('other.com'), wide('example.com'))).toBe(false);
    expect(isScopeWithin(wide('example.com'), exact('example.com'))).toBe(false);
    expect(isScopeWithin(wide('app.example.com'), exact('example.com'))).toBe(false);
  });

  it('isScopeWithin reads a scope without exact as wide and returns a boolean', () => {
    expect(isScopeWithin({ domain: 'example.com' }, exact('example.com'))).toBe(false);
    expect(isScopeWithin({ domain: 'example.com' }, wide('example.com'))).toBe(true);
    expect(isScopeWithin(exact('app.example.com'), { domain: 'example.com' })).toBe(true);
  });
});

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
