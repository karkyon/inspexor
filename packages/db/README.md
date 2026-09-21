# @inspexor/db

## 責務
Prisma schema／migration／repository実装。DB/データ設計書・schema.sqlが正本。

## 禁止（開発スタック定義書 5章）
- 業務ロジック・UIをこの層に置かない（repository/migrationのみ）
- lockfile/migrationの手編集禁止、DDL driftを許容しない
