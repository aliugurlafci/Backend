/**
 * Backend lint rules.
 *
 * `npm run lint` was declared in package.json but had neither eslint installed
 * nor a config, so it failed on every run and nothing was ever checked.
 *
 * The rules below are deliberately narrow. This codebase is already disciplined
 * (no `any`, no TODOs, thorough comments), so blanket style rules would only add
 * noise; these target the mistakes that have actually cost something here:
 *
 *  - a floating promise (the audit write that silently escaped its transaction),
 *  - an unawaited async call in a sync context,
 *  - `console` in library code, where the structured logger is what ships.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "**/*.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The class of bug this config exists for: a promise nobody waits on
      // finishes outside its transaction, or after the response has been sent.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // Structured JSON logging is the contract; a bare console line is invisible
      // to anything consuming it.
      "no-console": "error",

      // `_`-prefixed args are the codebase's existing convention for "required by
      // the signature, deliberately unused".
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      // Too noisy against a codebase that reads DB rows as `unknown` and narrows
      // at the boundary — which is the correct shape, not a defect.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/restrict-template-expressions": "off",

      // Fires on `String(body.someField)` throughout the HTTP layer, because
      // request bodies are cast rather than parsed. That IS a real weakness —
      // but the fix is zod schemas on those routes, not a cast to silence a
      // linter, and until they exist this rule reports the same known gap a few
      // hundred times.
      "@typescript-eslint/no-base-to-string": "off",

      // Route handlers are `async` because `runApi` types them that way; a
      // handler that happens to need no await is not a defect.
      "@typescript-eslint/require-await": "off",

      // Flags the "declare, then assign in a branch" shape used for readability
      // in several handlers. Stylistic, and the alternative reads worse.
      "no-useless-assignment": "off",
    },
  },
  {
    // The logger IS the console sink — this is the one place it belongs.
    files: ["src/lib/observability/logger.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Scripts are operator tools run from a terminal: printing IS their output.
    files: ["scripts/**", "tests/**"],
    rules: {
      "no-console": "off",
      // `node:test`'s `test()` returns a promise the runner already awaits;
      // flagging every call would be 200 lines of noise for no defect.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
