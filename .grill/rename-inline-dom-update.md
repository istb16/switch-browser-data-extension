# Grill: リネーム時にドメイン一覧のアコーディオン開閉状態が保たれるようにする
Date: 2026-07-24

## Intent
設定画面でスナップショット名をリネームすると、`renderDomainList()` によるドメイン一覧全体のDOM再構築が走り、開いていた `.domain-item` の `open` クラスがリセットされて閉じてしまう。表示をそのまま保ったままデータだけを更新したい。

## Constraints
- `lib/snapshot.js` の `renameSnapshot()` は並び順（`orders`）も新しい名前に付け替え済みなので、リネームで表示順は変わらない
- `deleteBtn` のクリック時にも同じ `renderDomainList()` 呼び出しがあり、同じ症状（開閉状態リセット）が起きるが、今回は対象外

## Key decisions
- Decision: `commitRename()` 内の `await renderDomainList()` を廃止し、該当行の `row.dataset.name` / `nameSpan.textContent` を直接書き換える形に変更する。Reason: リネームは並び順・件数・所属ドメインを変えないため、全体再取得・再描画が本質的に不要。DOM要素（row, nameSpan, deleteBtn とそのイベントリスナー）もそのまま使い回せる。Alternative considered: 開いていたドメイン名の集合を記憶して再描画後に復元する方式（削除など構造変化を伴う操作向けの汎用策）→ リネームには過剰なので不採用。
- Decision: 削除ボタンも同様に `renderDomainList()` をやめ、該当 `row.remove()` と `.domain-count` バッジの件数更新のみ行う形に変更する。Reason: ユーザーが「ドメインの件数が0件になってもドメイン項目が残ってよい」と明言したため、空になったドメインを一覧から消す特殊処理が不要になり、シンプルな差分更新で完結する。`buildSnapshotRow` に `header` 参照を渡して `.domain-count` を直接書き換える。

## Out of scope
- 件数0件になったドメイン項目を一覧から自動的に消す処理（ユーザーが不要と明言）
- インポート・全データ削除時の開閉状態保持
