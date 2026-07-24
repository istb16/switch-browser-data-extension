import { describe, it, expect, beforeEach } from 'vitest';
import { initI18n, t, applyI18n, setLanguage, getSavedLangSetting } from '../../lib/i18n.js';

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

  it('substitutes the same placeholder repeated multiple times', async () => {
    await setLanguage('ja');
    expect(t('count_format', { n: 3 })).toBe('3 件');
  });

  it('falls back to English text, then the raw key, for unknown-language / unknown-key lookups', async () => {
    await setLanguage('ja');
    expect(t('does_not_exist')).toBe('does_not_exist');
  });

  it('applyI18n fills in data-i18n, data-i18n-placeholder, data-i18n-title and data-i18n-option', async () => {
    await setLanguage('ja');
    document.body.innerHTML = `
      <span data-i18n="btn_cancel"></span>
      <input data-i18n-placeholder="new_name_placeholder">
      <button data-i18n-title="btn_settings"></button>
      <option data-i18n-option="lang_ja"></option>
    `;

    applyI18n();

    expect(document.querySelector('span').textContent).toBe('キャンセル');
    expect(document.querySelector('input').placeholder).toBe('スナップショット名');
    expect(document.querySelector('button').title).toBe('設定');
    expect(document.querySelector('option').textContent).toBe('日本語');
  });
});
