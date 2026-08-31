import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildWorkerGlance,
  PI_LUNA_RECEIPT_SCHEMA_VERSION,
  SOL_LUNA_RECEIPT_SCHEMA_VERSION,
  WORKER_GLANCE_MAX_ARTIFACT_BYTES,
  WORKER_GLANCE_MAX_OUTPUT_CHARS,
} from "../scripts/worker-glance.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface RunOptions {
  readonly runId?: string;
  readonly role?: string;
  readonly changedPaths?: readonly string[];
  readonly commitsMade?: readonly string[];
  readonly success?: boolean;
  readonly outcome?: "not_started" | "worker_succeeded" | "worker_failed" | "timeout" | "harness_failed";
  readonly timedOut?: boolean;
  readonly tokenUsage?: Readonly<Record<string, number>> | null;
  readonly result?: Record<string, unknown> | null;
  readonly resultPresentInReceipt?: boolean;
  readonly harnessError?: string | null;
  readonly schemaVersion?: string;
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function receipt(directory: string, options: RunOptions): Record<string, unknown> {
  const resultPresent = options.resultPresentInReceipt ?? options.result !== null;
  return {
    schemaVersion: options.schemaVersion ?? SOL_LUNA_RECEIPT_SCHEMA_VERSION,
    run: {
      id: options.runId ?? directory.split("/").at(-1) ?? "run",
      assignedRole: options.role ?? "implementation worker",
    },
    repository: "/repo",
    sandbox: "read-only",
    confinement: {
      mode: "permission-profile",
      clientVersion: "0.151.0",
      permissionProfileSupported: true,
      profileVersion: "codex-permission-profile/1",
      profileFingerprint: "sha256:profile",
      networkEnabled: false,
    },
    preflight: {
      command: ["codex", "login", "status"],
      exitCode: 0,
      chatGptAuthenticated: true,
      editAuthority: { mode: "read-only", status: "not_required", error: null },
      gitMetadataAuthority: { mode: "none", status: "not_required", error: null },
      requiredCommands: [],
    },
    git: {
      headBefore: "a".repeat(40),
      headAfter: "a".repeat(40),
      headRelationship: "unchanged",
      dirtyPathsBefore: [],
      dirtyPathsAfter: [],
      workerCreatedDirtyPaths: [],
      commitsMade: options.commitsMade ?? [],
      committedPaths: [],
      baselineContaminatedCommittedPaths: [],
      changedPaths: options.changedPaths ?? [],
    },
    child: {
      commandShape: {
        executable: "codex",
        confinement: "permission-profile",
        profileFingerprint: "sha256:profile",
        args: [],
        stdin: "canonical-brief",
        reasoningEffort: "max",
        promptSurface: { profile: "full", contextRetirements: [], capabilityRetirements: [] },
        wallClockTimeoutMs: 600_000,
        shellEnvironment: { inherit: "none", path: "/bin", home: "/tmp/home", tmpdir: "/tmp/tmp" },
      },
      exitCode: options.success === false ? 1 : 0,
      signal: null,
      timedOut: options.timedOut ?? false,
      outcome: options.outcome ?? (options.success === false ? "worker_failed" : "worker_succeeded"),
      stdinOutcome: "delivered_without_error",
      stdinDetail: null,
      wallClockTimeoutMs: 600_000,
    },
    codex: {
      sessionOrThreadId: "thread-cold",
      threadId: "thread-cold",
      tokenUsage: options.tokenUsage === undefined
        ? {
          input_tokens: 21,
          cached_input_tokens: 4,
          output_tokens: 13,
          reasoning_tokens: 5,
        }
        : options.tokenUsage,
    },
    artifacts: {
      stdoutJsonl: { path: join(directory, "stdout.jsonl"), bytes: 1, sha256: "sha256:cold", truncated: false, fullOutputBytes: 1, omittedBytes: 0 },
      stderr: { path: join(directory, "stderr.log"), bytes: 1, sha256: "sha256:cold", truncated: false, fullOutputBytes: 1, omittedBytes: 0 },
      finalWorkerResult: resultPresent
        ? { path: join(directory, "worker-result.json"), bytes: 1, sha256: "sha256:result" }
        : null,
    },
    integration: {
      workerSuccessIsProvisional: true,
      status: "not_adjudicated",
      gatesAdjudicated: false,
      note: "COLD INTEGRATION NOTE SHOULD NOT APPEAR",
    },
    success: options.success ?? true,
    harnessError: options.harnessError ?? null,
  };
}

