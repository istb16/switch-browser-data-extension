function cookieUrl(cookie) {
  const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
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

  for (const cookie of cookies) {
    const details = {
      url:      cookieUrl(cookie),
      name:     cookie.name,
      value:    cookie.value,
      path:     cookie.path,
      secure:   cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
    };
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    await chrome.cookies.set(details).catch(e => console.warn('cookie set failed:', cookie.name, e));
  }
}
