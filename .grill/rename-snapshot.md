# Grill: スナップショット名変更機能
Date: 2026-06-03

## Intent
設定画面（options.html）のスナップショット一覧で、保存済みスナップショットの名前を変更できるようにする。

## Key decisions
- Decision: スナップショット名テキストをダブルクリックしてインライン編集モードに入る。Reason: 削除ボタンと並べて編集ボタンを別途置くと行が混雑するため。Alternative considered: 編集アイコンボタンを追加。
- Decision: Enter キーまたは確定ボタン（✓）で確定、Escape でキャンセル、フォーカスが外れた（blur）ときも確定。Reason: 標準的な inline edit パターン。
- Decision: 同一ドメイン内に同名スナップショットが存在する場合はエラー表示して保存をブロック。

## Out of scope
- ポップアップ側からの名前変更
- ドメイン名の変更
