# Chrome Web Store 掲載情報（v2.0.0）

画像は `node store/generate.mjs` で作り直せる（実際の拡張機能を読み込んで撮影し、`store/images/` に書き出す）。

## 画像

| 項目 | ファイル | サイズ |
| --- | --- | --- |
| ストアのアイコン | `images/store-icon-128.png` | 128×128（96×96 の絵＋16px の透明な余白） |
| スクリーンショット（日本語） | `images/ja/screenshot-1.png` 〜 `screenshot-5.png` | 1280×800 |
| スクリーンショット（英語） | `images/en/screenshot-1.png` 〜 `screenshot-5.png` | 1280×800 |
| プロモーション タイル（小） | `images/ja/promo-small.png` / `images/en/promo-small.png` | 440×280 |

スクリーンショットの並び: 1 一覧と切り替え（色ラベル・メモ・中身のプレビュー） / 2 切り替え前に戻す / 3 変更あり / 4 サブドメインのグループ / 5 設定画面（使用量のメーター・グループ・ドメイン一覧）

## 概要（manifest の description。ストアの一覧に出る短い説明・132 文字以内）

現在の値（`_locales/*/messages.json`）のままでも掲載できる。次のリリースで直すなら:

- ja: `サイトごとに Cookie・localStorage・sessionStorage・IndexedDB を名前を付けて保存し、ログイン状態をワンクリックで切り替えます。`
- en: `Save cookies, localStorage, sessionStorage and IndexedDB per site as named snapshots, and switch sign-ins in one click.`

## 説明（ダッシュボードの「説明」欄）

### 日本語

```
テスト用のアカウントを何度も切り替える開発・検証作業のための拡張機能です。
サイトごとに Cookie・localStorage・sessionStorage・IndexedDB を名前を付けたスナップショットとして保存し、ワンクリックで切り替えられます。

■ 主な機能
・ワンクリックで切り替え：一覧の行を押すだけで、保存した状態に丸ごと置き換えます。数字キーや検索でも選べます（ポップアップを開くショートカット：Alt+Shift+S）
・切り替え前に戻す：読み込む直前の状態を自動で残すので、間違えても「戻す」で元どおり
・データの消去：今のサイトのデータをまとめて消して、未ログインの状態からやり直せます（消す前の状態も「戻す」で戻せます）
・適用中の表示：今どのスナップショットを使っているかを一覧とツールバーのアイコンに表示
・変更の検知：適用中のスナップショットとあとから違いが出たら「変更あり」を表示し、何が変わったかがわかります。サイトが自分で書き換える Cookie は自動で比較から外し、手動で外すこともできます
・メモと色ラベル：スナップショットに一言メモと色を付けられます。各行に Cookie などの件数と大きさを表示し、期限切れの Cookie があれば知らせます
・サブドメインのグループ：example.com と *.example.com の Cookie をまとめて保存・切り替えできます
・上書き・名前の変更・削除・並べ替え
・エクスポート／インポート：全体・サイトごと・スナップショットごとに書き出せ、パスフレーズで暗号化もできます。取り込むときに同じ名前があれば、上書き・スキップ・両方残すを選べます
・使用量の表示：どのサイトのデータが大きいかを設定画面で確かめられます
・保存するデータの種類や、自動バックアップ・自動リロードを設定で選べます
・日本語／英語、ライト／ダークに対応

■ データの扱い
保存したデータはすべてお使いのブラウザの中（chrome.storage.local）にだけ置かれ、外部に送信することはありません。
エクスポートしたファイルにはログイン中のセッションが含まれます。人に渡すときは暗号化してください。
Cookie を扱うため、初めて使うサイトではそのサイトへのアクセスの許可を求めます。
```

### English

```
For development and testing work that keeps switching between test accounts.
Save cookies, localStorage, sessionStorage and IndexedDB per site as named snapshots, and switch between them in one click.

FEATURES
• One-click switching: select a row to replace the site's data with the saved state. Number keys and search work too (open the popup with Alt+Shift+S)
• Undo a switch: the state before each load is kept, so Restore brings it back
• Clear a site: wipe the site's data to start signed out, and Restore it if needed
• Active snapshot: the list and the toolbar icon show which snapshot is in use
• Change detection: when the data differs from the active snapshot, "Changed" shows what changed. Cookies the site rewrites by itself are left out automatically, or by hand
• Memo and color labels: add a short note and a color to each snapshot. Each row shows its item counts and size, and warns when a saved cookie has expired
• Subdomain groups: save and switch the cookies of example.com and *.example.com together
• Overwrite, rename, delete and reorder
• Export and import: export everything, one site or one snapshot, optionally encrypted with a passphrase. On import, choose to overwrite, skip or keep both when names clash
• Storage usage: see which sites take the most space in the settings
• Choose which data types to save, and turn automatic backup and reload on or off
• Japanese and English, light and dark

YOUR DATA
Everything you save stays in your browser (chrome.storage.local) and is never sent anywhere.
Exported files contain your signed-in sessions; encrypt them before sharing.
Because it handles cookies, the extension asks for access to a site the first time you use it there.
```

## プライバシーへの取り組み（ダッシュボードの「プライバシー」タブ）

### 単一用途の説明

```
サイトごとのブラウザデータ（Cookie・localStorage・sessionStorage・IndexedDB）をスナップショットとして保存し、切り替えること。
```

### 権限の理由

| 権限 | 理由（入力例） |
| --- | --- |
| `cookies` | スナップショットにサイトの Cookie を保存し、読み込むときに書き戻すため |
| `storage` | スナップショット・設定・切り替え前のバックアップをブラウザ内に保存するため |
| `unlimitedStorage`（v1.0.19 で追加） | 保存するのはユーザーが選んだサイトのデータの写しで、その大きさはサイト次第（IndexedDB は数十 MB になることもある）。サイトごとに複数のスナップショットと切り替え前のバックアップ1件を持つため、chrome.storage.local の標準の上限（10 MB）を超えると保存が失敗する。データは端末内にだけ置き、外部には送らない |

英語で入力する場合: `Snapshots are copies of the site data the user chooses to save (cookies, localStorage, sessionStorage, IndexedDB), so their size depends on the site; IndexedDB alone can be tens of MB. Several snapshots per site plus one pre-switch backup can exceed the 10 MB chrome.storage.local quota, which would make saving fail. All data stays on the device.`
| `tabs` | 開いているタブのドメインを調べてそのサイトのスナップショットを表示し、読み込み後にタブを再読み込みし、ツールバーのアイコンに適用中の名前を出すため |
| ホスト権限（`optional_host_permissions`） | そのサイトの Cookie を読み書きするため。ユーザーが許可したサイトにだけ使う。サブドメインのグループ（v2.0.0 で追加）では、ユーザーが選んだドメインとそのサブドメイン（`*://example.com/*` と `*://*.example.com/*`）を求める。どちらも実行時の許可で、インストール時の権限は増えない |
| コンテンツスクリプト（全サイト） | そのページの localStorage・sessionStorage・IndexedDB を読み書きするため |

`scripting` と `activeTab` は使っていなかったので v1.0.20 で外した（外す方向の変更なので、ユーザーへの確認は出ない）。ダッシュボードにこの2つの理由の欄が残っていれば消す。

### データの使用

- 収集するデータ: なし（ユーザーが保存したデータは端末内にだけ置き、開発者は受け取らない）
- 「認証情報」「ウェブサイトのコンテンツ」などの項目は、端末の外に送らないため該当しない扱い
