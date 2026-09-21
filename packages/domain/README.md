# @inspexor/domain

## 責務
entities / value objects / state machine / 業務計算（請求・運搬費など）を持つ純粋TypeScript層。

## 禁止（開発スタック定義書 5章 Package境界）
- Next.js / Prisma / Google (Gmail, PDF provider等) の import 禁止
- 決定的・副作用なしの関数のみ（外部I/O禁止）
- 金額・率は Decimal.js を使った値オブジェクトで表現し、JS number をそのまま使わない
