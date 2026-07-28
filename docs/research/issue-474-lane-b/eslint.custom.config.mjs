import tseslint from "typescript-eslint";
import noReceiverErasure from "./no-receiver-erasure.rule.mjs";

export default tseslint.config({
  files: ["receiver-eslint-matrix.fixture.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: "./tsconfig.eslint.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    tess: {
      rules: {
        "no-receiver-erasure": noReceiverErasure,
      },
    },
  },
  rules: {
    "tess/no-receiver-erasure": "error",
  },
});
