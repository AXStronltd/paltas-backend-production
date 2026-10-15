// One lint configuration for the whole backend workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // browser/ holds generated bundles; fixtures are kept byte-for-byte as they were (e.g. the earlier browser rules the parity test compares against)
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "**/test/fixtures/**", "browser/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
  {
    files: ["**/test/**/*.ts", "server/src/scripts/**/*.ts"],
    // tests handle raw JSON answers and assert on them, so `any` and `!` are allowed there
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
