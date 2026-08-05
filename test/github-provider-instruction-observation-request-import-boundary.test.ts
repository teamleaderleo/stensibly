import { expect, test } from "bun:test";

test("only the public instruction-observation wrapper imports the reviewed base", async () => {
  const allowed = new Set([
    "src/github-provider-instruction-observation-request.ts",
  ]);
  const sourceFiles = Array.from(
    new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
  );

  for (const path of sourceFiles) {
    const source = await Bun.file(path).text();
    if (source.includes("github-provider-instruction-observation-request-base.js")) {
      expect(allowed.has(path), path).toBe(true);
    }
  }
});
