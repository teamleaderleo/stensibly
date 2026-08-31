import { describe, expect, test } from "bun:test";
import { compileLocalActionIntentV1 } from "../src/local-action-intent.ts";

function commandIntent() {
  return {
    version: 1,
    project: "stensibly",
    itemId: "item_local_exec_1",
    expectedClaimGeneration: 4,
    actionClass: "command",
    source: {
      repository: "TeamLeaderLeo/Stensibly",
      baseCommit: "a".repeat(40),
      baseTree: "b".repeat(40),
      workspaceClass: "task_private",
      workspaceGeneration: "workspace:7",
      overlay: null,
    },
    command: {
      argv: ["python3", "-m", "pytest", "test/foo.py"],
      cwd: { kind: "workspace_root", relativePath: null },
      environmentProfile: "project_default",
    },
    profileId: null,
    latencyClass: "interactive",
    interferenceClass: "coexist",
    resourceProfile: "big-red-light",
    networkClass: "none",
    deadlineSeconds: 300,
    outputLimitBytes: 64 * 1024,
    createdAt: "2026-08-31T18:00:00Z",
    expiresAt: "2026-08-31T19:00:00Z",
  } as const;
}

describe("local action intent", () => {
  test("compiles an argv command as deterministic authority-free intent", () => {
    const compiled = compileLocalActionIntentV1(commandIntent());
    expect(compiled.source.repository).toBe("teamleaderleo/stensibly");
    expect(compiled.command?.argv).toEqual(["python3", "-m", "pytest", "test/foo.py"]);
    expect(compiled.grantsAuthority).toBe(false);
    expect(compiled.authorizesExecution).toBe(false);
    expect(compiled.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(compiled.idempotencyKey).toBe(`local-action:${compiled.fingerprint.slice(7)}`);
    expect(Object.isFrozen(compiled.command?.argv)).toBe(true);
  });

  test("binds a sandbox patch by immutable artifact identity", () => {
    const base = commandIntent();
    const withOverlay = (hex: string) => compileLocalActionIntentV1({
      ...base,
      source: {
        ...base.source,
        overlay: {
          format: "unified_diff_utf8",
          artifactRef: "artifact:local-patch-1",
          sha256: `sha256:${hex.repeat(64)}`,
          bytes: 12_345,
        },
      },
    });
    const first = withOverlay("c");
    const second = withOverlay("d");
    expect(first.source.overlay?.artifactRef).toBe("artifact:local-patch-1");
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  test("refuses shell/path escape shapes but leaves non-shell argv arguments literal", () => {
    const base = commandIntent();
    expect(() => compileLocalActionIntentV1({
      ...base,
      command: { ...base.command, argv: ["/bin/bash", "-c", "echo nope"] },
    })).toThrow("bare executable name");
    expect(() => compileLocalActionIntentV1({
      ...base,
      command: { ...base.command, cwd: { kind: "repository_subdir", relativePath: "../outside" } },
    })).toThrow("relative cwd is invalid");
    expect(compileLocalActionIntentV1({
      ...base,
      command: { ...base.command, argv: ["python3", "script.py", "*.ts", "; rm -rf /"] },
    }).command?.argv.at(-1)).toBe("; rm -rf /");
  });

  test("refuses direct inline shell command-string modes", () => {
    const base = commandIntent();
    for (const argv of [
      ["sh", "-c", "echo nope"],
      ["bash", "-lc", "echo nope"],
      ["zsh", "-fc", "echo nope"],
      ["fish", "--command", "echo nope"],
      ["fish", "-C", "echo nope"],
      ["pwsh", "-Command", "Write-Output nope"],
      ["powershell.exe", "-EncodedCommand", "ZQBjAGgAbwAgAG4AbwBwAGUA"],
      ["cmd.exe", "/c", "echo nope"],
    ]) {
      expect(() => compileLocalActionIntentV1({
        ...base,
        command: { ...base.command, argv },
      })).toThrow("inline shell command strings are not permitted");
    }

    expect(compileLocalActionIntentV1({
      ...base,
      command: { ...base.command, argv: ["bash", "scripts/checked-in-task.sh", "--flag"] },
    }).command?.argv).toEqual(["bash", "scripts/checked-in-task.sh", "--flag"]);
  });

  test("separates command execution from named profile execution", () => {
    const base = commandIntent();
    expect(() => compileLocalActionIntentV1({ ...base, profileId: "verify-focused/v1" }))
      .toThrow("command action cannot carry a profile ID");
    const verify = compileLocalActionIntentV1({
      ...base,
      actionClass: "verify",
      source: { ...base.source, workspaceClass: "resident_exact" },
      command: null,
      profileId: "verify-focused/v1",
      latencyClass: "normal",
    });
    expect(verify).toMatchObject({ actionClass: "verify", profileId: "verify-focused/v1", command: null });
  });

  test("requires task-private source for overlays and development", () => {
    const base = commandIntent();
    expect(() => compileLocalActionIntentV1({
      ...base,
      source: {
        ...base.source,
        workspaceClass: "resident_exact",
        overlay: { format: "unified_diff_utf8", artifactRef: "artifact:patch", sha256: `sha256:${"c".repeat(64)}`, bytes: 100 },
      },
    })).toThrow("overlay requires a task_private workspace");
    expect(() => compileLocalActionIntentV1({
      ...base,
      actionClass: "develop",
      source: { ...base.source, workspaceClass: "resident_exact" },
      command: null,
      profileId: "pi-luna/max",
    })).toThrow("develop action requires a task_private workspace");
  });

  test("bounds lifetime, bytes and credential-shaped text", () => {
    const base = commandIntent();
    expect(() => compileLocalActionIntentV1({ ...base, expiresAt: "2026-09-02T18:00:01Z" }))
      .toThrow("intent lifetime");
    expect(() => compileLocalActionIntentV1({ ...base, outputLimitBytes: 1_048_577 }))
      .toThrow();
    expect(() => compileLocalActionIntentV1({
      ...base,
      command: { ...base.command, argv: ["python3", "Bearer abcdef"] },
    })).toThrow("credential-shaped text");
  });

  test("canonicalizes input property order into one fingerprint", () => {
    const base = commandIntent();
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(compileLocalActionIntentV1(reordered).fingerprint)
      .toBe(compileLocalActionIntentV1(base).fingerprint);
  });
});
