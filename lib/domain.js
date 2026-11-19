export function isWithin(host, base) {
  return host === base || host.endsWith(`.${base}`);
}

// `target` is a domain, which takes in its subdomains too, or { domain, exact }
// where exact: true keeps only the host's own cookies (`host` and `.host`), which
// is all the host permission of that host alone can capture.
export function toCookieScope(target) {
  return typeof target === 'string'
    ? { domain: target, exact: false }
    : { domain: target.domain, exact: Boolean(target.exact) };
}
