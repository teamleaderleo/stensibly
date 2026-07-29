import tseslint from "typescript-eslint";

export default tseslint.config({
  files: [
    "receiver-eslint-matrix.fixture.ts",
    "generated-receiver-eslint-matrix.fixture.ts",
  ],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: "./tsconfig.eslint.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  rules: {
    "@typescript-eslint/unbound-method": "error",
  },
});
