// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/generated/**"],
  },
  {
    // 金額/率へのJS number使用禁止は静的解析だけでは誤検知が多いため、
    // packages/domain の値オブジェクト（Decimal専用型）とコードレビューで担保する。
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
