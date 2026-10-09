# CHG-006 データベースを提案書どおり Firestore に移行する

| 項目 | 内容 |
|---|---|
| CHG ID | CHG-006 |
| 起票日 | 2026-10-09 |
| 起票者 | Claude（Developer） |
| 承認 | 2026-10-09 利用者回答「A案（Firestore に作り替え）」、§6 F1〜F3 は推奨どおり（Claude は承認権なし） |
| 状態 | APPROVED |
| 根拠 | 提案書 SK-2026-08-MINI P.12（Cloud Run / Firestore / Cloud Storage、Cloud Scheduler で日次バックアップ）、P.13（月 ¥数百〜1,500、上限目安 ¥1,000〜2,000） |
| 影響ID | 開発スタック定義書、インフラ・運用設計書、DB・データ設計書（schema.sql）、API-001〜028 の実装（契約は変更しない）、REQ-DOC-001、バックアップ要件 |

## 1. 理由

現在の実装は Cloud SQL（PostgreSQL）を使っている。Cloud SQL は起動している時間に課金されるため、最小構成でも常時起動で月 約¥2,000〜2,500 となり、提案書の月額（¥数百〜1,500、上限目安 ¥1,000〜2,000）に収まらない。
提案書の構成どおり **Firestore**（Google Cloud のデータベース。表ではなく「文書（document）」単位で保存し、読み書きの回数で課金される。小規模なら無料枠に収まる）に移す。

## 2. 変えないもの

- 画面・API の契約（openapi `3.1.0-CHG-004`）、入力規則、エラー表示、権限（RBAC）
- 業務ルール（`packages/domain`: 工数計算・数量検証・報告番号・帳票・月次集計・和暦）
- 帳票（DAILY_REPORT_V1/V2、運搬報告）、署名付き URL による配信
- 認証方式（ログインID＋パスワード、署名付きセッション Cookie、CSRF、ロックアウト）。提案書 P.12「固定利用者認証」に当たる
- E2E 18件（同じ画面操作で全件合格すること＝移行完了の条件）

## 3. データ配置（Firestore）

| コレクション | 文書 ID | 内容（PostgreSQL の対応表） |
|---|---|---|
| `users` | uuid | users＋user_roles（roles 配列）、ロックアウト情報 |
| `customers` `products` `workTypes` `defectTypes` `workers` `workLocations` `vehicles` `customerContacts` | uuid | 各マスタ。親の ID を項目に持つ（products.customerId 等）。customerContacts は日報担当の品番 ID 配列を持つ（product_contacts を吸収） |
| `holidays` | 日付 `YYYY-MM-DD` | holidays |
| `uniqueKeys` | `{種類}:{親ID}:{コード}` | 一意制約の代わり（ログインID・マスタコード）。作成・コード変更と同じ transaction で作る |
| `counters` | `WR-202610` 等 | 報告番号の採番（advisory lock の代わり。transaction で +1） |
| `workReports` / `deliveryReports` | uuid | 報告ヘッダ（報告番号・状態・版・作成者・運搬費）＋**一覧と月次集計用の要約**（業務日・お客様・品番・数量・不良合計・時間・回数・帳票状態） |
| `workReports/{id}/revisions` / `deliveryReports/{id}/revisions` | 版番号 | 版（work_report_revisions＋作業者・不良、delivery_report_revisions＋品番明細）。確定済みの版は書き換えない |
| `documents` | uuid | document_jobs＋files（保存先キー・サイズ・sha256） |
| `mailJobs` | uuid | mail_jobs（既定で無効のまま） |
| `outbox` | uuid | outbox_events（業務更新と同じ transaction で作る） |
| `idempotency` | sha256(actor,route,key) | idempotency_records。期限切れは TTL（指定日時を過ぎた文書を自動削除する Firestore の機能）で削除 |
| `auditEvents` | uuid | audit_events（追記のみ） |

PostgreSQL が DB 側で保証していた次の制約は、**アプリの transaction で保証**し、試験で確認する。

| PostgreSQL | Firestore |
|---|---|
| UNIQUE（ログインID・マスタコード・報告番号） | `uniqueKeys` / `counters` を同じ transaction で作成・更新 |
| 確定済み版の UPDATE/DELETE 禁止（trigger） | 書込関数で確定済みを拒否＋サーバー以外の書込を Security Rules で全面禁止 |
| 監査の追記のみ（trigger） | 監査は create のみの関数で書く（update/delete の経路を持たない） |
| `SELECT … FOR UPDATE` による楽観排他 | Firestore transaction（読んだ文書が他で変わると自動で再試行）＋ expectedVersion 照合 |
| 外部キー | 書込前に参照先の存在・有効性を確認（現行も同じ検証をしている） |

## 4. 処理の流れの変更

