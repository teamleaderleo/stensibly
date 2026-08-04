import { expect, test } from "bun:test";

test("only the public outbound preflight wrapper imports the reviewed base", async () => {
  const allowed = new Set([
    "src/github-outbound-text-preflight.ts",
  ]);
  const sourceFiles = Array.from(
    new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
  );

  for (const path of sourceFiles) {
    const source = await Bun.file(path).text();
    if (source.includes("github-outbound-text-preflight-base.js")) {
      expect(allowed.has(path), path).toBe(true);
    }
  }
});