async function createRun(root: string, name: string, options: RunOptions = {}): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  if (options.schemaVersion !== "pi-worker-receipt/1") {
    await json(join(directory, "receipt.json"), receipt(directory, options));
  } else {
    await json(join(directory, "receipt.json"), {
      ...receipt(directory, options),
      backend: "pi",
      secret: "COLD PI PROSE SHOULD NOT APPEAR",
    });
  }
  if (options.result !== null) {
    await json(join(directory, "worker-result.json"), options.result ?? {
      status: "completed",
      verification: [true],
      summary: "COLD RESULT SUMMARY SHOULD NOT APPEAR",
    });
  }
  await writeFile(join(directory, "stdout.jsonl"), "COLD RAW MODEL MESSAGE\n");
  await writeFile(join(directory, "stderr.log"), "COLD HARNESS ERROR SECRET\n");
  return directory;
}

async function createPiRun(
  root: string,
  name: string,
  usage: Record<string, unknown> = {
    input: 100,
    cacheRead: 80,
    cacheWrite: 5,
    output: 20,
    reasoning: 10,
    totalTokens: 205,
    cost: { total: 0.01 },
  },
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await json(join(directory, "receipt.json"), {
    ...receipt(directory, {
      schemaVersion: PI_LUNA_RECEIPT_SCHEMA_VERSION,
      changedPaths: ["src/pi.ts"],
      commitsMade: ["pi-commit"],
    }),
    pi: {},
    invocation: {},
    usage,
  });
  await json(join(directory, "worker-result.json"), {
    status: "complete",
    verification: ["passed"],
    summary: "COLD PI RESULT SUMMARY SHOULD NOT APPEAR",
  });
  await writeFile(join(directory, "stdout.jsonl"), "COLD PI RAW MODEL MESSAGE\n");
  await writeFile(join(directory, "stderr.log"), "COLD PI HARNESS ERROR SECRET\n");
  return directory;
}

