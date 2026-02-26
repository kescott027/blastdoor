import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "logs/**", ".husky/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["public/manager/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
];
