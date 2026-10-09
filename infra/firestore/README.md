# Firestore 定義（CHG-006）

| ファイル | 内容 |
|---|---|
| `firestore.indexes.json` | 複合索引と TTL。試験用の MemoryDocStore もこのファイルを読み、索引が無い検索を失敗させる |
| `firestore.rules` | クライアントからの直接アクセスを全面禁止（サーバーのみが読み書き） |

反映は `scripts/firestore/apply-firestore-config.sh <project>`（gcloud で索引・TTL・ルールを作成）。
