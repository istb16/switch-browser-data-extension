function cookieUrl(cookie) {
  const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
}

// Snapshots can come from import files, so each cookie is checked before its
// domain and path are used to build a URL.
export function cookiesWithin(cookies, domain) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter(cookie => {
    if (!cookie || typeof cookie !== 'object') return false;
    const { name, value, domain: cookieDomain, path } = cookie;
    if (![name, value, cookieDomain, path].every(field => typeof field === 'string')) return false;
    if (!path.startsWith('/')) return false;
    const host = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    return host === domain || host.endsWith(`.${domain}`);
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

export async function setCookiesForDomain(domain, cookies) {
  const existing = await chrome.cookies.getAll({ domain });
  for (const cookie of existing) {
    await chrome.cookies.remove({ url: cookieUrl(cookie), name: cookie.name }).catch(() => {});
  }

  for (const cookie of cookiesWithin(cookies, domain)) {
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
