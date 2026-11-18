const TYPES = ['cookies', 'localStorage', 'sessionStorage', 'indexedDB'];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Expiry and flags are rewritten by the server on every response, so only what
// identifies a cookie and its value decides whether the session changed.
function normalizeCookies(cookies) {
  return cookies
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))
    .sort((a, b) => `${a.domain}|${a.path}|${a.name}`.localeCompare(`${b.domain}|${b.path}|${b.name}`));
}

/**
 * Whether the current data differs from a snapshot. A type is compared only when
 * it is enabled and present on both sides: a type the snapshot never stored, or
 * one that could not be read now (no host permission, no content script), says
 * nothing about a change.
 */
export function hasChanges(snapshot, current, enabledTypes) {
  return TYPES.some(type => {
    if (!enabledTypes[type] || snapshot[type] == null || current[type] == null) return false;
    const [a, b] = type === 'cookies'
      ? [normalizeCookies(snapshot[type]), normalizeCookies(current[type])]
      : [snapshot[type], current[type]];
    return stableStringify(a) !== stableStringify(b);
  });
}
