// content script — no ES module syntax
// Exposes the storageDigest global. The content script and the popup both load
// this file, so a digest computed in the page and one computed from a saved
// snapshot come from the same code.

var storageDigest = (function () {
  // A 53-bit non-cryptographic hash (cyrb53), fed incrementally so a large
  // database is never turned into one huge string. crypto.subtle is not used:
  // it is missing on http pages, where content scripts also run.
  function createHasher() {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    return {
      update(str) {
        for (let i = 0; i < str.length; i++) {
          const ch = str.charCodeAt(i);
          h1 = Math.imul(h1 ^ ch, 2654435761);
          h2 = Math.imul(h2 ^ ch, 1597334677);
        }
      },
      digest() {
        let a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        let b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        a >>>= 0;
        b >>>= 0;
        return (b & 0x1fffff).toString(16).padStart(6, '0') + a.toString(16).padStart(8, '0');
      },
    };
  }

  // Object keys are visited in sorted order, so the same data hashes the same
  // whatever order its keys were written in.
  function feed(hasher, value) {
    if (Array.isArray(value)) {
      hasher.update('[');
      for (const item of value) {
        feed(hasher, item);
        hasher.update(',');
      }
      hasher.update(']');
    } else if (value && typeof value === 'object') {
      hasher.update('{');
      for (const key of Object.keys(value).sort()) {
        hasher.update(JSON.stringify(key));
        hasher.update(':');
        feed(hasher, value[key]);
        hasher.update(',');
      }
      hasher.update('}');
    } else {
      hasher.update(String(JSON.stringify(value)));
    }
  }

  return {
    // The value must already be in the form extension messaging delivers
    // (JSON-compatible), because that is the form a saved snapshot is in.
    digest(value) {
      const hasher = createHasher();
      feed(hasher, value);
      return hasher.digest();
    },
  };
})();
