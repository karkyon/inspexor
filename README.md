# INSPEXOR — 開発環境構築手順書

三成興業向け業務統合システム「INSPEXOR」のローカル開発環境構築手順。
本書は `INSPEXOR_開発スタック定義書_v5.1.md` / `INSPEXOR_インフラ・運用設計書_v5.1.md` を正本として作成した手順書であり、
以後の実装は `Claude向け_INSPEXOR_Gate0-9連続実装指示_v5.1.md` の Gate 0 から順に進める。

## 前提

- リポジトリは現時点で未着手（コード0、tracked filesなし）。本書はGate 0着手前の環境準備を対象とする。
- 対象OS: 開発機のOSは問わないが、Docker / Node.js 22 / pnpmが動作すること。

## 手順

### 1. ツールの導入
```bash
# mise を使う場合（推奨）
mise install        # .mise.toml の node=22 / pnpm=9 を導入

# あるいは手動で
nvm install          # .nvmrc の 22 を導入
npm install -g pnpm@9
```

### 2. 既存ポート・コンテナの棚卸し（必須・スキップ不可）
インフラ・運用設計書「local port」節により、特定のhost path/portを仕様として固定してはいけない。
着手時に必ず棚卸しを行い、空きportを確認してから `.env.local` に記録する。
```bash
pnpm ports:audit   # scripts/audit-ports.sh を実行
```

### 3. 環境変数の設定
```bash
cp .env.example .env.local
```
`.env.local` を編集し、手順2で確認した空きport（`DB_HOST_PORT` 等）と、`DATABASE_URL` / `AUTH_SECRET` を設定する。
Gmail連携・帳票テンプレートID・Sentry DSN等は現段階では空欄でよい（G0では未使用）。

### 4. 依存関係のインストール
```bash
pnpm install --frozen-lockfile
```
※ 初回はlockfileが存在しないため `pnpm install` で生成し、以後は `--frozen-lockfile` を用いる。

### 5. ローカルDB（PostgreSQL16）の起動
```bash
pnpm db:up      # docker compose -p inspexor-dev up -d db
```
`docker compose -p inspexor-dev` のプロジェクト名で起動する（インフラ設計書準拠、container_nameは固定しない）。

### 6. 起動確認
```bash
docker compose -p inspexor-dev ps
pnpm dev          # apps/web を起動
pnpm dev:worker   # apps/worker を起動（別ターミナル）
```

### 7. 品質チェックコマンドの確認
以下が実行できることを確認する（この時点では対象コードが空のため通過するだけで良い）。
```bash
pnpm lint
pnpm typecheck
pnpm test
```

## 構成（開発スタック定義書 2章 monorepo準拠）

```
apps/web           Next.js App Router — UI / REST API / 認証
apps/worker        PDF生成・メール送信・outbox consumer
packages/domain    entities/value/state/計算（フレームワーク非依存）
packages/application  use case / transaction port
packages/db        Prisma / migration / repository（DB設計書・schema.sqlが正本）
packages/contracts  openapi.yaml から生成するAPI契約
packages/ui         デザインシステム（画面UX設計書準拠）
packages/config     型付きenv設定
infra/terraform     GCP IaC（Cloud Run/SQL/Tasks/Storage）
tests/e2e           Playwright（15画面×role×responsive）
tests/contract      OpenAPI/event/schemaのcontract test
docs/adr            技術決定のADR
```

各パッケージの責務・禁止事項は各ディレクトリの `README.md` を参照。

## この後の進め方

環境構築が完了したら、`Claude向け_INSPEXOR_Gate0-9連続実装指示_v5.1.md` に従い、
DOC-00の順で全設計書を読了し `spec-inventory.json` / `implementation-plan.md` を作成したうえで Gate 0 (`G0-INVENTORY`) から着手する。
各Gateは対象ID・変更予定・migration・リスク・禁止事項の宣言 → 実装 → 全Exit greenの確認、を経てからのみ次に進む。
