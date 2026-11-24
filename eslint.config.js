import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "uploads/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  { files: ["src/public/**/*.js"], languageOptions: { globals: { ...globals.browser } } },
];
