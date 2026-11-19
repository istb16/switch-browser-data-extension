export const MESSAGES = {
  ja: {
    // popup — header
    loading:               '読み込み中...',
    unavailable:           'このページでは使用できません',
    domain_label:          'ドメイン',
    btn_settings:          '設定',
    // popup — snapshot section
    snapshot_label:        'スナップショット',
    saved_at:              '保存日時: {date}',
    // popup — action buttons
    btn_save:              '保存',
    // popup — save panel
    new_name_placeholder:  'スナップショット名',
    btn_cancel:            'キャンセル',
    btn_ok:                'OK',
    // popup — host permission
    permission_title:      'このサイトへのアクセスを許可してください',
    permission_body:       'Cookie を保存・切り替えるには、このサイトの Cookie を読み書きする許可が要ります。',
    permission_note:       '許可すると、この画面はいったん閉じます。許可したあとで、もう一度拡張機能のアイコンから開いてください。',
    btn_grant_permission:  'アクセスを許可',
    permission_denied:     '許可されませんでした。もう一度「アクセスを許可」を押すか、Cookie を使わない場合は設定でオフにしてください。',
    btn_skip_cookies:      'Cookie を使わない（設定を開く）',
    // popup — list
    search_label:          'スナップショットを検索',
    search_placeholder:    '名前・メモで絞り込み',
    empty_title:           'まだスナップショットはありません',
    empty_body:            '今のログイン状態などを保存すると、ここからワンクリックで切り替えられます。',
    no_match:              '一致するスナップショットはありません',
    badge_active:          '適用中',
    badge_modified:        '変更あり',
    modified_detail:       '前回の読み込み・保存から変わったもの: {items}',
    btn_more:              '"{name}" の操作',
    menu_overwrite:        '現在の状態で上書き',
    menu_rename:           '名前を変更',
    menu_ignore_cookie:    'Cookie「{name}」の変化を無視',
    status_cookie_ignored: 'Cookie「{name}」の変化を今後は比べません',
    menu_delete:           '削除',
    rename_label:          '新しい名前',
    btn_save_current:      '現在の状態を保存',
    undo_text:             '直前の状態 · {time}',
    btn_undo:              '戻す',
    confirm_overwrite:     '"{name}" を現在の状態で上書きしますか？',
    status_restored:       '直前の状態に戻しました',
    error_restore_failed:  '元に戻せませんでした',
    // popup — status / confirm
    error_enter_name:        'スナップショット名を入力してください',
    error_save_failed:       '保存に失敗しました',
    error_load_failed:       '読み込みに失敗しました',
    confirm_load:            '"{name}" のデータを現在のページに適用しますか？\n現在のデータは上書きされます。',
    confirm_delete_snapshot: '"{name}" を削除しますか？',
    status_saved:            '"{name}" を保存しました',
    status_loaded:           '"{name}" を適用しました',
    status_loaded_no_backup: '"{name}" を適用しました（保存容量が足りず、切り替え前の状態は残せませんでした）',
    btn_clear_site:                'このサイトのデータを消去',
    confirm_clear_site:            '"{domain}" の {types} を消去しますか？\n消去したデータは元に戻せません。',
    confirm_clear_site_undoable:   '"{domain}" の {types} を消去しますか？\n消去する前の状態は「戻す」で元に戻せます。',
    status_site_cleared:           '"{domain}" のデータを消去しました',
    status_site_cleared_no_backup: '"{domain}" のデータを消去しました（保存容量が足りず、消去前の状態は残せませんでした）',
    error_clear_site_failed:       'データを消去できませんでした。ページを再読み込みしてから、もう一度試してください',
    status_site_cleared_reload_needed: '"{domain}" のデータを消去しました。IndexedDB はページが使用中のため、ページを再読み込みすると消えます',
    status_deleted:          '"{name}" を削除しました',
    // popup — memo and colour
    memo_label:              'メモ（任意）',
    color_label:             '色',
    color_none:              'なし',
    color_red:               '赤',
    color_amber:             '橙',
    color_green:             '緑',
    color_blue:              '青',
    chip_label:              '色: {color}',
    menu_edit_details:       'メモと色を編集',
    edit_details_title:      '"{name}" のメモと色',
    status_details_saved:    '"{name}" のメモと色を保存しました',
    error_details_failed:    'メモと色を保存できませんでした',
    preview_title:           '保存した内容: {items}（{size}）',
    preview_size:            '大きさ: {size}',
    warning_expired_cookies: '期限切れの Cookie が {n} 件あります。保存したときのログインはもう切れているかもしれません',
    // options — headings
    options_title:            '設定',
    section_language:         '言語',
    section_behavior:         '動作',
    toggle_auto_backup:       '読み込む前に今の状態を自動で残す',
    toggle_auto_reload:       '読み込んだ後にページを再読み込みする',
    toggle_show_badge:        'アイコンに適用中のスナップショットを表示する',
    section_data_types:       '保存するデータ種別',
    section_snapshots:        '保存済みスナップショット',
    section_data_management:  'データ管理',
    hint_snapshots:           'ポップアップは現在のタブのドメインを自動検出します。ここでは保存済みデータの確認と削除ができます。',
    // options — navigation
    nav_label:                '設定の項目',
    nav_general:              '全般',
    nav_data_types:           'データ種別',
    nav_snapshots:            'スナップショット',
    nav_data:                 'データ管理',
    // options — storage meter
    section_storage_usage:    '使用量',
    meter_total:              '合計',
    meter_label:              '使用量の内訳（合計 {size}）',
    meter_backups:            '切り替え前の状態',
    meter_other:              'その他',
    meter_advisory:           'データが大きいとポップアップの表示が遅くなります。大きいものから見直してください。',
    // options — sort
    sort_label:               '並び順',
    sort_name:                '名前',
    sort_size:                '大きい順',
    // options — language selector
    lang_auto: 'ブラウザに合わせる',
    lang_ja:   '日本語',
    lang_en:   'English',
    // options — buttons
    btn_export:        '全データをエクスポート',
    btn_import:        'データをインポート',
    btn_clear_all:     '全データを削除',
    btn_delete_title: '削除',
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
    status_snapshot_renamed: '"{old}" を "{new}" に変更しました',
    error_duplicate_name:    '"{name}" はすでに存在します',
    error_empty_name:        'スナップショット名を入力してください',
    // options — footer
    footer_version:          'バージョン: {version}',
  },
  en: {
    // popup — header
    loading:               'Loading...',
    unavailable:           'Not available on this page',
    domain_label:          'Domain',
    btn_settings:          'Settings',
    // popup — snapshot section
    snapshot_label:        'Snapshot',
    saved_at:              'Saved: {date}',
    // popup — action buttons
    btn_save:              'Save',
    // popup — save panel
    new_name_placeholder:  'Snapshot name',
    btn_cancel:            'Cancel',
    btn_ok:                'OK',
    // popup — host permission
    permission_title:      'Allow access to this site',
    permission_body:       'Saving and switching cookies needs permission to read and write this site\'s cookies.',
    permission_note:       'Allowing closes this popup. Open it again from the extension icon afterwards.',
    btn_grant_permission:  'Allow access',
    permission_denied:     'Access wasn\'t allowed. Select "Allow access" again, or turn cookies off in settings if you don\'t need them.',
    btn_skip_cookies:      'Don\'t use cookies (open settings)',
    // popup — list
    search_label:          'Search snapshots',
    search_placeholder:    'Filter by name or memo',
    empty_title:           'No snapshots yet',
    empty_body:            'Save the current state, such as your sign-in, to switch back to it here in one click.',
    no_match:              'No matching snapshots',
    badge_active:          'Active',
    badge_modified:        'Changed',
    modified_detail:       'Changed since the last load or save: {items}',
    btn_more:              'Actions for "{name}"',
    menu_overwrite:        'Overwrite with current state',
    menu_rename:           'Rename',
    menu_ignore_cookie:    'Ignore changes to cookie "{name}"',
    status_cookie_ignored: 'Changes to cookie "{name}" will no longer be compared',
    menu_delete:           'Delete',
    rename_label:          'New name',
    btn_save_current:      'Save current state',
    undo_text:             'Previous state · {time}',
    btn_undo:              'Restore',
    confirm_overwrite:     'Overwrite "{name}" with the current state?',
    status_restored:       'Restored the previous state',
    error_restore_failed:  "Couldn't restore",
    // popup — status / confirm
    error_enter_name:        'Please enter a snapshot name',
    error_save_failed:       'Failed to save',
    error_load_failed:       'Failed to load',
    confirm_load:            'Apply "{name}" to the current page?\nCurrent data will be overwritten.',
    confirm_delete_snapshot: 'Delete "{name}"?',
    status_saved:            'Saved "{name}"',
    status_loaded:           'Applied "{name}"',
    status_loaded_no_backup: 'Applied "{name}" (not enough storage to keep the state before switching)',
    btn_clear_site:                'Clear this site\'s data',
    confirm_clear_site:            'Clear {types} for "{domain}"?\nThis can\'t be undone.',
    confirm_clear_site_undoable:   'Clear {types} for "{domain}"?\nYou can bring the current state back with Restore.',
    status_site_cleared:           'Cleared the data for "{domain}"',
    status_site_cleared_no_backup: 'Cleared the data for "{domain}" (not enough storage to keep the state before clearing)',
    error_clear_site_failed:       'Couldn\'t clear the data. Reload the page and try again.',
    status_site_cleared_reload_needed: 'Cleared the data for "{domain}". The page is still using IndexedDB, which goes away when you reload the page.',
    status_deleted:          'Deleted "{name}"',
    // popup — memo and colour
    memo_label:              'Memo (optional)',
    color_label:             'Color',
    color_none:              'None',
    color_red:               'Red',
    color_amber:             'Amber',
    color_green:             'Green',
    color_blue:              'Blue',
    chip_label:              'Color: {color}',
    menu_edit_details:       'Edit memo and color',
    edit_details_title:      'Memo and color for "{name}"',
    status_details_saved:    'Saved the memo and color for "{name}"',
    error_details_failed:    "Couldn't save the memo and color",
    preview_title:           'Saved data: {items} ({size})',
    preview_size:            'Size: {size}',
    warning_expired_cookies: '{n} saved cookie(s) have expired. The sign-in saved here may have ended.',
    // options — headings
    options_title:            'Settings',
    section_language:         'Language',
    section_behavior:         'Behavior',
    toggle_auto_backup:       'Back up the current state before loading',
    toggle_auto_reload:       'Reload the page after loading',
    toggle_show_badge:        'Show the active snapshot on the toolbar icon',
    section_data_types:       'Data types to save',
    section_snapshots:        'Saved snapshots',
    section_data_management:  'Data management',
    hint_snapshots:           'The popup auto-detects the active tab\'s domain. Here you can view and delete saved snapshots.',
    // options — navigation
    nav_label:                'Settings sections',
    nav_general:              'General',
    nav_data_types:           'Data types',
    nav_snapshots:            'Snapshots',
    nav_data:                 'Data management',
    // options — storage meter
    section_storage_usage:    'Storage used',
    meter_total:              'Total',
    meter_label:              'Storage breakdown (total {size})',
    meter_backups:            'States before switching',
    meter_other:              'Other',
    meter_advisory:           'Large data makes the popup slower to open. Start with the largest items.',
    // options — sort
    sort_label:               'Sort by',
    sort_name:                'Name',
    sort_size:                'Largest first',
    // options — language selector
    lang_auto: 'Follow browser',
    lang_ja:   '日本語',
    lang_en:   'English',
    // options — buttons
    btn_export:        'Export all data',
    btn_import:        'Import data',
    btn_clear_all:     'Delete all data',
    btn_delete_title: 'Delete',
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
    status_snapshot_renamed: 'Renamed "{old}" to "{new}"',
    error_duplicate_name:    '"{name}" already exists',
    error_empty_name:        'Please enter a snapshot name',
    // options — footer
    footer_version:          'Version: {version}',
  },
};

let _lang = 'ja';

async function detectLang() {
  const { language } = await chrome.storage.local.get('language');
  if (language && language !== 'auto') return language;
  const ui = chrome.i18n.getUILanguage() ?? 'en';
  return ui.startsWith('ja') ? 'ja' : 'en';
}

export function getLang() {
  return _lang;
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
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-option]').forEach(el => {
    el.textContent = t(el.dataset.i18nOption);
  });
}
