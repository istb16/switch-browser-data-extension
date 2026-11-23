import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const read = file => readFileSync(path.join(repoRoot, file), 'utf-8');

function manifestFolders() {
  const folders = new Set();
  const visit = value => {
    if (typeof value === 'string') {
      if (/^[\w-]+\/[^<>]+\.\w+$/.test(value)) folders.add(value.split('/')[0]);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(JSON.parse(read('manifest.json')));
  return folders;
}

function pageFolders() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(dir => readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
      .some(file => file.isFile() && file.name.endsWith('.html') && read(path.join(dir, file.name)).includes('../lib/')));
}

const hasToken = (text, name) => new RegExp(`(^|[^\\w.-])${name}([^\\w.-]|$)`, 'm').test(text);

describe('packaging', () => {
  const expected = [...new Set([...manifestFolders(), '_locales', ...pageFolders()])];

  it('finds the runtime folders', () => {
    expect(expected).toEqual(expect.arrayContaining(['popup', 'options', 'lib', 'icons', 'content', 'background', '_locales', 'viewer']));
  });

  it('every runtime folder is in both build scripts and the E2E copy list', () => {
    const runtimeDirs = read('tests/e2e/fixtures.js').match(/RUNTIME_DIRS\s*=\s*\[[^\]]*\]/)?.[0];
    expect(runtimeDirs).toBeTruthy();
    const sources = {
      'deploy/build.sh': read('deploy/build.sh'),
      'deploy/build.ps1': read('deploy/build.ps1'),
      'tests/e2e/fixtures.js RUNTIME_DIRS': runtimeDirs,
    };
    const missing = Object.entries(sources).flatMap(([file, text]) =>
      expected.filter(name => !hasToken(text, name)).map(name => `${name} in ${file}`));
    expect(missing).toEqual([]);
  });
});
