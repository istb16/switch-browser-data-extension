// A cookie domain as Chrome reports it: a hostname, optionally with a leading dot,
// or a bracketed IPv6 address. Anything else (a '#', '/', '@' or a bare ':' from a
// crafted import) could make the URL built from it point at another host.
const COOKIE_DOMAIN = /^(\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/i;

function hostOf(cookieDomain) {
  return cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
}

function cookieUrl(cookie) {
  return `http${cookie.secure ? 's' : ''}://${hostOf(cookie.domain)}${cookie.path}`;
}

function urlPointsAt(url, host) {
  try {
    return new URL(url).hostname === host.toLowerCase();
  } catch {
    return false;
  }
}

// `target` is a domain, which takes in its subdomains too, or { domain, exact }
// where exact: true keeps only the host's own cookies (`host` and `.host`), which
// is all the host permission of that host alone can capture.
function normalizeTarget(target) {
  return typeof target === 'string' ? { domain: target, exact: false } : target;
}

function hostMatches(host, { domain, exact }) {
  return host === domain || (!exact && host.endsWith(`.${domain}`));
}

// Snapshots can come from import files, so each cookie is checked before its
// domain and path are used to build a URL.
export function cookiesWithin(cookies, target) {
  if (!Array.isArray(cookies)) return [];
  const scope = normalizeTarget(target);
  return cookies.filter(cookie => {
    if (!cookie || typeof cookie !== 'object') return false;
    const { name, value, domain: cookieDomain, path } = cookie;
    if (![name, value, cookieDomain, path].every(field => typeof field === 'string')) return false;
    if (!path.startsWith('/') || !COOKIE_DOMAIN.test(cookieDomain)) return false;
    const host = hostOf(cookieDomain);
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
  const scope = normalizeTarget(target);
  const existing = await chrome.cookies.getAll({ domain: scope.domain });
  for (const cookie of existing) {
    if (!hostMatches(hostOf(cookie.domain), scope)) continue;
    await chrome.cookies.remove({ url: cookieUrl(cookie), name: cookie.name }).catch(() => {});
  }

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
