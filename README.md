# Switch Browser Data

ログイン状態などのブラウザデータ（Cookie・localStorage・sessionStorage・IndexedDB）をスナップショットとして保存し、ワンクリックでドメインごとに切り替えられる Chrome / Edge 拡張機能です。

## 機能

- **スナップショット保存**: 現在のブラウザデータを名前付きで保存
- **ワンクリック切り替え**: 保存済みスナップショットを一覧から選んで即座に復元。数字キーや検索でも選べる（ポップアップを開くショートカットは `Alt+Shift+S`）
- **切り替え前に戻す**: 読み込む直前の状態を自動で残し、ワンクリックで戻せる
- **適用中の表示**: 今どのスナップショットを適用しているかを一覧と拡張機能アイコンに表示し、その後にデータが変わったかも知らせる
- **ドメイン単位の管理**: タブのドメインを自動検出し、ドメインごとにデータを分離
- **対応データ種別**: Cookie / localStorage / sessionStorage / IndexedDB
- **設定画面**: ドメイン管理・データ種別と動作（自動バックアップ・自動リロード・アイコン表示）の切り替え・エクスポート/インポート

## 対応ブラウザ

- Google Chrome
- Microsoft Edge (Chromium ベース)

## インストール（開発版）

1. このリポジトリをクローンまたはダウンロード
2. Chrome で `chrome://extensions/`、Edge で `edge://extensions/` を開く
3. **デベロッパーモード** を有効にする
4. **「パッケージ化されていない拡張機能を読み込む」** をクリック
5. このリポジトリのフォルダを選択

## デプロイ

### 1. zip ファイルのビルド

環境に合わせていずれかのスクリプトを実行してください。ルートに `manifest.zip` が生成されます。

**bash (Linux / macOS / WSL)**
```bash
bash deploy/build.sh
```

**PowerShell**
```powershell
.\deploy\build.ps1
```

**コマンドプロンプト**
```cmd
deploy\build.cmd
```

> `build.cmd` は PATH に `zip` コマンドが必要です。Git for Windows をインストール済みであれば利用できます。

### 2. Chrome Web Store へのアップロード

1. [Chrome Web Store デベロッパーダッシュボード](https://chrome.google.com/webstore/devconsole) を開く
2. 対象の拡張機能を選択（初回は **「新しいアイテムを追加」** をクリック）
3. **「パッケージをアップロード」** から生成した `manifest.zip` をアップロード
4. ストアの掲載情報を確認・更新し、**「審査のため送信」** をクリック

## ライセンス

[LICENSE](LICENSE) を参照してください。
