import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const readJson = file => JSON.parse(readFileSync(path.join(repoRoot, file), 'utf-8'));

describe('manifest', () => {
  const manifest = readJson('manifest.json');

  it('declares switch-previous without a suggested key', () => {
    const command = manifest.commands['switch-previous'];
    expect(command).toBeDefined();
    expect(command).not.toHaveProperty('suggested_key');
    expect(command.description).toBe('__MSG_command_switch_previous__');
  });

  it.each(['ja', 'en'])('the command description is translated in _locales/%s', lang => {
    const key = manifest.commands['switch-previous'].description.match(/^__MSG_(\w+)__$/)[1];
    expect(readJson(`_locales/${lang}/messages.json`)[key]?.message).toEqual(expect.any(String));
  });

  it('keeps the popup shortcut', () => {
    expect(manifest.commands._execute_action.suggested_key.default).toBe('Alt+Shift+S');
  });
});
