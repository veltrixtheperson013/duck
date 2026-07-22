import globals from "globals";

export default [
  {
    files: ["src/**/*.js", "*.js"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        fetch: "readonly",
      },
    },
    rules: {
      // Primary safety net for the module split: flags any identifier that is
      // used but never declared or imported (i.e. a missing cross-module import).
      "no-undef": "error",
      // Surfaces imports/vars that became dead after moving code between files.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
