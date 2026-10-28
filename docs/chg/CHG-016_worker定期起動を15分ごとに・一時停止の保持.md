# CHG-016 worker の定期起動を15分ごとに変更・一時停止の保持

| 項目 | 内容 |
|---|---|
| CHG ID | CHG-016 |
| 起票日 | 2026-10-28 |
| 起票者 | Claude（Developer） |
| 承認 | 2026-10-28 利用者指示「この2点を入れ」（Claude は承認権なし） |
| 状態 | APPROVED |
| 根拠 | 運用費用の方針（提案書 P.12・要件定義書 5章: 小規模利用で月数百円〜1,500円、上限目安 月1,000〜3,000円） |
| 影響ID | scripts/gcp/deploy-prod.sh（Cloud Scheduler `inspexor-worker-run`）、DEPLOY_GCP.md、README.md、基本設計書 1.2、worker・web の説明コメント |

## 1. 経緯

- 本番で毎日課金が発生していた。2026-10-28 に Cloud Shell で確認した結果: `inspexor-worker-run` が毎分（`* * * * *`）ENABLED、直近1時間の `/run` は60回。web・worker とも最小台数は未設定（0台）、CPU は通常の割当て（リクエスト処理中のみ）。
- 毎分の起動で worker が常に待機状態で残っていた（Cloud Run の画面で常に1台）。
- 同日、利用者が Cloud Shell で `inspexor-worker-run`・`inspexor-firestore-export` を一時停止した（本番は業務データの登録前）。

## 2. 変更内容

| No | 内容 |
|---|---|
| 1 | worker の定期起動を毎分から15分ごと（`*/15 * * * *`）に変更。環境変数 `WORKER_SCHEDULE` で変えられる。通常の帳票作成は確定の直後に web が worker を起動する（`apps/web/lib/worker/kick.ts`）ため、待ち時間は変わらない。定期起動は、呼び出しが届かなかった場合と帳票作成のやり直し（10秒〜30分の間隔）の取りこぼしを拾う保険 |
| 2 | `deploy-prod.sh` は Cloud Scheduler の job を作り直すため、一時停止していた job が再開していた。作り直す前の状態が PAUSED なら、作り直した後に一時停止へ戻す |
| — | 「仕事が無ければ `/run` をすぐ終える」は既に実装済み（`apps/worker/src/worker.ts` の `drain`: 1周して仕事が無ければ抜ける）。変更なし |

## 3. 影響

- 帳票作成のやり直しは、最も遅い場合で15分遅れて処理される（従来は最大1分）。
- 試験計画書（05）P-09 の「帳票作成 毎分」は g25 時点の確認結果のため変更しない。次に本番で確認するときは15分ごとで確認する。

## 4. 検証

- `bash -n scripts/gcp/deploy-prod.sh`
- 本番の `inspexor-worker-run` の起動間隔を `gcloud scheduler jobs update http` で15分ごとに変更し、一時停止のままであることを確認（batch g35）
- 実行するコードの変更はない（TypeScript はコメントのみ）ため、E2E と本番の image 更新は行わない。次の本番更新（deploy-prod.sh）で、この版のスクリプトが使われる
