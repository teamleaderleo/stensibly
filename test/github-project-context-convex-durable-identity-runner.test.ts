import { expect, test } from "bun:test";

test("runs the durable workspace and project identity Convex control", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bunx",
      "vitest",
      "run",
      "convex/githubProjectContexts-durable-identity-review.test.ts",
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      STENSIBLY_SERVICE_SECRET: "github-project-context-service-secret",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
  }
  expect(result.exitCode).toBe(0);
}, 30_000);
