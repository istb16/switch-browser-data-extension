const MESSAGES = {
  ja: {
    // popup — header
    loading:               '読み込み中...',
    unavailable:           'このページでは使用できません',
    domain_label:          'ドメイン',
    btn_settings:          '設定',
    // popup — snapshot section
    snapshot_label:        'スナップショット',
    snapshot_placeholder:  '-- 選択してください --',
    saved_at:              '保存日時: {date}',
    // popup — action buttons
    btn_load:              '読み込み',
    btn_save:              '保存',
    btn_delete:            '削除',
    // popup — save panel
    save_panel_title:      '保存先を選択',
    save_mode_new:         '新規作成',
    save_mode_overwrite:   '上書き',
    new_name_placeholder:  'スナップショット名',
    overwrite_placeholder: '-- 上書き先を選択 --',
    btn_cancel:            'キャンセル',
    btn_ok:                'OK',
    btn_confirm_save:      '保存する',
    // popup — status / confirm
    error_enter_name:        'スナップショット名を入力してください',
    error_select_overwrite:  '上書き先を選択してください',
    error_save_failed:       '保存に失敗しました',
    error_load_failed:       '読み込みに失敗しました',
    confirm_load:            '"{name}" のデータを現在のページに適用しますか？\n現在のデータは上書きされます。',
    confirm_delete_snapshot: '"{name}" を削除しますか？',
    status_saved:            '"{name}" を保存しました',
    status_loaded:           '"{name}" を適用しました',
    status_deleted:          '"{name}" を削除しました',
    // options — headings
    options_title:            '設定',
    section_language:         '言語',
    section_data_types:       '保存するデータ種別',
    section_snapshots:        '保存済みスナップショット',
    section_data_management:  'データ管理',
    hint_snapshots:           'ポップアップは現在のタブのドメインを自動検出します。ここでは保存済みデータの確認と削除ができます。',
    // options — language selector
    lang_auto: 'ブラウザに合わせる',
    lang_ja:   '日本語',
    lang_en:   'English',
    // options — buttons
    btn_save_settings: '設定を保存',
    btn_export:        '全データをエクスポート',
    btn_import:        'データをインポート',
    btn_clear_all:     '全データを削除',
    btn_delete_title:  '削除',
    // options — domain list
    empty_snapshots: '保存済みデータはありません',
    count_format:    '{n} 件',
    // options — status / confirm
    status_settings_saved:   '設定を保存しました',
    status_exported:         'エクスポートしました',
    status_imported:         'インポートしました',
    error_import_failed:     'インポートに失敗しました。ファイル形式を確認してください',
    confirm_clear_all:       '全てのスナップショットデータを削除しますか？\nこの操作は元に戻せません。',
    status_cleared:          '全データを削除しました',
    status_snapshot_deleted: '"{name}" を削除しました',
  },
  en: {
    // popup — header
    loading:               'Loading...',
    unavailable:           'Not available on this page',
    domain_label:          'Domain',
    btn_settings:          'Settings',
    // popup — snapshot section
    snapshot_label:        'Snapshot',
    snapshot_placeholder:  '-- Select --',
    saved_at:              'Saved: {date}',
    // popup — action buttons
    btn_load:              'Load',
    btn_save:              'Save',
    btn_delete:            'Delete',
    // popup — save panel
    save_panel_title:      'Choose destination',
    save_mode_new:         'New',
    save_mode_overwrite:   'Overwrite',
    new_name_placeholder:  'Snapshot name',
    overwrite_placeholder: '-- Select to overwrite --',
    btn_cancel:            'Cancel',
    btn_ok:                'OK',
    btn_confirm_save:      'Save',
    // popup — status / confirm
    error_enter_name:        'Please enter a snapshot name',
    error_select_overwrite:  'Please select a snapshot to overwrite',
    error_save_failed:       'Failed to save',
    error_load_failed:       'Failed to load',
    confirm_load:            'Apply "{name}" to the current page?\nCurrent data will be overwritten.',
    confirm_delete_snapshot: 'Delete "{name}"?',
    status_saved:            'Saved "{name}"',
    status_loaded:           'Applied "{name}"',
    status_deleted:          'Deleted "{name}"',
    // options — headings
    options_title:            'Settings',
    section_language:         'Language',
    section_data_types:       'Data types to save',
    section_snapshots:        'Saved snapshots',
    section_data_management:  'Data management',
    hint_snapshots:           'The popup auto-detects the active tab\'s domain. Here you can view and delete saved snapshots.',
    // options — language selector
    lang_auto: 'Follow browser',
    lang_ja:   '日本語',
    lang_en:   'English',
    // options — buttons
    btn_save_settings: 'Save settings',
    btn_export:        'Export all data',
    btn_import:        'Import data',
    btn_clear_all:     'Delete all data',
    btn_delete_title:  'Delete',
    // options — domain list
    empty_snapshots: 'No saved data',
    count_format:    '{n}',
    // options — status / confirm
    status_settings_saved:   'Settings saved',
    status_exported:         'Exported successfully',
    status_imported:         'Imported successfully',
    error_import_failed:     'Import failed. Please check the file format.',
    confirm_clear_all:       'Delete all snapshot data?\nThis action cannot be undone.',
    status_cleared:          'All data deleted',
    status_snapshot_deleted: 'Deleted "{name}"',
  },
};

let _lang = 'ja';

async function detectLang() {
  const { language } = await chrome.storage.local.get('language');
  if (language && language !== 'auto') return language;
  const ui = chrome.i18n.getUILanguage() ?? 'en';
  return ui.startsWith('ja') ? 'ja' : 'en';
}

export async function initI18n() {
  _lang = await detectLang();
}

export async function setLanguage(lang) {
  await chrome.storage.local.set({ language: lang });
  _lang = lang === 'auto' ? await detectLang() : lang;
}

export async function getSavedLangSetting() {
  const { language } = await chrome.storage.local.get('language');
  return language ?? 'auto';
}

export function t(key, vars = {}) {
  let msg = MESSAGES[_lang]?.[key] ?? MESSAGES.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    msg = msg.replaceAll(`{${k}}`, String(v));
  }
  return msg;
}

export function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-option]').forEach(el => {
    el.textContent = t(el.dataset.i18nOption);
  });
}
