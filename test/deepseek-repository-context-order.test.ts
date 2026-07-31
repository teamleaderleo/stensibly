import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("repository context ordering is literal and locale-independent", async () => {
  const repository = await mkdtemp(join(tmpdir(), "stensibly-context-order-"));
  try {
    await mkdir(join(repository, "A"));
    await mkdir(join(repository, "a"));
    await mkdir(join(repository, "ä"));
    await writeFile(join(repository, "A", "file.txt"), "x");
    await writeFile(join(repository, "a", "file.txt"), "x");
    await writeFile(join(repository, "ä", "file.txt"), "x");
    await writeFile(join(repository, "z.txt"), "x");

    run(["git", "init", "--quiet", repository]);
    run(["git", "-C", repository, "config", "user.email", "context@example.test"]);
    run(["git", "-C", repository, "config", "user.name", "Context Test"]);
    run(["git", "-C", repository, "add", "."]);
    run(["git", "-C", repository, "commit", "--quiet", "-m", "fixture"]);

    const c = measure(repository, "C");
    const swedish = measure(repository, "sv_SE.UTF-8");

    expect(swedish).toEqual(c);
    expect(Object.keys(c.byTopLevel)).toEqual(["(root)", "A", "a", "ä"]);
    expect(c.largestTextFiles.map((entry) => entry.path)).toEqual([
      "A/file.txt",
      "a/file.txt",
      "z.txt",
      "ä/file.txt",
    ]);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

interface ContextReport {
  byTopLevel: Record<string, { files: number; utf8Bytes: number }>;
  largestTextFiles: Array<{ path: string; utf8Bytes: number }>;
}

function measure(repository: string, locale: string): ContextReport {
  const script = resolve("scripts/measure-repository-context.ts");
  const result = Bun.spawnSync(["bun", script, repository], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LANG: locale,
      LC_ALL: locale,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as ContextReport;
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
