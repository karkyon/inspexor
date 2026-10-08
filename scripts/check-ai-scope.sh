#!/usr/bin/env bash
# FR-020 / T-AI-SCOPE-001 / 00契約 不変条件9: MVPにAI/PEMを一切含めない（SDK・env・route）。検出時は失敗。
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
mapfile -t pkgs < <(git ls-files '*package.json' 2>/dev/null || find . -name package.json -not -path '*/node_modules/*')
for f in "${pkgs[@]}"; do
  if grep -nE '"(openai|@anthropic-ai/[a-z-]+|ai|@ai-sdk/[a-z-]+|langchain|@langchain/[a-z-]+|@google/generative-ai|@google-cloud/vertexai|cohere-ai|@mistralai/[a-z-]+)"[[:space:]]*:' "$f"; then
    echo "AI SDK 依存を検出: $f"; fail=1
  fi
done
if git grep -nIE '(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|VERTEX_AI|/api/v1/(ai|pem)(/|$))' -- ':!scripts/check-ai-scope.sh' ':!docs/**' 2>/dev/null; then
  echo "AI 関連の env/route を検出"; fail=1
fi
if [ "$fail" -ne 0 ]; then exit 1; fi
echo "AI scope check: PASS（AI/PEM 固有物 0）"
