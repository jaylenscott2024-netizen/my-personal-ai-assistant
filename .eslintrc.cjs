module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true },
  ignorePatterns: ["dist", "node_modules", "prisma/migrations"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "off",
    "no-console": ["warn", { allow: ["error"] }],
  },
  overrides: [
    {
      // scripts/jarvis-diagnostic.ts is a CLI report — console output is
      // its entire purpose, not a debugging leftover.
      files: ["scripts/**/*.ts"],
      rules: { "no-console": "off" },
    },
  ],
};
