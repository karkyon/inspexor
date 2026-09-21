# ADR-0001: GAP-003 command pipeline検査順序のSPEC-CONFLICT解決

## Status
Accepted（暫定確定）

## Context
00_INSPEXOR_仕様正本_Claude実装契約_v5.1.md 不変条件2「認証、CSRF、認可、Zod、version、状態、業務制約の順に検査する」と、
INSPEXOR_機能別詳細設計書_v5.1.md のcommand pipeline定義「...→transaction→root FOR UPDATE→expectedVersion→role/owner→state guard→...」
で、認可チェックとversionチェック（expectedVersion）の前後が逆転している。

## Decision
00契約を優先する。実装上の検査順序は以下に統一する:

認証 → CSRF → 認可（role/owner） → Zod → expectedVersion → state guard → 業務制約 → domain invariant → revision/audit/outbox → version+1 → commit

理由: 00契約 0章の仕様優先順位定義で DOC-00（仕様正本自身）が DOC-06（機能別詳細設計書）より上位。

## Consequences
- packages/application/command-pipeline.ts のステップ順序をこの並びで実装する
- 機能別詳細設計書側の記載は本ADRにより00契約優先で読み替える（原本は変更しない）
