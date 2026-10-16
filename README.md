# INSPEXOR — 三成興業様 作業日報デジタル化システム

提案書 SK-2026-08-MINI（2026年9月5日）にもとづく、作業日報・運搬実績の入力、日報PDF、報告一覧・修正、月次集計、マスタ管理のシステム。
現場は iPad、事務所はパソコンのブラウザで使う。データは Firestore、PDF は Cloud Storage、本番は Cloud Run（asia-northeast1）。

お客様向けの資料は `docs/deliverables/`（要件定義書 02 〜 画面設計書 10）、変更の記録は `docs/chg/`（CHG-001〜）、API 仕様は `docs/spec/openapi.yaml`。

## 構成

```
apps/web            Next.js（App Router）— 画面・REST API（/api/v1）・ログイン
apps/worker         帳票（PDF）の作成・メール送信・outbox の処理。開発は常駐、本番は Cloud Scheduler が毎分起動
packages/domain     時間計算・入力規則・状態・請求計算など（フレームワーク非依存）
packages/application  処理の手順（use case）
packages/docstore   Firestore と試験用の MemoryDocStore、Cloud Storage／ローカルディスク
packages/contracts  OpenAPI の契約
packages/ui         画面部品
infra/firestore     複合索引・TTL・Security Rules
scripts/gcp         本番の構築・更新（deploy-prod.sh）
scripts/firestore   エミュレータの起動、索引・ルールの適用
scripts/docs        納品資料（Markdown）→ PDF
```

本番では、提案書の範囲外の機能（承認・請求・管理者の多要素認証・日報メールの自動送信）を機能フラグで無効にしている（`.env.example` 参照）。

## 開発環境（Cloud Shell）

前提: Node.js 22、pnpm 9、gcloud（開発用プロジェクト `inspexor-jadeworks-dev` に接続できること）、Docker（Mailpit 用）。

```bash
pnpm install --frozen-lockfile
cp .env.example apps/web/.env.local      # AUTH_SECRET などを入れる
(cd apps/web && npx tsx --env-file=.env.local scripts/seed-dev-users.ts)   # 開発用の管理者・現場・事務所（パスワードは ~/.inspexor-dev-*-password に出力）
(cd apps/web && npx tsx --env-file=.env.local scripts/seed-masters.ts)     # 開発用の合成マスタ（SYN-*、E2E が使う）
pnpm dev                                  # web（http://localhost:3000）
(cd apps/worker && npx tsx --env-file=../web/.env.local src/index.ts)    # worker（別のターミナル）
```

マスタ・利用者・試験用の報告は Excel から一括登録できる（手順書 `docs/deliverables/08_テストデータ・マスタ登録手順書.md`）。

## 試験

```bash
# 単体
(cd packages/domain && npx vitest run); (cd packages/application && npx vitest run); (cd packages/docstore && npx vitest run)
node apps/web/scripts/patch-tsconfig.cjs apps/web && (cd apps/web && npx tsc --noEmit && npx vitest run); git checkout -- apps/web/tsconfig.json
# 結合（Firestore エミュレータ 127.0.0.1:8085、Mailpit）
bash scripts/firestore/start-emulator.sh && docker compose up -d mailpit
(cd apps/web && FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npx vitest run --config vitest.integration.config.ts)
(cd apps/worker && FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npx vitest run --config vitest.integration.config.ts)
# 画面操作（開発環境の dev サーバーに対して、直列）
(cd apps/web && E2E_PASSWORD=… E2E_FIELD_PASSWORD=… E2E_OFFICE_PASSWORD=… npx playwright test)
```

## 変更の反映（batch 方式）

変更は1つの batch（`gNN.sh`）にまとめ、Cloud Shell で実行する。batch は 書込み → 内容の照合 → 型検査・単体・結合 → commit → 開発で E2E → push → 本番の更新・確認 の順に進み、途中で止まっても再実行すれば続きから進む。

```bash
mv ~/gNN.sh ~/inspexor/ && cd ~/inspexor && bash gNN.sh
```

パスワードは `~/.inspexor-dev-{admin,field,office}-password`・`~/.inspexor-prod-admin-password`（権限600）のファイルで扱い、画面やログには出さない。

## 本番

```bash
bash scripts/gcp/deploy-prod.sh          # image の作成と Cloud Run・Scheduler・Firestore の設定（何度実行しても同じ状態）
bash scripts/gcp/diag-prod.sh            # 状態の確認
```

運用・バックアップ・障害時の対応は `docs/deliverables/07_運用・保守手順書.md`。
