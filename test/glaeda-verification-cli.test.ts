import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(resolve(tmpdir(), "glaeda-verification-cli-"));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
const tokenFile = resolve(fixture, "token");
writeFileSync(tokenFile, `stn.tok_${"1".repeat(32)}.${"A".repeat(43)}`, { mode: 0o600 });

describe("Glaeda verification CLI process result", () => {
  for (const profile of ["focused", "required"]) {
    for (const outcome of ["failed", "succeeded", "idle", "waiting_reconciliation"]) {
      test(`${profile} reports ${outcome} with the corresponding process status`, () => {
        const receipt = { outcome, resultSha256: `sha256:${"a".repeat(64)}` };
        const preload = resolve(fixture, `${profile}-${outcome}.ts`);
        // Keep transport/physical effects out of the fixture while exercising
        // the real CLI argument parsing, result serialization and process exit.
        writeFileSync(preload, `import { mock } from "bun:test";
mock.module(${JSON.stringify(resolve(root, "src/glaeda-verify-focused-runner.js"))}, () => ({
  executeGlaedaVerifyFocusedRunV1: async () => (${JSON.stringify(profile === "focused" ? receipt : { outcome: "wrong_profile" })}),
  executeGlaedaVerifyRequiredRunV1: async () => (${JSON.stringify(profile === "required" ? receipt : { outcome: "wrong_profile" })}),
}));`);
        const child = Bun.spawnSync({
          cmd: [process.execPath, "--preload", preload,
            resolve(root, "scripts/glaeda-verify-focused-runner.ts"),
            "--verification-profile", profile, "--token-file", tokenFile,
            "--project", "glaeda", "--run-id", "run-test", "--profile-generation", "test",
            "--python-interpreter", "test", "--verify-script", "test",
            "--verify-implementation", "test", "--repository-root", "test",
            "--state-root", "test", "--cargo-root", "test", "--rustup-root", "test",
            "--node-generation", "1", "--glaeda-runtime", "test"],
          cwd: root, stdout: "pipe", stderr: "pipe",
        });
        expect(child.stderr.toString()).toBe("");
        expect(child.exitCode).toBe(outcome === "failed" ? 1 : 0);
        expect(JSON.parse(child.stdout.toString())).toEqual({
          schema: "glaeda-verify-focused-run/v1", ...receipt,
        });
      });
    }
  }
});
