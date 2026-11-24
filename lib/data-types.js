export const DATA_TYPES = ['cookies', 'localStorage', 'sessionStorage', 'indexedDB'];

// The types the content script reads and writes in the page.
export const PAGE_TYPES = ['localStorage', 'sessionStorage', 'indexedDB'];

export const TYPE_LABELS = { cookies: 'Cookie', localStorage: 'localStorage', sessionStorage: 'sessionStorage', indexedDB: 'IndexedDB' };

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
