import { toCookieScope } from './domain.js';

// A cookie domain as Chrome reports it: a hostname, optionally with a leading dot,
// or a bracketed IPv6 address. Anything else (a '#', '/', '@' or a bare ':' from a
// crafted import) could make the URL built from it point at another host.
const COOKIE_DOMAIN = /^(\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/i;

export function cookieHostOf(cookieDomain) {
  return cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
}

function cookieUrl(cookie) {
  return `http${cookie.secure ? 's' : ''}://${cookieHostOf(cookie.domain)}${cookie.path}`;
}

function urlPointsAt(url, host) {
  try {
    return new URL(url).hostname === host.toLowerCase();
  } catch {
    return false;
  }
}

export function hostMatches(host, { domain, exact }) {
  return host === domain || (!exact && host.endsWith(`.${domain}`));
}

// Snapshots can come from import files, so each cookie is checked before its
// domain and path are used to build a URL.
export function cookiesWithin(cookies, target) {
  if (!Array.isArray(cookies)) return [];
  const scope = toCookieScope(target);
  return cookies.filter(cookie => {
    if (!cookie || typeof cookie !== 'object') return false;
    const { name, value, domain: cookieDomain, path } = cookie;
    if (![name, value, cookieDomain, path].every(field => typeof field === 'string')) return false;
    if (!path.startsWith('/') || !COOKIE_DOMAIN.test(cookieDomain)) return false;
    const host = cookieHostOf(cookieDomain);
    return hostMatches(host, scope) && urlPointsAt(cookieUrl(cookie), host);
  });
}

export async function getCookiesForDomain(domain) {
  const cookies = await chrome.cookies.getAll({ domain });
  return cookies.map(c => ({
    name:           c.name,
    value:          c.value,
    domain:         c.domain,
    path:           c.path,
    secure:         c.secure,
    httpOnly:       c.httpOnly,
    sameSite:       c.sameSite,
    expirationDate: c.expirationDate,
    storeId:        c.storeId,
  }));
}

export async function setCookiesForDomain(target, cookies) {
  const scope = toCookieScope(target);
  const existing = await chrome.cookies.getAll({ domain: scope.domain });
  // remove() deletes one cookie matching the URL and name, so a host-only and a
  // dot-domain cookie of the same name need two calls in turn: run at once, both
  // could pick the same cookie and leave the other.
  const sameTarget = new Map();
  for (const cookie of existing.filter(c => hostMatches(cookieHostOf(c.domain), scope))) {
    const details = { url: cookieUrl(cookie), name: cookie.name };
    const key = `${details.url}
${details.name}`;
    sameTarget.set(key, [...(sameTarget.get(key) ?? []), details]);
  }
  await Promise.all([...sameTarget.values()].map(async removals => {
    for (const details of removals) await chrome.cookies.remove(details).catch(() => {});
  }));

  for (const cookie of cookiesWithin(cookies, scope)) {
    const details = {
      url:      cookieUrl(cookie),
      name:     cookie.name,
      value:    cookie.value,
      path:     cookie.path,
      secure:   cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
    };
    // Without `domain` Chrome stores a host-only cookie, which would turn a
    // `.example.com` cookie into one that subdomains no longer receive.
    if (cookie.domain.startsWith('.')) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    await chrome.cookies.set(details).catch(e => console.warn('cookie set failed:', cookie.name, e));
  }
}
