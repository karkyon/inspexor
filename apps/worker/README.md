# apps/worker

## 責務
outbox consumer・帳票（PDF）生成・メール送信（G4 / CHG-003）。

- `src/dispatcher.ts` — outbox を SKIP LOCKED で取得し、帳票 job / メール job を登録（開発環境の enqueue。本番の Cloud Tasks は G9）
- `src/document-jobs.ts` — revision snapshot → template（registry の sha256 照合）→ 未置換 placeholder 検査 → PDF → storage → 読み戻し hash 照合 → GENERATED・CONFIRMED→SUBMITTED
- `src/mail-jobs.ts` — 日報メール（宛先 snapshot、Message-ID による二重送信防止、retry 10s/30s/2m/10m/30m・最大5回）
- `templates/` — fixture A4 HTML（DAILY_REPORT_V1 / DELIVERY_REPORT_V1）。実帳票（EXT-01）導入時も placeholder 名は変えない

## 開発環境での起動
```bash
docker compose up -d mailpit                      # http://127.0.0.1:8025 で受信確認
cd apps/worker && npx tsx --env-file=../web/.env.local src/index.ts
```
環境変数: `DATABASE_URL`（必須）、`STORAGE_DIR`（既定 `~/.inspexor-storage`、web と同じ場所）、`MAILPIT_URL`、`MAIL_FROM`、`WORKER_POLL_MS`、`CHROMIUM_PATH`。
`STORAGE_BUCKET` が設定されている場合は起動しない（Cloud Storage / Gmail adapter は G9: EXTERNAL-BLOCKED）。

## 試験
```bash
ITEST_DATABASE_URL=... MAILPIT_URL=http://127.0.0.1:8025 npx vitest run --config vitest.integration.config.ts
```

## 禁止（開発スタック定義書 5章）
- HTTP session依存禁止（web appのsessionに依存した処理をここに書かない）
