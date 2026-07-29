import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const productionSources = [
  { root: "site", pattern: "**/*.{css,html,js,svg}" },
  { root: "src", pattern: "**/*.ts" },
] as const;

describe("no-gradient visual direction", () => {
  test("keeps product rendering sources free of gradients", async () => {
    const violations: string[] = [];

    for (const target of productionSources) {
      const cwd = join(repositoryRoot, target.root);
      const glob = new Bun.Glob(target.pattern);
      for await (const relativePath of glob.scan({ cwd, onlyFiles: true })) {
        const source = await Bun.file(join(cwd, relativePath)).text();
        if (/gradient\s*\(/i.test(source)) {
          violations.push(`${target.root}/${relativePath}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("records the standing operator rule", async () => {
    const policy = await Bun.file(join(repositoryRoot, "STENSIBLY.md")).text();
    expect(policy).toContain("Stensibly is a no-gradient product.");
    expect(policy).toContain("unless the operator explicitly requests an exception");
  });
});
