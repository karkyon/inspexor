# @inspexor/application

## 責務
use case（application service）／transaction port の定義と実行。

## 禁止（開発スタック定義書 5章）
- provider SDK（Gmail, PDF, Storage等）を直接import禁止。必ずport/adapterを介する。
- 外部APIをDB transaction内から直接呼び出さない（開発スタック定義書 禁止事項）。