| 項目 | 現行（開発） | 変更後 |
|---|---|---|
| 帳票作成（worker） | 2秒ごとに outbox を見に行く常駐プロセス | **Cloud Run（使わない時は0台）**。web が確定を保存した直後に worker を呼び出す。呼び出し失敗に備えて Cloud Scheduler が10分ごとにも起動する |
| PDF の保存先 | Cloud Shell のディスク | **Cloud Storage**（公開禁止バケット、東京リージョン）。web は署名付き URL の検証後に Cloud Storage から読んで返す |
| 日次バックアップ | Cloud SQL 自動バックアップ（未設定） | **Cloud Scheduler が毎日 Firestore を Cloud Storage へ書き出す**（提案書 P.12 のとおり）。保存 30 日 |
| 一覧の絞込 | SQL の JOIN | ヘッダの要約項目で検索（品番は配列の包含検索）。種別をまたぐ並べ替えはアプリで行う |
| 月次集計 | SQL で集計 | 対象月の確定済み報告（月 約500件）を読み、既存の domain 集計関数で集計 |
| DB 定義の変更 | migration SQL | 不要（文書の項目追加は互換を保てる）。必要な検索の索引は `firestore.indexes.json` で管理 |

## 5. 費用の見込み（提案書 P.13 の使用量: 報告 月500件・閲覧 月2,000回・PDF 月400件）

| サービス | 見込み |
|---|---|
| Firestore 読み書き | 無料枠内（読み 5万回/日、書き 2万回/日）→ ¥0 |
| Firestore 保存容量・バックアップ書き出し | 数十〜100円 |
| Cloud Run（web・worker、0台から起動） | 無料枠内〜少額 |
| Cloud Storage（PDF・バックアップ、東京） | 数十〜数百円 |
| Cloud Scheduler（2ジョブ） | 無料枠内（3ジョブまで無料） |
| 合計 | 月 ¥数百〜1,500（提案書どおり）。予算アラートを ¥2,000 で設定 |

注: 0台から起動するため、朝一番や久しぶりの操作では最初の画面表示に数秒かかる（提案書の構成と同じ性質）。

## 6. 判断事項（2026-10-09 利用者回答: すべて推奨どおり）

| No | 内容 | 決定 |
|---|---|---|
| F1 | 請求専用で画面に出していないマスタ（単価ルール・運搬ルール・固定費ルール）と、運搬明細の「按分対象」判定を移行するか | **移行しない**（CHG-004 の Blind。請求機能を作る時に Firestore で作る）。マスタ管理 E2E の「単価ルール」1件は削除し、E2E は 17 件になる |
| F2 | 開発中の PostgreSQL / Cloud SQL を、移行が終わるまで残すか | **残し、移行完了（E2E 全件合格）後に Cloud SQL `inspexor-db-dev` を削除**。それまでは使わない時間に停止する |
| F3 | 本番用の GCP プロジェクト | 開発用 `inspexor-jadeworks-dev` とは**別のプロジェクトを本番用に作る**（名前は本番準備のバッチで確認） |

## 7. 作業の順番（各段階で全試験に合格してから次へ）

移行途中は PostgreSQL と Firestore が混在して動かないため、g20〜g24 はブランチ `chg-006-firestore` に push し、E2E 全件合格（g24）で main に統合する。main と開発環境の動作は g24 まで現行のまま。


| batch | 内容 |
|---|---|
| g20 | Firestore 基盤: 接続・transaction・一意キー・採番・監査・冪等性・outbox、ユーザーとログイン、開発用 Firestore の作成（`inspexor-jadeworks-dev`）、索引・Security Rules |
| g21 | マスタ管理と合成 seed |
| g22 | 現場入力（作業・運搬の作成・更新・確定）、事務所の報告一覧・詳細・修正（新しい版）・運搬費 |
| g23 | worker（Cloud Storage 保存、HTTP 起動、帳票作成・再出力）、ファイル配信 |
| g24 | 月次集計・Excel/CSV、PostgreSQL・Prisma のコード削除、E2E 全件 |
| g25 | 本番公開: 本番プロジェクト、Cloud Run、Cloud Storage、Cloud Scheduler（worker 予備起動・日次バックアップ）、予算アラート |

## 8. 検証の方法（できること・できないことの区別）

- Claude のサンドボックスからは Google のサーバーに接続できず、**Firestore エミュレータ（PC 上で Firestore と同じ動きをする試験用プログラム）も取得できない**。
- そのため、サンドボックスでは Firestore の動きを模した試験用の代替実装で単体試験を行い、**正式な結合試験はあなたの Cloud Shell で Firestore エミュレータを起動して実行**する（各バッチに組み込む）。E2E は開発用の実 Firestore で実行する。
- バッチの完了は、Cloud Shell での結合試験と E2E の合格をもって判断する。
