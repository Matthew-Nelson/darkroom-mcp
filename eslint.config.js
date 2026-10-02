// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // stdout is the MCP stdio channel; log through src/log.ts (stderr) instead.
      "no-console": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  // Asserting on vi.fn() methods (expect(provider.generate)) is how vitest mocks are checked.
  { files: ["test/**/*.ts"], rules: { "@typescript-eslint/unbound-method": "off" } },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
