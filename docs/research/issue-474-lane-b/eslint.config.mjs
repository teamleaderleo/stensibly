import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["receiver-eslint-matrix.fixture.ts"],
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.eslint.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/unbound-method": "error",
  },
});
