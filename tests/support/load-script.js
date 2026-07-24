import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../');

// `lib/web-storage-handlers.js`, `lib/indexeddb-handler.js` and
// `content/content-script.js` are non-module content scripts: they declare
// `var` globals instead of using import/export, because Chrome injects them
// into the same execution world without a bundler. Importing them as ESM
// would leave those `var`s scoped to the module and inaccessible here, so
// instead we read the source and run it inside a `Function` whose parameter
// names double as the globals the script expects.
export function loadGlobalScript(relativePath, globals, exportNames) {
  const filePath = path.join(repoRoot, relativePath);
  const code = readFileSync(filePath, 'utf-8');
  const paramNames = Object.keys(globals);
  const paramValues = Object.values(globals);
  const factory = new Function(...paramNames, `${code}\nreturn { ${exportNames.join(', ')} };`);
  return factory(...paramValues);
}
