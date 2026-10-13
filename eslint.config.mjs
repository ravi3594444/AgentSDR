import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The call-recorder extension's build output (bun run build:recorder),
    // gitignored like .next: lint its sources, not the bundles.
    "extensions/*/dist/**",
    "extensions/*/release/**",
  ]),
  {
    // scripts/*.js are the historical CommonJS migrations, run with plain
    // `node`. They are the record of how the schema was built and are not
    // rewritten; new scripts are TypeScript (see CLAUDE.md).
    files: ["scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