describe("worker glance", () => {
  test("projects Pi receipts through the same bounded row without reading prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-pi-"));
    temporaryRoots.push(root);
    const run = await createPiRun(root, "pi-run");

    const projection = await buildWorkerGlance([run]);
    expect(projection.rows[0]).toMatchObject({
      backend: "pi",
      state: "terminal",
      success: true,
      provisional: true,
      changedPathCount: 1,
      changedPaths: ["src/pi.ts"],
      commitCount: 1,
      usage: { input: 185, cached: 80, uncached: 105, cachePercentage: 43.2, output: 20, reasoning: 10 },
      resultStatus: "success",
      verificationCount: 1,
      verificationPass: "passed",
      blocker: "none",
    });
    expect(JSON.stringify(projection)).not.toContain("COLD");
  });

  test("rejects inconsistent Pi usage algebra instead of inventing token fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-pi-usage-"));
    temporaryRoots.push(root);
    const run = await createPiRun(root, "pi-invalid", {
      input: 100,
      cacheRead: 80,
      cacheWrite: 5,
      output: 20,
      reasoning: 10,
      totalTokens: 204,
    });

    const projection = await buildWorkerGlance([run]);
    expect(projection.rows[0]).toMatchObject({
      backend: "pi",
      state: "unknown",
      success: null,
      usage: { input: null, cached: null, uncached: null, output: null, reasoning: null },
      blocker: "receipt_invalid",
    });
  });

  test("shares one root, uses relative evidence pointers, and sorts deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-prefix-"));
    temporaryRoots.push(root);
    const runZ = await createRun(root, "run-z", {
      runId: "opaque-z",
      changedPaths: ["z.ts", "a.ts", "b.ts", "c.ts", "d.ts"],
      result: { status: "completed", verification: [true, true] },
    });
    const runA = await createRun(root, "run-a", {
      runId: "opaque-a",
      changedPaths: ["src/a.ts"],
      commitsMade: ["commit-a"],
      result: { status: "success", verification: { checks: [true] } },
    });

    const first = await buildWorkerGlance([runZ, runA]);
    const second = await buildWorkerGlance([runA, runZ]);

    expect(first).toEqual(second);
    expect(first.root).toBe(root);
    expect(first.rows.map((row) => row.receipt)).toEqual(["run-a/receipt.json", "run-z/receipt.json"]);
    expect(first.rows[0]).toMatchObject({
      runId: "opaque-a",
      backend: "sol-luna",
      state: "terminal",
      success: true,
      provisional: true,
      changedPathCount: 1,
      changedPaths: ["src/a.ts"],
      changedPathsOmitted: 0,
      commitCount: 1,
      usage: { input: 21, cached: 4, uncached: 17, cachePercentage: 19, output: 13, reasoning: 5 },
      resultStatus: "success",
      verificationCount: 1,
      verificationPass: "passed",
      blocker: "none",
      receipt: "run-a/receipt.json",
      result: "run-a/worker-result.json",
    });
    expect(first.rows[1]).toMatchObject({
      changedPathCount: 5,
      changedPaths: ["a.ts", "b.ts", "c.ts", "d.ts"],
      changedPathsOmitted: 1,
    });
  });

  test("does not leak cold files or prose and represents missing/unknown evidence explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-cold-"));
    temporaryRoots.push(root);
    const missing = join(root, "missing");
    await mkdir(missing);
    await json(join(missing, "worker-result.json"), {
      status: "completed",
      summary: "COLD RESULT SECRET",
      verification: ["COLD VERIFICATION STRING"],
    });
    await writeFile(join(missing, "stdout.jsonl"), "COLD TRANSCRIPT SECRET\n");
    const unknown = await createRun(root, "unknown", { schemaVersion: "pi-worker-receipt/1", result: { status: "completed", summary: "COLD UNKNOWN" } });
    const failed = await createRun(root, "failed", {
      success: false,
      outcome: "harness_failed",
      harnessError: "COLD HARNESS ERROR WITH SECRET",
      result: { status: "failed", summary: "COLD FAILURE SUMMARY", verification: [false] },
    });

    const projection = await buildWorkerGlance([failed, missing, unknown]);
    const output = JSON.stringify(projection);
    expect(output).not.toContain("COLD");
    expect(projection.rows.map((row) => [row.state, row.success, row.blocker])).toEqual([
      ["terminal", false, "harness_failed"],
      ["missing", null, "receipt_missing"],
      ["unknown", null, "unknown_schema"],
    ]);
    expect(projection.rows[1]).toMatchObject({
      runId: null,
      role: null,
      backend: "unknown",
      resultStatus: "unknown",
      verificationCount: null,
      verificationPass: "unknown",
      receipt: "missing/receipt.json",
      result: "missing/worker-result.json",
    });
    expect(projection.rows[2]).toMatchObject({ backend: "unknown", runId: null, role: null });
    expect(projection.rows[0]?.resultStatus).toBe("failed");
  });

  test("rejects unsafe input directories and handles invalid, oversized, and symlink artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-safety-"));
    temporaryRoots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "worker-glance-outside-"));
    temporaryRoots.push(outside);
    const invalid = await createRun(root, "invalid", { result: { status: "success", verification: [true] } });
    await writeFile(join(invalid, "receipt.json"), "not-json\n");
    const invalidResult = await createRun(root, "invalid-result", { result: { status: "success", verification: [true] } });
    await writeFile(join(invalidResult, "worker-result.json"), "not-json\n");
    const oversized = join(root, "oversized");
    await mkdir(oversized);
    await writeFile(join(oversized, "receipt.json"), `${JSON.stringify({ junk: "x".repeat(WORKER_GLANCE_MAX_ARTIFACT_BYTES) })}\n`);
    const oversizedResult = await createRun(root, "oversized-result", { result: { status: "success", verification: [true] } });
    await writeFile(join(oversizedResult, "worker-result.json"), `${JSON.stringify({ junk: "x".repeat(WORKER_GLANCE_MAX_ARTIFACT_BYTES) })}\n`);
    const symlinkedReceipt = join(root, "symlink-receipt");
    await mkdir(symlinkedReceipt);
    const outsideReceipt = join(outside, "receipt.json");
    await json(outsideReceipt, receipt(symlinkedReceipt, { result: null }));
    await symlink(outsideReceipt, join(symlinkedReceipt, "receipt.json"));
    const symlinkedResult = await createRun(root, "symlink-result", { result: { status: "success", verification: [true] } });
    const outsideResult = join(outside, "worker-result.json");
    await json(outsideResult, { status: "success", verification: [true] });
    await rm(join(symlinkedResult, "worker-result.json"));
    await symlink(outsideResult, join(symlinkedResult, "worker-result.json"));

    const projection = await buildWorkerGlance([invalid, oversized, symlinkedReceipt, symlinkedResult]);
    expect(projection.rows.map((row) => row.blocker)).toEqual([
      "receipt_invalid",
      "receipt_oversized",
      "artifact_symlink",
      "artifact_symlink",
    ]);
    const resultProjection = await buildWorkerGlance([invalidResult, oversizedResult]);
    expect(resultProjection.rows.map((row) => row.blocker)).toEqual(["result_invalid", "result_oversized"]);
    await expect(buildWorkerGlance([invalid, invalid])).rejects.toThrow("duplicate_run_directory");
    await expect(buildWorkerGlance([invalid], { root: outside })).rejects.toThrow("escaping_run_directory");
  });

  test("derives usage without guessing and marks ambiguous verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-usage-"));
    temporaryRoots.push(root);
    const run = await createRun(root, "a-usage", {
      tokenUsage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 7, reasoning_tokens: 2 },
      result: { status: "completed", verification: [true, "not a status", false] },
    });
    const noUsage = await createRun(root, "z-no-usage", {
      tokenUsage: null,
      result: { status: "completed", verificationCount: 0 },
    });

    const projection = await buildWorkerGlance([run, noUsage]);
    expect(projection.rows[1]?.usage).toEqual({
      input: null,
      cached: null,
      uncached: null,
      cachePercentage: null,
      output: null,
      reasoning: null,
    });
    expect(projection.rows[0]).toMatchObject({
      usage: { input: 3, cached: 1, uncached: 2, cachePercentage: 33.3, output: 7, reasoning: 2 },
      verificationCount: 3,
      verificationPass: "ambiguous",
      blocker: "verification_ambiguous",
    });
    expect(projection.rows[1]).toMatchObject({ verificationCount: 0, verificationPass: "unknown" });
  });

  test("caps paths, rows, and total output with explicit omission", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-glance-bounds-"));
    temporaryRoots.push(root);
    const runs = await Promise.all(Array.from({ length: 40 }, (_, index) => createRun(root, `run-${String(index).padStart(2, "0")}`, {
      runId: `id-${index}`,
      changedPaths: Array.from({ length: 20 }, (_, pathIndex) => `src/${index}/${pathIndex}.ts`),
      result: { status: "success", verification: [true] },
    })));
    const projection = await buildWorkerGlance(runs);
    const output = JSON.stringify(projection);
    expect(output.length).toBeLessThanOrEqual(WORKER_GLANCE_MAX_OUTPUT_CHARS);
    expect(projection.truncated).toBe(true);
    expect(projection.omittedRows).toBeGreaterThan(0);
    expect(projection.rows.length).toBeLessThanOrEqual(32);
    expect(projection.rows.every((row) => row.changedPaths.length <= 4)).toBe(true);
    expect(projection.rows[0]?.changedPathsOmitted).toBeGreaterThan(0);
  });

  test("can use an explicit root while retaining relative pointers", async () => {
    const parent = await mkdtemp(join(tmpdir(), "worker-glance-explicit-root-"));
    temporaryRoots.push(parent);
    const root = join(parent, "evidence");
    await mkdir(root);
    const run = await createRun(root, "nested/run", { result: { status: "success", verification: [true] } });
    const projection = await buildWorkerGlance([resolve(run)], { root });
    expect(projection.root).toBe(root);
    expect(projection.rows[0]?.receipt).toBe("nested/run/receipt.json");
  });
});
