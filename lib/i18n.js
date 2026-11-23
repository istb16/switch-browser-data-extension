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
    status_saved_partial:    '"{name}" の {types} を保存しました（読み込んだほかの種類はページから読み取れなかったので、保存したままです）',
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
    status_other_tabs_reloaded: '（ほかの {count} タブも再読み込み）',
    status_other_tab_reloaded: '（ほかの 1 タブも再読み込み）',
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
    // popup — subdomain groups
    group_chip:              'グループ: {group}',
    group_chip_title:        '{group} とそのサブドメインの Cookie をまとめて保存・切り替えます',
    permission_body_group:   'Cookie を保存・切り替えるには、{group} とそのサブドメインの Cookie を読み書きする許可が要ります。',
    row_host_title:          '{host} で保存したスナップショットです。このページでは Cookie だけを適用します',
    status_loaded_cookies_only:           '"{name}" の Cookie を適用しました（ページのデータは {host} のものなので適用していません）',
    status_loaded_cookies_only_no_backup: '"{name}" の Cookie を適用しました（ページのデータは {host} のものなので適用していません。保存容量が足りず、切り替え前の状態は残せませんでした）',
    scope_label_group:       '{host}（Cookie はグループ {group} 全体）',
    // popup — partial load
    menu_load_partial:       '一部だけ読み込む…',
    load_partial_title:      '"{name}" から読み込むもの',
    load_partial_no_undo:    '選んだ種類の今のデータは上書きされ、元に戻せません。',
    btn_load:                '読み込む',
    error_choose_type:       '読み込む種類を1つ以上選んでください',
    badge_active_partial:    '一部適用中',
    active_partial_title:    '読み込んだもの: {types}。ほかの種類は比べません',
    status_loaded_partial:           '"{name}" の {types} を適用しました',
    status_loaded_partial_no_backup: '"{name}" の {types} を適用しました（保存容量が足りず、切り替え前の状態は残せませんでした）',
    confirm_overwrite_partial: '"{name}" の {types} を現在の状態で上書きしますか？\nほかの種類は保存したまま残します。',
    error_overwrite_no_types:  '読み込んだ種類がどれも設定でオフになっているため、上書きできません',
    // options — headings
    options_title:            '設定',
    section_language:         '言語',
    section_behavior:         '動作',
    toggle_auto_backup:       '読み込む前に今の状態を自動で残す',
    toggle_auto_reload:       '読み込んだ後にページを再読み込みする',
    toggle_reload_other_tabs: '同じサイトのほかのタブも再読み込みする',
    hint_reload_other_tabs:   'ほかのタブで入力中の内容は失われます。タブごとの sessionStorage は切り替わらないので、そこにログイン情報を置くサイトでは、ほかのタブは元のアカウントのままです',
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
    // options — export / import / encryption
    toggle_encrypt_exports:        'エクスポートするファイルをパスフレーズで暗号化する',
    hint_export_sessions:          'エクスポートしたファイルにはログイン中のセッション（Cookie など）が含まれます。ファイルを渡した相手はそのアカウントにログインできます。',
    hint_passphrase_unrecoverable: 'パスフレーズを忘れると、暗号化したファイルは元に戻せません。',
    export_domain_title:           '"{domain}" をエクスポート',
    export_snapshot_title:         '"{name}" をエクスポート',
    passphrase_new_title:          'エクスポートを暗号化',
    passphrase_title:              '暗号化されたファイル',
    passphrase_label:              'パスフレーズ',
    passphrase_confirm_label:      'パスフレーズ（確認）',
    btn_export_confirm:            'エクスポート',
    btn_import_confirm:            'インポート',
    error_passphrase_short:        'パスフレーズは {n} 文字以上にしてください',
    error_passphrase_mismatch:     '2つのパスフレーズが一致しません',
    error_dialog_check_failed:     '入力を確かめられませんでした。もう一度お試しください',
    error_enter_passphrase:        'パスフレーズを入力してください',
    error_wrong_passphrase:        'パスフレーズが違います。何もインポートしていません',
    error_import_too_large:        'ファイルが大きすぎます（上限 {size}）。何もインポートしていません',
    error_export_failed:           'エクスポートに失敗しました',
    confirm_import_conflicts:      '同じ名前のスナップショットが {n} 件あります:\n{names}\nどうしますか？',
    choice_overwrite:              '上書きする',
    choice_skip:                   'スキップする',
    choice_keep_both:              '両方残す（別名で追加）',
    // options — subdomain groups
    section_groups:          'サブドメインのグループ',
    hint_groups:             'ドメインを登録すると、そのドメインとサブドメインの Cookie をまとめて保存・切り替えます。各サブドメインのスナップショットは、グループ内のどのサイトのポップアップにも表示されます。',
    group_input_label:       'グループにするドメイン',
    btn_add_group:           '追加',
    empty_groups:            'グループはありません',
    btn_remove_group_title:  'グループ "{group}" を削除',
    confirm_add_group:       '{group} と *.{group} をひとつのグループにします。\nこの範囲の Cookie はすべて、まとめて保存・削除・復元されます。\n\n無関係なサイトが共有するドメイン（ホスティングサービスのドメインなど）には使わないでください。別のサイトの Cookie まで消したり書き換えたりします。',
    confirm_remove_group:    'グループ "{group}" を削除しますか？\n保存済みのスナップショットはそのまま残ります。',
    status_group_added:      'グループ "{group}" を追加しました',
    status_group_added_no_permission: 'グループ "{group}" を追加しました。Cookie を読み書きする許可は、ポップアップを開いたときにもう一度求めます',
    status_group_removed:    'グループ "{group}" を削除しました',
    error_group_failed:      'グループを変更できませんでした',
    error_group_invalid:     'ドメインの形式が正しくありません（例: example.com）',
    error_group_ip:          'IP アドレスはグループにできません',
    error_group_single_label: 'ドット（.）を含むドメインを入力してください',
    error_group_registry:    '"{group}" は多くのサイトが共有する区分なのでグループにできません',
    error_group_shared:      '"{group}" は無関係なサイトが共有するホスティングのドメインなのでグループにできません',
    error_group_duplicate:   '"{group}" はすでにグループです',
    error_group_nested:      '"{group}" は既存のグループと重なります',
    // options — domain list
    empty_snapshots: '保存済みデータはありません',
    count_format:    '{n} 件',
    // options — status / confirm
    status_settings_saved:   '設定を保存しました',
    status_exported:         '暗号化してエクスポートしました',
    status_exported_plain:   'エクスポートしました。ファイルにはログイン中のセッションが含まれます。「データ管理」で暗号化をオンにできます',
    status_imported:         'インポートしました（追加 {added} 件・上書き {overwritten} 件・別名で追加 {renamed} 件・スキップ {skipped} 件）',
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
    status_saved_partial:    'Saved {types} of "{name}" (the other loaded types could not be read from the page and stay as saved)',
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
    status_other_tabs_reloaded: ' (also reloading {count} other tabs)',
    status_other_tab_reloaded: ' (also reloading 1 other tab)',
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
    // popup — subdomain groups
    group_chip:              'Group: {group}',
    group_chip_title:        'Cookies for {group} and its subdomains are saved and switched together',
    permission_body_group:   'Saving and switching cookies needs permission to read and write the cookies of {group} and its subdomains.',
    row_host_title:          'Saved on {host}. Only its cookies are applied on this page',
    status_loaded_cookies_only:           'Applied the cookies of "{name}" (its page data belongs to {host} and was not applied)',
    status_loaded_cookies_only_no_backup: 'Applied the cookies of "{name}" (its page data belongs to {host} and was not applied; not enough storage to keep the state before switching)',
    scope_label_group:       '{host} (cookies for the whole {group} group)',
    // popup — partial load
    menu_load_partial:       'Load only some…',
    load_partial_title:      'What to load from "{name}"',
    load_partial_no_undo:    'The current data of the chosen types will be overwritten and can\'t be restored.',
    btn_load:                'Load',
    error_choose_type:       'Choose at least one type to load',
    badge_active_partial:    'Partly active',
    active_partial_title:    'Loaded: {types}. Other types are not compared',
    status_loaded_partial:           'Applied {types} of "{name}"',
    status_loaded_partial_no_backup: 'Applied {types} of "{name}" (not enough storage to keep the state before switching)',
    confirm_overwrite_partial: 'Overwrite {types} of "{name}" with the current state?\nThe other types stay as saved.',
    error_overwrite_no_types:  'Can\'t overwrite: every type that was loaded is turned off in the settings',
    // options — headings
    options_title:            'Settings',
    section_language:         'Language',
    section_behavior:         'Behavior',
    toggle_auto_backup:       'Back up the current state before loading',
    toggle_auto_reload:       'Reload the page after loading',
    toggle_reload_other_tabs: 'Also reload other tabs of the same site',
    hint_reload_other_tabs:   'Unsaved input in those tabs is lost. sessionStorage belongs to each tab and is not switched, so on sites that keep the login there, the other tabs stay on the previous account.',
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
    // options — export / import / encryption
    toggle_encrypt_exports:        'Encrypt exported files with a passphrase',
    hint_export_sessions:          'Exported files contain your signed-in sessions (cookies and more). Anyone you give the file to can sign in to those accounts.',
    hint_passphrase_unrecoverable: 'If you forget the passphrase, an encrypted file cannot be recovered.',
    export_domain_title:           'Export "{domain}"',
    export_snapshot_title:         'Export "{name}"',
    passphrase_new_title:          'Encrypt the export',
    passphrase_title:              'Encrypted file',
    passphrase_label:              'Passphrase',
    passphrase_confirm_label:      'Passphrase (again)',
    btn_export_confirm:            'Export',
    btn_import_confirm:            'Import',
    error_passphrase_short:        'Use at least {n} characters',
    error_passphrase_mismatch:     'The two passphrases do not match',
    error_dialog_check_failed:     'Could not check the input. Please try again',
    error_enter_passphrase:        'Please enter the passphrase',
    error_wrong_passphrase:        'Wrong passphrase. Nothing was imported.',
    error_import_too_large:        'The file is too large (limit {size}). Nothing was imported.',
    error_export_failed:           'Export failed',
    confirm_import_conflicts:      '{n} snapshot(s) already exist with the same name:\n{names}\nWhat should happen to them?',
    choice_overwrite:              'Overwrite',
    choice_skip:                   'Skip',
    choice_keep_both:              'Keep both (add with a new name)',
    // options — subdomain groups
    section_groups:          'Subdomain groups',
    hint_groups:             'Add a domain to save and switch the cookies of it and its subdomains together. Snapshots of each subdomain are listed in the popup on every site in the group.',
    group_input_label:       'Domain to group',
    btn_add_group:           'Add',
    empty_groups:            'No groups',
    btn_remove_group_title:  'Remove group "{group}"',
    confirm_add_group:       'Group {group} and *.{group} together?\nAll cookies in this scope are saved, deleted and restored together.\n\nDon\'t use a domain shared by unrelated sites (such as a hosting service\'s domain): other sites\' cookies would be deleted or overwritten too.',
    confirm_remove_group:    'Remove group "{group}"?\nSaved snapshots are kept.',
    status_group_added:      'Added group "{group}"',
    status_group_added_no_permission: 'Added group "{group}". Access to its cookies will be asked for again when you open the popup',
    status_group_removed:    'Removed group "{group}"',
    error_group_failed:      'Couldn\'t change the groups',
    error_group_invalid:     'Enter a domain such as example.com',
    error_group_ip:          'An IP address can\'t be a group',
    error_group_single_label: 'Enter a domain that contains a dot (.)',
    error_group_registry:    '"{group}" is shared by many sites and can\'t be a group',
    error_group_shared:      '"{group}" is a hosting domain shared by unrelated sites and can\'t be a group',
    error_group_duplicate:   '"{group}" is already a group',
    error_group_nested:      '"{group}" overlaps an existing group',
    // options — domain list
    empty_snapshots: 'No saved data',
    count_format:    '{n}',
    // options — status / confirm
    status_settings_saved:   'Settings saved',
    status_exported:         'Exported an encrypted file',
    status_exported_plain:   'Exported. The file contains your signed-in sessions; you can turn on encryption under Data management.',
    status_imported:         'Imported ({added} added, {overwritten} overwritten, {renamed} added with a new name, {skipped} skipped)',
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
}
