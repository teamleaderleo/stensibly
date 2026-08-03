import { expect, test } from "bun:test";

test("only the public OpenAI Agents wrapper imports the reviewed base", async () => {
  const allowed = new Set(["src/runner-adapters/openai-agents.ts"]);
  const sourceFiles = Array.from(
    new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
  );

  for (const path of sourceFiles) {
    const source = await Bun.file(path).text();
    if (source.includes("openai-agents-base.js")) {
      expect(allowed.has(path), path).toBe(true);
    }
  }
});
