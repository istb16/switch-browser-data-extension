import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initI18n, t, applyI18n, setLanguage, getSavedLangSetting, MESSAGES } from '../../lib/i18n.js';

describe('lib/i18n', () => {
  beforeEach(async () => {
    // i18n.js keeps its current language in module-level state, so every
    // test must re-detect it explicitly instead of relying on import order.
    await initI18n();
  });

  it('defaults to Japanese when no language is saved and the browser UI is Japanese', async () => {
    chrome._state.uiLanguage = 'ja-JP';
    await initI18n();
    expect(t('btn_cancel')).toBe('キャンセル');
  });

  it('falls back to English when the browser UI is not Japanese', async () => {
    chrome._state.uiLanguage = 'en-US';
    await initI18n();
    expect(t('btn_cancel')).toBe('Cancel');
  });

  it('setLanguage persists the choice and getSavedLangSetting reflects it', async () => {
    await setLanguage('en');
    expect(t('btn_cancel')).toBe('Cancel');
    expect(await getSavedLangSetting()).toBe('en');
  });

  it('getSavedLangSetting defaults to "auto" when nothing is saved', async () => {
    expect(await getSavedLangSetting()).toBe('auto');
  });

  it('setLanguage("auto") re-detects from the browser UI language', async () => {
    chrome._state.uiLanguage = 'en-US';
    await setLanguage('auto');
    expect(t('btn_cancel')).toBe('Cancel');
  });

  it('substitutes {placeholder} variables', async () => {
    await setLanguage('ja');
    expect(t('saved_at', { date: '2024-01-01' })).toBe('保存日時: 2024-01-01');
  });

  it('falls back to English text, then the raw key, for unknown-language / unknown-key lookups', async () => {
    await setLanguage('ja');
    expect(t('does_not_exist')).toBe('does_not_exist');
  });

  it('ja and en have the same keys', () => {
    expect(Object.keys(MESSAGES.ja).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it('applyI18n fills in data-i18n, data-i18n-placeholder and data-i18n-title', async () => {
    await setLanguage('ja');
    document.body.innerHTML = `
      <span data-i18n="btn_cancel"></span>
      <input data-i18n-placeholder="new_name_placeholder">
      <button data-i18n-title="btn_settings"></button>
    `;

    applyI18n();

    expect(document.querySelector('span').textContent).toBe('キャンセル');
    expect(document.querySelector('input').placeholder).toBe('スナップショット名');
    expect(document.querySelector('button').title).toBe('設定');
  });

  it('select options are translated through data-i18n', async () => {
    document.body.innerHTML = `
      <select><option value="name" data-i18n="sort_name"></option><option value="size" data-i18n="sort_size"></option></select>
    `;

    await setLanguage('ja');
    applyI18n();
    const texts = () => [...document.querySelectorAll('option')].map(o => o.textContent);
    expect(texts()).toEqual(['名前', '大きい順']);

    await setLanguage('en');
    applyI18n();
    expect(texts()).toEqual(['Name', 'Largest first']);

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
    for (const file of ['options/options.html', 'popup/popup.html']) {
      expect(readFileSync(path.join(repoRoot, file), 'utf-8')).not.toContain('data-i18n-option');
    }
  });
});
