import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { codexEnvironment, runSolLunaCli, runSolLunaWorker, type SolLunaWorkerOptions } from "../scripts/sol-luna-worker.js";
import {
  compileCodexPermissionProfile,
  parseSupportedCodexCliVersion,
  permissionProfileConfigArgs,
  permissionProfileReceiptArgs,
} from "../scripts/codex-permission-profile.js";

const temporaryRoots: string[] = [];
const REPOSITORY_PATH = "teamleaderleo/stensibly";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FakeCodexSetup {
  readonly root: string;
  readonly executable: string;
  readonly argsPath: string;
  readonly stdinPath: string;
  readonly resultPath: string;
  readonly envPath: string;
  readonly workerCreatedPath: string;
  readonly options: SolLunaWorkerOptions;
}

async function shell(command: string, args: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([command, "-c", "core.fsmonitor=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? cwd,
      TMPDIR: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command} failed: ${stderr || stdout}`);
}

function fakeCodexSource(input: {
  readonly argsPath: string;
  readonly stdinPath: string;
  readonly resultPath: string;
  readonly authMode: "chatgpt" | "api-key";
  readonly workerExit: number;
  readonly workerMode: "normal" | "timeout";
  readonly envPath: string;
  readonly workerCreatedPath: string;
}): string {
  return `#!/usr/bin/env bun
const argsPath = ${JSON.stringify(input.argsPath)};
const stdinPath = ${JSON.stringify(input.stdinPath)};
const resultPath = ${JSON.stringify(input.resultPath)};
const authMode = ${JSON.stringify(input.authMode)};
const workerExit = ${input.workerExit};
const workerMode = ${JSON.stringify(input.workerMode)};
const envPath = ${JSON.stringify(input.envPath)};
const workerCreatedPath = ${JSON.stringify(input.workerCreatedPath)};
await Bun.write(envPath, JSON.stringify(process.env));

if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (authMode === "chatgpt") console.log("Logged in using ChatGPT");
  else console.log("Logged in using API key");
  process.exit(authMode === "chatgpt" ? 0 : 1);
}

if (workerMode === "timeout") await new Promise((resolve) => setTimeout(resolve, 500));
if (workerCreatedPath) await Bun.write(workerCreatedPath, "worker-created\\n");
if (argsPath) await Bun.write(argsPath, JSON.stringify(process.argv.slice(2)));
if (stdinPath) await Bun.write(stdinPath, await Bun.stdin.text());
if (resultPath) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fake-01" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: await Bun.file(resultPath).text() },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 21, cached_input_tokens: 4, output_tokens: 13, total_tokens: 34 },
  }));
}
if (workerExit !== 0) console.error("fake worker failure");
process.exit(workerExit);
`;
}

async function setupFakeCodex(overrides: Partial<{
  readonly authMode: "chatgpt" | "api-key";
  readonly workerExit: number;
  readonly workerMode: "normal" | "timeout";
}> = {}): Promise<FakeCodexSetup> {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-worker-test-"));
  temporaryRoots.push(root);
  const repository = join(root, "repo with spaces;[safe]");
  const brief = join(root, "brief with spaces;[safe].md");
  const schema = join(root, "worker-result schema.json");
  const outputDir = join(root, "evidence output;[safe]");
  const executable = join(root, "fake codex;[safe]");
  const argsPath = join(root, "args.json");
  const stdinPath = join(root, "stdin.bin");
  const resultPath = join(root, "result.json");
  const envPath = join(root, "codex-env.json");
  const workerCreatedPath = join(repository, "worker-created.txt");
  await mkdirRepository(repository);
  await writeFile(brief, "Canonical brief bytes\nline two\n");
  await writeFile(schema, JSON.stringify({ type: "object" }));
  await writeFile(resultPath, JSON.stringify({
    run_id: "sol-luna-2026-08-25-01-wrapper",
    worker_ref: "thread-fake-01",
    assigned_role: "implementation worker",
    objective: "fake worker result",
    repository: REPOSITORY_PATH,
    base_head: "unknown",
    final_head: "unknown",
    work_performed: ["captured canonical brief"],
    changed_paths: [],
    commands_executed: [],
    results: ["ok"],
    findings: [],
    remaining_uncertainty: [],
    blockers: [],
    recommended_next_action: "done",
    retrospective: {
      missing_information: [],
      unnecessary_instructions: [],
      assumptions_discovered: [],
      lesson_candidate: "",
    },
  }));
  await writeFile(executable, fakeCodexSource({
    argsPath,
    stdinPath,
    resultPath,
    authMode: overrides.authMode ?? "chatgpt",
    workerExit: overrides.workerExit ?? 0,
    workerMode: overrides.workerMode ?? "normal",
    envPath,
    workerCreatedPath,
  }));
  await chmod(executable, 0o755);
  return {
    root,
    executable,
    argsPath,
    stdinPath,
    resultPath,
    envPath,
    workerCreatedPath,
    options: {
      repository,
      brief,
      outputSchema: schema,
      outputDir,
      runId: "sol-luna-2026-08-25-01-wrapper",
      assignedRole: "implementation worker",
      sandbox: "workspace-write",
      confinement: "legacy-sandbox",
      codexBin: executable,
    },
  };
}

async function mkdirRepository(repository: string): Promise<void> {
  await shell("git", ["init", "-q", repository], process.cwd());
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await shell("git", ["-C", repository, "add", "tracked.txt"], process.cwd());
  await shell(
    "git",
    ["-C", repository, "-c", "user.name=Sol Luna Test", "-c", "user.email=sol-luna@example.invalid", "commit", "-q", "-m", "initial"],
    process.cwd(),
  );
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
}

function artifactHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function cliArgs(options: SolLunaWorkerOptions): string[] {
  return [
    "--repository", options.repository,
    "--brief", options.brief,
    "--output-schema", options.outputSchema,
    "--output-dir", options.outputDir,
    "--run-id", options.runId,
    "--assigned-role", options.assignedRole,
    "--sandbox", options.sandbox ?? "read-only",
    "--confinement", options.confinement ?? "permission-profile",
    "--codex-bin", options.codexBin ?? "codex",
  ];
}

test("codexEnvironment only forwards the explicit non-secret allowlist", () => {
  const environment = codexEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex",
    OPENAI_API_KEY: "secret",
    OPENAI_ADMIN_KEY: "secret",
    EVIL_PARENT_VARIABLE: "must-not-pass",
  });

  expect(environment).toEqual({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex",
  });
  expect(environment.OPENAI_API_KEY).toBeUndefined();
  expect(environment.EVIL_PARENT_VARIABLE).toBeUndefined();
});

test("permission-profile compilation is deterministic and fail-closed", () => {
  const input = {
    repository: "/work/repository",
    gitDir: "/git/worktree",
    commonGitDir: "/git/common",
    runtimeDir: "/runtime/worker",
    outputDir: "/trusted/evidence",
    workspaceAccess: "read" as const,
  };
  const first = compileCodexPermissionProfile(input);
  const second = compileCodexPermissionProfile(input);
  const args = permissionProfileConfigArgs(first);

  expect(first).toEqual(second);
  expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(first.config).toContain('":root"="deny"');
  expect(first.config).toContain('":minimal"="read"');
  expect(first.config).toContain('"."="read"');
  expect(first.config).toContain('network={enabled=false}');
  expect(args).toContain("--ignore-user-config");
  expect(args).toContain("--strict-config");
  expect(args.join(" ")).not.toContain("--sandbox");
});

test("permission-profile command receipts retain identity without live absolute paths", () => {
  const profile = compileCodexPermissionProfile({
    repository: "/secret/repository",
    gitDir: "/secret/git/worktree",
    commonGitDir: "/secret/git/common",
    runtimeDir: "/secret/runtime",
    outputDir: "/secret/evidence",
    workspaceAccess: "read",
  });
  const args = permissionProfileReceiptArgs(profile);
  expect(args.join(" ")).toContain(profile.fingerprint);
  expect(args.join(" ")).toContain(profile.version);
  expect(args.join(" ")).not.toContain("/secret/");
});

test("permission-profile support requires an exact recent Codex CLI version", () => {
  expect(parseSupportedCodexCliVersion("codex-cli 0.146.0\n")).toBe("0.146.0");
  expect(parseSupportedCodexCliVersion("codex-cli 0.137.9\n")).toBeNull();
  expect(parseSupportedCodexCliVersion("codex 0.146.0\n")).toBeNull();
  expect(parseSupportedCodexCliVersion("Logged in using ChatGPT\n")).toBeNull();
});

test("permission-profile confinement rejects direct workspace writes", async () => {
  const setup = await setupFakeCodex();
  await expect(runSolLunaWorker({
    ...setup.options,
    confinement: "permission-profile",
  })).rejects.toThrow("patch-as-data");
  expect(await Bun.file(setup.options.outputDir).exists()).toBe(false);
});

test("permission-profile confinement rejects system-temp evidence before side effects", async () => {
  const setup = await setupFakeCodex();
  await expect(runSolLunaWorker({
    ...setup.options,
    sandbox: "read-only",
    confinement: "permission-profile",
    editAuthority: "read-only",
  })).rejects.toThrow("system temp");
  expect(await Bun.file(setup.options.outputDir).exists()).toBe(false);
  expect(await Bun.file(`${setup.options.outputDir}.runtime`).exists()).toBe(false);
});

test("permission-profile confinement resolves symlinks before overlap admission", async () => {
  const setup = await setupFakeCodex();
  const alias = join(setup.root, "repository-alias");
  await symlink(setup.options.repository, alias);
  const aliasedOutput = join(alias, "evidence");
  await expect(runSolLunaWorker({
    ...setup.options,
    outputDir: aliasedOutput,
    sandbox: "read-only",
    confinement: "permission-profile",
    editAuthority: "read-only",
  })).rejects.toThrow("overlap the repository");
  expect(await Bun.file(join(setup.options.repository, "evidence")).exists()).toBe(false);
});

describe("disposable Sol/Luna Codex worker harness", () => {
  test("preserves a pre-existing runtime sibling and records a harness failure", async () => {
    const setup = await setupFakeCodex();
    const runtimeRoot = `${setup.options.outputDir}.runtime`;
    const sentinel = join(runtimeRoot, "sentinel.txt");
    await mkdir(runtimeRoot);
    await writeFile(sentinel, "commander-owned\n");

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.child.outcome).toBe("harness_failed");
    expect(result.receipt.harnessError).toContain("unable to claim worker runtime");
    expect(await Bun.file(sentinel).text()).toBe("commander-owned\n");
    expect(await Bun.file(setup.argsPath).exists()).toBe(false);
  });

  test("refuses API-key authentication before launching a worker and writes a receipt", async () => {
    const setup = await setupFakeCodex({ authMode: "api-key" });
    const result = await runSolLunaWorker(setup.options);
    const receipt = await readJson(result.receiptPath);

    expect(result.exitCode).toBe(1);
    expect(receipt.success).toBe(false);
    expect(receipt.harnessError).toContain("ChatGPT authentication");
    expect((receipt.preflight as Record<string, unknown>).chatGptAuthenticated).toBe(false);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("harness_failed");
    expect(await Bun.file(setup.argsPath).exists()).toBe(false);
    expect(await Bun.file(join(setup.options.outputDir, "receipt.json")).exists()).toBe(true);
  });

  test("captures successful worker evidence, exact stdin bytes, thread ID, usage, and Git state", async () => {
    const setup = await setupFakeCodex();
    const exitCode = await runSolLunaCli(cliArgs(setup.options));
    const receipt = await readJson(join(setup.options.outputDir, "receipt.json"));
    const args = await Bun.file(setup.argsPath).json() as string[];
    const stdin = await Bun.file(setup.stdinPath).bytes();
    const stdout = await Bun.file(join(setup.options.outputDir, "stdout.jsonl")).bytes();
    const workerResult = await Bun.file(join(setup.options.outputDir, "worker-result.json")).json();

    expect(exitCode).toBe(0);
    expect(receipt.success).toBe(true);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("worker_succeeded");
    expect((receipt.codex as Record<string, unknown>).threadId).toBe("thread-fake-01");
    expect((receipt.codex as Record<string, unknown>).tokenUsage).toEqual({
      input_tokens: 21,
      cached_input_tokens: 4,
      output_tokens: 13,
      total_tokens: 34,
    });
    expect(receipt.git).toMatchObject({
      headBefore: expect.stringMatching(/^[0-9a-f]{40}$/u),
      headAfter: expect.stringMatching(/^[0-9a-f]{40}$/u),
      baselineDirtyPaths: [],
      workerCreatedDirtyPaths: ["worker-created.txt"],
      commitsMade: [],
      committedPaths: [],
      finalDirtyPaths: ["worker-created.txt"],
      changedPaths: ["worker-created.txt"],
    });
    expect(Buffer.from(stdin).toString("utf8")).toBe(await Bun.file(setup.options.brief).text());
    expect(args.slice(0, 7)).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "--config",
      'model_reasoning_effort="max"',
    ]);
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).toContain(`shell_environment_policy.set.HOME="${setup.options.outputDir}.runtime/home"`);
    expect(args).toContain(`shell_environment_policy.set.TMPDIR="${setup.options.outputDir}.runtime/tmp"`);
    expect(args.some((value) => value.startsWith("shell_environment_policy.set.PATH="))).toBe(true);
    expect(args).toContain("--sandbox");
    expect(args).toContain(setup.options.repository);
    expect(args).toContain(setup.options.outputSchema);
    expect((receipt.child as Record<string, unknown>).timedOut).toBe(false);
    expect((receipt.child as Record<string, unknown>).wallClockTimeoutMs).toBe(1800000);
    expect(receipt.integration).toMatchObject({ workerSuccessIsProvisional: true, status: "not_adjudicated", gatesAdjudicated: false });
    expect(workerResult).toMatchObject({ worker_ref: "thread-fake-01" });
    const codexEnvironmentCapture = await readJson(setup.envPath);
    expect(codexEnvironmentCapture.OPENAI_API_KEY).toBeUndefined();
    expect((receipt.artifacts as Record<string, unknown>).stdoutJsonl).toMatchObject({
      path: join(setup.options.outputDir, "stdout.jsonl"),
      bytes: stdout.byteLength,
      sha256: artifactHash(stdout),
    });
  });

  test("passes hostile-looking paths as argv values rather than shell text", async () => {
    const setup = await setupFakeCodex();
    const marker = join(setup.root, "should-not-exist");
    const options = {
      ...setup.options,
      repository: setup.options.repository,
      brief: setup.options.brief,
      outputSchema: setup.options.outputSchema,
      outputDir: setup.options.outputDir,
    };
    const result = await runSolLunaWorker(options);
    const args = await Bun.file(setup.argsPath).json() as string[];

    expect(result.exitCode).toBe(0);
    expect(args[args.indexOf("--cd") + 1]).toBe(setup.options.repository);
    expect(args[args.indexOf("--output-schema") + 1]).toBe(setup.options.outputSchema);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await Bun.file(setup.stdinPath).text())).toContain("Canonical brief bytes");
  });

  test("probes Git metadata only when explicitly requested", async () => {
    const setup = await setupFakeCodex();
    const result = await runSolLunaWorker({ ...setup.options, gitMetadataAuthority: "write" });
    expect(result.exitCode).toBe(0);
    expect(result.receipt.preflight.gitMetadataAuthority).toMatchObject({
      declared: "write",
      status: "passed",
      headPath: expect.stringContaining("HEAD"),
      indexPath: expect.stringContaining("index"),
    });
    expect(result.receipt.git.headBefore).toBe(result.receipt.git.headAfter);
  });

  test("does not attribute baseline dirtiness to the worker", async () => {
    const setup = await setupFakeCodex();
    await writeFile(join(setup.options.repository, "preexisting.txt"), "before\n");
    const result = await runSolLunaWorker(setup.options);
    expect(result.receipt.git.baselineDirtyPaths).toEqual(["preexisting.txt"]);
    expect(result.receipt.git.workerCreatedDirtyPaths).toEqual(["worker-created.txt"]);
    expect(result.receipt.git.finalDirtyPaths).toEqual(["preexisting.txt", "worker-created.txt"]);
    expect(result.receipt.git.changedPaths).toEqual(["worker-created.txt"]);
  });

  test("kills an over-budget worker and records a timeout outcome", async () => {
    const setup = await setupFakeCodex({ workerMode: "timeout" });
    const result = await runSolLunaWorker({ ...setup.options, timeoutMs: 25, reasoningEffort: "high" });
    expect(result.exitCode).toBe(124);
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.harnessError).toBeNull();
    expect(result.receipt.child).toMatchObject({ timedOut: true, outcome: "worker_timed_out", wallClockTimeoutMs: 25 });
    expect(result.receipt.child.commandShape.reasoningEffort).toBe("high");
  });

  test("retains evidence and marks a non-zero child as worker failure", async () => {
    const setup = await setupFakeCodex({ workerExit: 7 });
    const result = await runSolLunaWorker(setup.options);
    const receipt = await readJson(result.receiptPath);
    const stderr = await Bun.file(join(setup.options.outputDir, "stderr.log")).text();

    expect(result.exitCode).toBe(7);
    expect(receipt.success).toBe(false);
    expect(receipt.harnessError).toBeNull();
    expect((receipt.child as Record<string, unknown>).exitCode).toBe(7);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("worker_failed");
    expect((receipt.artifacts as Record<string, unknown>).stdoutJsonl).toBeTruthy();
    expect((receipt.artifacts as Record<string, unknown>).stderr).toBeTruthy();
    expect(stderr).toContain("fake worker failure");
    expect(await Bun.file(join(setup.options.outputDir, "receipt.json")).exists()).toBe(true);
  });
});
