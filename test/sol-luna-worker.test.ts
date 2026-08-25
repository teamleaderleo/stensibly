import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  codexEnvironment,
  preflightRequiredCommands,
  resolveSpawnCommand,
  runSolLunaCli,
  runSolLunaWorker,
  type SolLunaWorkerOptions,
} from "../scripts/sol-luna-worker.js";
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
  readonly options: SolLunaWorkerOptions;
}

type FakeCodexMode = "standard" | "hang-with-descendant" | "noisy" | "block-stderr-artifact" | "write-untracked" | "commit-rename-and-create" | "commit-baseline-dirty" | "commit-revert" | "rewind" | "clean" | "break-git";

async function shell(command: string, args: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
  readonly mode?: FakeCodexMode;
  readonly descendantPidPath?: string;
  readonly noisyChunks?: number;
  readonly repository?: string;
  readonly outputDir?: string;
}): string {
  const preamble = `#!/usr/bin/env bun
const argsPath = ${JSON.stringify(input.argsPath)};
const stdinPath = ${JSON.stringify(input.stdinPath)};
const resultPath = ${JSON.stringify(input.resultPath)};
const authMode = ${JSON.stringify(input.authMode)};
const workerExit = ${input.workerExit};
const mode = ${JSON.stringify(input.mode ?? "standard")};
const descendantPidPath = ${JSON.stringify(input.descendantPidPath ?? "")};
const noisyChunks = ${input.noisyChunks ?? 0};
const repository = ${JSON.stringify(input.repository ?? "")};
const outputDir = ${JSON.stringify(input.outputDir ?? "")};

if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (authMode === "chatgpt") console.log("Logged in using ChatGPT");
  else console.log("Logged in using API key");
  process.exit(authMode === "chatgpt" ? 0 : 1);
}

function emitSession() {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fake-01" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: require("node:fs").readFileSync(resultPath, "utf8") },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 21, cached_input_tokens: 4, output_tokens: 13, total_tokens: 34 },
  }));
}
`;

  const standardBody = `
if (argsPath) await Bun.write(argsPath, JSON.stringify(process.argv.slice(2)));
if (stdinPath) await Bun.write(stdinPath, await Bun.stdin.text());
if (resultPath) emitSession();
else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fail-01" }));
}
if (workerExit !== 0) console.error("fake worker failure");
process.exit(workerExit);
`;

  const hangBody = `
process.on("SIGTERM", () => {});
const grandchild = Bun.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore" });
await Bun.write(descendantPidPath, String(grandchild.pid));
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-hang-01" }));
setInterval(() => {}, 10_000);
`;

  const noisyBody = `
const junk = "j".repeat(4096) + "\\n";
for (let i = 0; i < noisyChunks; i++) {
  process.stdout.write(junk);
  if (i % 64 === 63) await Bun.sleep(1);
}
for (let i = 0; i < noisyChunks; i++) {
  process.stderr.write(junk);
  if (i % 64 === 63) await Bun.sleep(1);
}
emitSession();
await Bun.sleep(20);
process.exit(0);
`;

  const writeUntrackedBody = `
require("node:fs").writeFileSync(repository + "/worker-untracked.txt", "worker replacement\\n");
emitSession();
process.exit(0);
`;

  const blockStderrArtifactBody = `
require("node:fs").mkdirSync(outputDir + "/stderr.log");
emitSession();
process.exit(workerExit);
`;

  const commitBody = `
require("node:fs").writeFileSync(repository + "/worker-new.txt", "worker bytes\\n");
function git(args) {
  const r = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) throw new Error("fake git failed: git " + args.join(" "));
}
git(["add", "worker-new.txt"]);
git(["mv", "alpha.txt", "beta.txt"]);
git(["-c", "user.name=Fake Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "worker change"]);
require("node:fs").writeFileSync(repository + "/worker-untracked.txt", "untracked\\n");
emitSession();
process.exit(0);
`;

  const commitBaselineDirtyBody = `
require("node:fs").writeFileSync(repository + "/tracked.txt", "worker replacement\\n");
const commit = Bun.spawnSync([
  "git", "-C", repository, "add", "tracked.txt",
]);
if (commit.exitCode !== 0) throw new Error("fake git add failed");
const result = Bun.spawnSync([
  "git", "-C", repository, "-c", "user.name=Fake Worker", "-c", "user.email=worker@example.invalid",
  "commit", "-q", "-m", "commit contaminated baseline",
]);
if (result.exitCode !== 0) throw new Error("fake git commit failed");
emitSession();
process.exit(0);
`;

  const rewindBody = `
const reset = Bun.spawnSync(["git", "-C", repository, "reset", "--hard", "HEAD^"], { stdout: "ignore", stderr: "ignore" });
if (reset.exitCode !== 0) throw new Error("fake git rewind failed");
emitSession();
process.exit(0);
`;

  const cleanBody = `
require("node:fs").unlinkSync(repository + "/worker-untracked.txt");
emitSession();
process.exit(0);
`;

  const commitRevertBody = `
require("node:fs").writeFileSync(repository + "/worker-new.txt", "worker bytes\\n");
function git(args) {
  const r = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) throw new Error("fake git failed: git " + args.join(" "));
}
git(["add", "worker-new.txt"]);
git(["-c", "user.name=Fake Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "worker add"]);
require("node:fs").unlinkSync(repository + "/worker-new.txt");
git(["add", "worker-new.txt"]);
git(["-c", "user.name=Fake Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "worker revert"]);
emitSession();
process.exit(0);
`;

  const breakGitBody = `
require("node:fs").renameSync(repository + "/.git", repository + "/.git-broken");
emitSession();
process.exit(0);
`;

  const bodies: Record<FakeCodexMode, string> = {
    standard: standardBody,
    "hang-with-descendant": hangBody,
    noisy: noisyBody,
    "block-stderr-artifact": blockStderrArtifactBody,
    "write-untracked": writeUntrackedBody,
    "commit-rename-and-create": commitBody,
    "commit-baseline-dirty": commitBaselineDirtyBody,
    "commit-revert": commitRevertBody,
    rewind: rewindBody,
    clean: cleanBody,
    "break-git": breakGitBody,
  };
  return `${preamble}${bodies[input.mode ?? "standard"]}`;
}

async function setupFakeCodex(overrides: Partial<{
  readonly authMode: "chatgpt" | "api-key";
  readonly workerExit: number;
  readonly mode: FakeCodexMode;
  readonly descendantPidPath: string;
  readonly noisyChunks: number;
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
  await mkdirRepository(repository);
  if (overrides.mode === "rewind") {
    await writeFile(join(repository, "tracked.txt"), "second commit\n");
    await shell("git", ["-C", repository, "add", "tracked.txt"], process.cwd());
    await shell(
      "git",
      ["-C", repository, "-c", "user.name=Sol Luna Test", "-c", "user.email=sol-luna@example.invalid", "commit", "-q", "-m", "second"],
      process.cwd(),
    );
  }
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
    mode: overrides.mode ?? "standard",
    descendantPidPath: overrides.descendantPidPath ?? "",
    noisyChunks: overrides.noisyChunks ?? 0,
    repository,
    outputDir,
  }));
  await chmod(executable, 0o755);
  return {
    root,
    executable,
    argsPath,
    stdinPath,
    resultPath,
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
    ...(options.editAuthority === undefined ? [] : ["--edit-authority", options.editAuthority]),
    ...(options.gitMetadataAuthority === undefined ? [] : ["--git-metadata-authority", options.gitMetadataAuthority]),
    ...(options.reasoningEffort === undefined ? [] : ["--reasoning-effort", options.reasoningEffort]),
    ...(options.requiredCommands ?? []).flatMap((command) => ["--require-command", command]),
    "--codex-bin", options.codexBin ?? "codex",
    ...(options.timeoutMs === undefined ? [] : ["--timeout-ms", String(options.timeoutMs)]),
    ...(options.captureCapBytes === undefined ? [] : ["--capture-cap-bytes", String(options.captureCapBytes)]),
    ...(options.gitTimeoutMs === undefined ? [] : ["--git-timeout-ms", String(options.gitTimeoutMs)]),
  ];
}

test("codexEnvironment only forwards the explicit non-secret allowlist", () => {
  const environment = codexEnvironment({
    PATH: "/safe/bin", HOME: "/safe/home", CODEX_HOME: "/safe/codex",
    OPENAI_API_KEY: "secret", EVIL_PARENT_VARIABLE: "must-not-pass",
  });
  expect(environment).toEqual({ PATH: "/safe/bin", HOME: "/safe/home", CODEX_HOME: "/safe/codex" });
});

test("required command preflight uses only the effective worker PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-command-preflight-"));
  temporaryRoots.push(root);
  const executable = join(root, "bounded-tool");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await mkdir(join(root, "directory-tool"));

  expect(await preflightRequiredCommands(["bounded-tool", "directory-tool", "missing-tool"], root)).toEqual([
    { command: "bounded-tool", status: "available", resolvedPath: executable },
    { command: "directory-tool", status: "missing", resolvedPath: null },
    { command: "missing-tool", status: "missing", resolvedPath: null },
  ]);
});

test("permission-profile compilation and receipt identity are deterministic and path-minimised", () => {
  const profile = compileCodexPermissionProfile({
    repository: "/secret/repository", gitDir: "/secret/git/worktree", commonGitDir: "/secret/git/common",
    runtimeDir: "/secret/runtime", outputDir: "/secret/evidence", workspaceAccess: "read",
  });
  const liveArgs = permissionProfileConfigArgs(profile);
  const receiptArgs = permissionProfileReceiptArgs(profile);
  expect(profile.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(profile.config).toContain('\":root\"=\"deny\"');
  expect(profile.config).toContain('network={enabled=false}');
  expect(liveArgs).toContain("--strict-config");
  expect(receiptArgs.join(" ")).toContain(profile.fingerprint);
  expect(receiptArgs.join(" ")).not.toContain("/secret/");
});

test("permission-profile support requires a recent exact Codex CLI version", () => {
  expect(parseSupportedCodexCliVersion("codex-cli 0.146.0\n")).toBe("0.146.0");
  expect(parseSupportedCodexCliVersion("codex-cli 0.137.9\n")).toBeNull();
  expect(parseSupportedCodexCliVersion("codex 0.146.0\n")).toBeNull();
});

test("permission-profile confinement rejects direct workspace writes", async () => {
  const setup = await setupFakeCodex();
  await expect(runSolLunaWorker({ ...setup.options, confinement: "permission-profile" })).rejects.toThrow("patch-as-data");
  expect(await Bun.file(setup.options.outputDir).exists()).toBe(false);
});

test("current confinement modes reject unsupported Git metadata write authority", async () => {
  const setup = await setupFakeCodex();
  await expect(runSolLunaWorker({ ...setup.options, gitMetadataAuthority: "write" })).rejects.toThrow(
    "legacy-sandbox confinement does not grant Git metadata write",
  );
  expect(await Bun.file(setup.options.outputDir).exists()).toBe(false);
});

test("permission-profile confinement rejects system-temp evidence before side effects", async () => {
  const setup = await setupFakeCodex();
  await expect(runSolLunaWorker({
    ...setup.options, sandbox: "read-only", confinement: "permission-profile", editAuthority: "read-only",
  })).rejects.toThrow("system temp");
  expect(await Bun.file(setup.options.outputDir).exists()).toBe(false);
  expect(await Bun.file(`${setup.options.outputDir}.runtime`).exists()).toBe(false);
});

test("permission-profile confinement resolves symlinks before overlap admission", async () => {
  const setup = await setupFakeCodex();
  const alias = join(setup.root, "repository-alias");
  await symlink(setup.options.repository, alias);
  await expect(runSolLunaWorker({
    ...setup.options,
    outputDir: join(alias, "evidence"),
    sandbox: "read-only",
    confinement: "permission-profile",
    editAuthority: "read-only",
  })).rejects.toThrow("overlap the repository");
  expect(await Bun.file(join(setup.options.repository, "evidence")).exists()).toBe(false);
});

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(stepMs);
  }
  return predicate();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCliInCwd(
  options: SolLunaWorkerOptions,
  cwd: string,
  env?: Record<string, string>,
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  const scriptPath = join(import.meta.dir, "..", "scripts", "sol-luna-worker.ts");
  const cli = Bun.spawn([process.execPath, scriptPath, ...cliArgs(options)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  return { exitCode, stdoutText, stderrText };
}

function hostilePayloadSource(markerPath: string): string {
  return `#!/bin/sh
printf 'hostile-executed\\n' >> ${JSON.stringify(markerPath)}
exit 97
`;
}

describe("disposable Sol/Luna Codex worker harness", () => {
  test("preserves a pre-existing runtime sibling and records a harness failure", async () => {
    const setup = await setupFakeCodex();
    const runtimeRoot = `${setup.options.outputDir}.runtime`;
    const sentinel = join(runtimeRoot, "sentinel.txt");
    await mkdir(runtimeRoot);
    await writeFile(sentinel, "commander-owned\n");

    const result = await runSolLunaWorker({ ...setup.options, requiredCommands: ["git"] });

    expect(result.receipt.child.outcome).toBe("harness_failed");
    expect(result.receipt.harnessError).toContain("unable to claim worker runtime");
    expect(result.receipt.preflight.requiredCommands).toEqual([{
      command: "git", status: "not_run", resolvedPath: null,
    }]);
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

  test("fails before authentication when a brief-required command is unavailable", async () => {
    const setup = await setupFakeCodex();
    const result = await runSolLunaWorker({
      ...setup.options,
      requiredCommands: ["definitely-not-a-sol-luna-command"],
    });
    const receipt = await readJson(result.receiptPath);
    const preflight = receipt.preflight as Record<string, unknown>;

    expect(result.exitCode).toBe(1);
    expect(receipt.harnessError).toContain("required worker commands unavailable");
    expect(preflight.chatGptAuthenticated).toBe(false);
    expect(preflight.requiredCommands).toEqual([{
      command: "definitely-not-a-sol-luna-command",
      status: "missing",
      resolvedPath: null,
    }]);
    expect(await Bun.file(setup.argsPath).exists()).toBe(false);
  });

  test("captures successful worker evidence, exact stdin bytes, thread ID, usage, and Git state", async () => {
    const setup = await setupFakeCodex();
    const exitCode = await runSolLunaCli(cliArgs({
      ...setup.options,
      requiredCommands: ["sh", "git", "sh"],
    }));
    const receipt = await readJson(join(setup.options.outputDir, "receipt.json"));
    const args = await Bun.file(setup.argsPath).json() as string[];
    const stdin = await Bun.file(setup.stdinPath).bytes();
    const stdout = await Bun.file(join(setup.options.outputDir, "stdout.jsonl")).bytes();
    const workerResult = await Bun.file(join(setup.options.outputDir, "worker-result.json")).json();

    expect(exitCode).toBe(0);
    expect(receipt.schemaVersion).toBe("sol-luna-worker-receipt/3");
    expect(receipt.success).toBe(true);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("worker_succeeded");
    expect((receipt.child as Record<string, unknown>).timedOut).toBe(false);
    expect((receipt.child as Record<string, unknown>).stdinOutcome).toBe("delivered_without_error");
    expect((receipt.preflight as Record<string, unknown>).requiredCommands).toEqual([
      { command: "git", status: "available", resolvedPath: expect.stringMatching(/\/git$/u) },
      { command: "sh", status: "available", resolvedPath: expect.stringMatching(/\/sh$/u) },
    ]);
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
      dirtyPathsBefore: [],
      dirtyPathsAfter: [],
      workerCreatedDirtyPaths: [],
      commitsMade: [],
      committedPaths: [],
      changedPaths: [],
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
    expect(args).toContain("--sandbox");
    expect(args).toContain(setup.options.repository);
    expect(args).toContain(setup.options.outputSchema);
    expect(workerResult).toMatchObject({ worker_ref: "thread-fake-01" });
    const stdoutArtifact = (receipt.artifacts as Record<string, unknown>).stdoutJsonl as Record<string, unknown>;
    expect(stdoutArtifact).toMatchObject({
      path: join(setup.options.outputDir, "stdout.jsonl"),
      bytes: stdout.byteLength,
      sha256: artifactHash(stdout),
      truncated: false,
      fullOutputBytes: stdout.byteLength,
      omittedBytes: 0,
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

  test("never publishes metadata for an artifact that was not retained", async () => {
    const setup = await setupFakeCodex({ mode: "block-stderr-artifact" });

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.child.outcome).toBe("harness_failed");
    expect(result.receipt.harnessError).toContain("unable to retain stderr artifact");
    expect(result.receipt.artifacts.stdoutJsonl).not.toBeNull();
    expect(result.receipt.artifacts.stderr).toBeNull();
    expect(result.receipt.artifacts.finalWorkerResult).not.toBeNull();
    expect(await Bun.file(join(setup.options.outputDir, "stdout.jsonl")).exists()).toBe(true);
    expect(await readdir(join(setup.options.outputDir, "stderr.log"))).toEqual([]);
    expect(await Bun.file(join(setup.options.outputDir, "worker-result.json")).exists()).toBe(true);
  });

  test("retains worker and harness failure evidence without collapsing their causes", async () => {
    const setup = await setupFakeCodex({ mode: "block-stderr-artifact", workerExit: 7 });

    const result = await runSolLunaWorker(setup.options);

    expect(result.exitCode).toBe(1);
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.child.exitCode).toBe(7);
    expect(result.receipt.child.outcome).toBe("worker_failed");
    expect(result.receipt.harnessError).toContain("unable to retain stderr artifact");
    expect(result.receipt.artifacts.stderr).toBeNull();
  });

  test("a large brief delivered to a child that exits without reading stdin cannot crash the CLI or contradict the receipt", async () => {
    const setup = await setupFakeCodex({ mode: "standard" });
    // Do not let the fake capture stdin: it exits without draining the pipe.
    const noStdinSource = fakeCodexSource({
      argsPath: setup.argsPath,
      stdinPath: "",
      resultPath: setup.resultPath,
      authMode: "chatgpt",
      workerExit: 0,
    });
    await writeFile(setup.executable, noStdinSource);
    await chmod(setup.executable, 0o755);
    const oversizedBrief = join(setup.root, "oversized-brief.md");
    await writeFile(oversizedBrief, Buffer.alloc(8 * 1024 * 1024, 0x61));

    const scriptPath = join(import.meta.dir, "..", "scripts", "sol-luna-worker.ts");
    const cli = Bun.spawn([process.execPath, scriptPath, ...cliArgs({
      ...setup.options,
      brief: oversizedBrief,
    })], { stdout: "pipe", stderr: "pipe" });
    const [cliStdout, cliStderr, cliExitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    expect(cliExitCode).toBe(0);
    expect(cliStderr).not.toContain("EPIPE");
    const receipt = await readJson(join(setup.options.outputDir, "receipt.json"));
    expect(receipt.success).toBe(true);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("worker_succeeded");
    expect((receipt.child as Record<string, unknown>).exitCode).toBe(0);
    expect((receipt.child as Record<string, unknown>).stdinOutcome).toBe("child_closed_stdin_early");
    expect(String((receipt.child as Record<string, unknown>).stdinDetail)).toContain("EPIPE");
    expect(cliStdout.trim()).toBe("");
  });

  test("a hung child with a live descendant times out, reaps the whole tree, and writes truthful partial evidence", async () => {
    const setup = await setupFakeCodex({ mode: "hang-with-descendant" });
    const descendantPidPath = join(setup.root, "descendant.pid");
    const noStdinSource = fakeCodexSource({
      argsPath: "",
      stdinPath: "",
      resultPath: "",
      authMode: "chatgpt",
      workerExit: 0,
      mode: "hang-with-descendant",
      descendantPidPath,
    });
    await writeFile(setup.executable, noStdinSource);
    await chmod(setup.executable, 0o755);

    const startedAt = Date.now();
    const result = await runSolLunaWorker({ ...setup.options, timeoutMs: 500 });
    const elapsed = Date.now() - startedAt;
    const receipt = await readJson(result.receiptPath);

    expect(elapsed).toBeLessThan(15_000);
    expect(result.exitCode).toBe(124);
    expect(receipt.success).toBe(false);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("timeout");
    expect((receipt.child as Record<string, unknown>).timedOut).toBe(true);
    expect((receipt.codex as Record<string, unknown>).threadId).toBe("thread-hang-01");

    const partialStdout = await Bun.file(join(setup.options.outputDir, "stdout.jsonl")).text();
    expect(partialStdout).toContain("thread-hang-01");

    const descendantPidText = await Bun.file(descendantPidPath).text();
    expect(descendantPidText.trim()).not.toBe("");
    const descendantPid = Number.parseInt(descendantPidText.trim(), 10);
    const descendantReaped = await waitFor(() => !pidAlive(descendantPid), 10_000);
    expect(descendantReaped).toBe(true);
  });

  test("noisy children cannot grow retention beyond the configured cap and truncation is disclosed deterministically", async () => {
    const setup = await setupFakeCodex({ mode: "noisy", noisyChunks: 600 });
    const capBytes = 256 * 1024;
    const result = await runSolLunaWorker({ ...setup.options, captureCapBytes: capBytes });
    const receipt = await readJson(result.receiptPath);
    const retainedStdout = await Bun.file(join(setup.options.outputDir, "stdout.jsonl")).bytes();

    expect(result.exitCode).toBe(0);
    expect(receipt.success).toBe(true);
    const emittedBytes = 600 * (4096 + 1);
    const stdoutArtifact = (receipt.artifacts as Record<string, unknown>).stdoutJsonl as Record<string, unknown>;
    const stderrArtifact = (receipt.artifacts as Record<string, unknown>).stderr as Record<string, unknown>;
    expect(stdoutArtifact.truncated).toBe(true);
    expect(stdoutArtifact.fullOutputBytes).toBeGreaterThan(capBytes);
    expect(stdoutArtifact.omittedBytes).toBeGreaterThan(0);
    expect(stdoutArtifact.bytes).toBeLessThanOrEqual(capBytes);
    expect(stdoutArtifact.sha256).toBe(artifactHash(retainedStdout));
    expect(retainedStdout.byteLength).toBe(stdoutArtifact.bytes as number);
    expect(stderrArtifact.truncated).toBe(true);
    expect(stderrArtifact.omittedBytes).toBeGreaterThan(0);
    expect(stderrArtifact.bytes).toBeLessThanOrEqual(capBytes);
    // Head/tail diagnostics survive: the first event and final usage stay parseable.
    const noisyCodex = receipt.codex as { readonly threadId?: string };
    expect(noisyCodex.threadId).toBe("thread-fake-01");
    expect((receipt.codex as Record<string, unknown>).tokenUsage).toMatchObject({ total_tokens: 34 });
    expect(await Bun.file(join(setup.options.outputDir, "worker-result.json")).exists()).toBe(true);
  });

  test("a failing rerun in a reused output directory removes stale success evidence before launch", async () => {
    const setup = await setupFakeCodex();
    const firstRun = await runSolLunaWorker(setup.options);
    expect(firstRun.receipt.success).toBe(true);
    const workerResultPath = join(setup.options.outputDir, "worker-result.json");
    expect(await Bun.file(workerResultPath).exists()).toBe(true);

    const secondOptions: SolLunaWorkerOptions = {
      ...setup.options,
      runId: "sol-luna-2026-08-25-02-rerun",
      codexBin: setup.executable,
    };
    const failingSource = fakeCodexSource({
      argsPath: "",
      stdinPath: "",
      resultPath: "",
      authMode: "chatgpt",
      workerExit: 3,
    });
    await writeFile(setup.executable, failingSource);
    await chmod(setup.executable, 0o755);

    const secondRun = await runSolLunaWorker(secondOptions);
    const receipt = await readJson(secondRun.receiptPath);

    expect(secondRun.exitCode).toBe(3);
    const rerunReceiptRun = receipt.run as { readonly id?: string };
    expect(rerunReceiptRun.id).toBe("sol-luna-2026-08-25-02-rerun");
    expect(receipt.success).toBe(false);
    expect(await Bun.file(workerResultPath).exists()).toBe(false);
    const entries = await readdir(setup.options.outputDir);
    expect(entries.filter((entry) => entry.startsWith(".sol-luna-worker-tmp-"))).toEqual([]);
    expect(entries.sort()).toEqual(["receipt.json", "stderr.log", "stdout.jsonl"]);
  });

  test("fails before launch when stale managed artifacts cannot be cleared", async () => {
    const setup = await setupFakeCodex();
    const staleReceipt = join(setup.options.outputDir, "receipt.json");
    await mkdir(setup.options.outputDir, { recursive: true });
    await writeFile(staleReceipt, "stale\n");
    await chmod(setup.options.outputDir, 0o555);
    try {
      await expect(runSolLunaWorker(setup.options)).rejects.toThrow();
      expect(await Bun.file(setup.argsPath).exists()).toBe(false);
    } finally {
      await chmod(setup.options.outputDir, 0o755);
    }
    expect(await Bun.file(staleReceipt).text()).toBe("stale\n");
  });

  test("failed receipt publication cleans its temporary file and reports the exact target", async () => {
    const setup = await setupFakeCodex();
    await mkdir(setup.options.outputDir, { recursive: true });
    await chmod(setup.options.outputDir, 0o555);
    try {
      let publishedError: Error | null = null;
      try {
        await runSolLunaWorker(setup.options);
      } catch (error) {
        publishedError = error instanceof Error ? error : new Error(String(error));
      }
      expect(publishedError).not.toBeNull();
      expect(publishedError?.message).toContain("unable to publish receipt");
    } finally {
      await chmod(setup.options.outputDir, 0o755);
    }
    const entries = await readdir(setup.options.outputDir);
    expect(entries.filter((entry) => entry.startsWith(".sol-luna-worker-tmp-"))).toEqual([]);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("pre-existing dirty and untracked paths are reported separately from worker-caused changes", async () => {
    const setup = await setupFakeCodex({ mode: "commit-rename-and-create" });
    const repository = setup.options.repository;
    await writeFile(join(repository, "tracked.txt"), "pre-existing local modification\n");
    await writeFile(join(repository, "stray.txt"), "pre-existing untracked file\n");
    await writeFile(join(repository, "alpha.txt"), "rename source\n");
    await shell("git", ["-C", repository, "add", "alpha.txt"], process.cwd());
    await shell(
      "git",
      ["-C", repository, "-c", "user.name=Sol Luna Test", "-c", "user.email=sol-luna@example.invalid", "commit", "-q", "-m", "add alpha"],
      process.cwd(),
    );

    const result = await runSolLunaWorker(setup.options);
    const receipt = await readJson(result.receiptPath);
    const git = receipt.git as Record<string, readonly string[]>;

    expect(result.exitCode).toBe(0);
    expect(git.dirtyPathsBefore).toContain("tracked.txt");
    expect(git.dirtyPathsBefore).toContain("stray.txt");
    expect(git.dirtyPathsAfter).toContain("tracked.txt");
    expect(git.dirtyPathsAfter).toContain("stray.txt");
    expect(git.dirtyPathsAfter).toContain("worker-untracked.txt");
    expect(git.commitsMade).toHaveLength(1);
    // Rename coverage keeps both old and new names.
    expect(git.committedPaths).toEqual(["alpha.txt", "beta.txt", "worker-new.txt"].sort());
    // The worker delta excludes pre-existing dirt but includes worker effects.
    expect(git.changedPaths).toEqual(
      ["alpha.txt", "beta.txt", "worker-new.txt", "worker-untracked.txt"].sort(),
    );
    expect(git.changedPaths).not.toContain("tracked.txt");
    expect(git.changedPaths).not.toContain("stray.txt");
    expect(git.headBefore).not.toBe(git.headAfter);
  });

  test("attributes changed content on a path that was already dirty before the run", async () => {
    const setup = await setupFakeCodex({ mode: "write-untracked" });
    await writeFile(join(setup.options.repository, "worker-untracked.txt"), "baseline bytes\n");

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.git.dirtyPathsBefore).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.dirtyPathsAfter).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.workerCreatedDirtyPaths).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.changedPaths).toEqual(["worker-untracked.txt"]);
  });

  test("attributes changed staged and unstaged state on an already dirty path", async () => {
    const setup = await setupFakeCodex({ mode: "write-untracked" });
    const target = join(setup.options.repository, "worker-untracked.txt");
    await writeFile(target, "staged baseline\n");
    await shell("git", ["-C", setup.options.repository, "add", "worker-untracked.txt"], process.cwd());
    await writeFile(target, "unstaged baseline\n");

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.git.dirtyPathsBefore).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.workerCreatedDirtyPaths).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.changedPaths).toEqual(["worker-untracked.txt"]);
  });

  test("attributes cleanup when the worker removes a baseline-dirty path", async () => {
    const setup = await setupFakeCodex({ mode: "clean" });
    await writeFile(join(setup.options.repository, "worker-untracked.txt"), "baseline bytes\n");

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.git.dirtyPathsBefore).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.dirtyPathsAfter).toEqual([]);
    expect(result.receipt.git.workerCreatedDirtyPaths).toEqual(["worker-untracked.txt"]);
    expect(result.receipt.git.changedPaths).toEqual(["worker-untracked.txt"]);
  });

  test("marks committed paths whose baseline bytes were already dirty as contaminated", async () => {
    const setup = await setupFakeCodex({ mode: "commit-baseline-dirty" });
    await writeFile(join(setup.options.repository, "tracked.txt"), "pre-existing local modification\n");

    const result = await runSolLunaWorker(setup.options);
    const git = result.receipt.git;

    expect(git.headRelationship).toBe("descendant");
    expect(git.commitsMade).toHaveLength(1);
    expect(git.dirtyPathsBefore).toEqual(["tracked.txt"]);
    expect(git.committedPaths).toEqual(["tracked.txt"]);
    expect(git.baselineContaminatedCommittedPaths).toEqual(["tracked.txt"]);
    expect(git.changedPaths).toEqual(["tracked.txt"]);
  });

  test("retains committed activity when later commits restore the baseline tree", async () => {
    const setup = await setupFakeCodex({ mode: "commit-revert" });

    const result = await runSolLunaWorker(setup.options);
    const git = result.receipt.git;

    expect(git.headRelationship).toBe("descendant");
    expect(git.commitsMade).toHaveLength(2);
    expect(git.committedPaths).toEqual(["worker-new.txt"]);
    expect(git.dirtyPathsAfter).toEqual([]);
    expect(git.workerCreatedDirtyPaths).toEqual([]);
    expect(git.changedPaths).toEqual(["worker-new.txt"]);
  });

  test("fails closed on non-descendant head movement", async () => {
    const setup = await setupFakeCodex({ mode: "rewind" });

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.git.headBefore).not.toBe(result.receipt.git.headAfter);
    expect(result.receipt.git.headRelationship).toBe("non_descendant");
    expect(result.receipt.git.committedPaths).toEqual([]);
    expect(result.receipt.git.changedPaths).toEqual([]);
    expect(result.receipt.harnessError).toContain("not a descendant");
    expect(result.receipt.child.outcome).toBe("harness_failed");
  });

  test("fails closed when final Git state is unreadable", async () => {
    const setup = await setupFakeCodex({ mode: "break-git" });

    const result = await runSolLunaWorker(setup.options);

    expect(result.receipt.git.headAfter).toBeNull();
    expect(result.receipt.git.headRelationship).toBe("unknown");
    expect(result.receipt.git.commitsMade).toEqual([]);
    expect(result.receipt.git.workerCreatedDirtyPaths).toEqual([]);
    expect(result.receipt.git.changedPaths).toEqual([]);
    expect(result.receipt.harnessError).toContain("unable to read final Git state");
    expect(result.receipt.child.outcome).toBe("harness_failed");
  });
});

describe("spawn command resolution safety (#1666)", () => {
  test("bare argv[0] names are returned unchanged for OS PATH lookup", async () => {
    expect(await resolveSpawnCommand(["git", "-c", "core.fsmonitor=false", "status"])).toEqual([
      "git", "-c", "core.fsmonitor=false", "status",
    ]);
    expect(await resolveSpawnCommand(["codex", "exec", "--json"])).toEqual(["codex", "exec", "--json"]);
    expect(await resolveSpawnCommand(["git"])).toEqual(["git"]);
  });

  test("path-like scripts expand to interpreter plus one identical absolute inspected target", async () => {
    const root = await mkdtemp(join(tmpdir(), "sol-luna-resolve-"));
    temporaryRoots.push(root);
    const script = join(root, "entry.sh");
    await writeFile(script, "#!/bin/sh\nprintf '%s\\n' \"$0\"\n");
    await chmod(script, 0o755);
    const relativeScript = relative(process.cwd(), script);

    const absoluteExpansion = await resolveSpawnCommand([script, "--flag"]);
    expect(absoluteExpansion[0]).toBe("/bin/sh");
    expect(absoluteExpansion[1]).toBe(script);
    expect(absoluteExpansion[2]).toBe("--flag");

    // The identical absolute target is what the interpreter receives as the
    // script argument, regardless of how the caller spelled the path.
    const relativeExpansion = await resolveSpawnCommand([relativeScript]);
    expect(relativeExpansion).toEqual(["/bin/sh", script]);
  });

  test("shebang interpreter arguments are preserved between interpreter and script target", async () => {
    const root = await mkdtemp(join(tmpdir(), "sol-luna-resolve-arg-"));
    temporaryRoots.push(root);
    const script = join(root, "strict.sh");
    await writeFile(script, "#!/bin/sh -e\nexit 0\n");
    await chmod(script, 0o755);

    expect(await resolveSpawnCommand([script])).toEqual(["/bin/sh", "-e", script]);
  });

  test("non-script path-like executables keep their arguments and become absolute", async () => {
    expect(await resolveSpawnCommand(["/bin/echo", "hi"])).toEqual(["/bin/echo", "hi"]);
  });

  test("chained path-like shebangs stay bounded and pass each original target onward", async () => {
    const root = await mkdtemp(join(tmpdir(), "sol-luna-resolve-chain-"));
    temporaryRoots.push(root);
    const outer = join(root, "outer.sh");
    const inner = join(root, "inner.sh");
    await writeFile(outer, `#!${inner}\nexit 0\n`);
    await writeFile(inner, "#!/bin/sh\nexit 0\n");
    await chmod(outer, 0o755);
    await chmod(inner, 0o755);

    expect(await resolveSpawnCommand([outer])).toEqual(["/bin/sh", inner, outer]);
  });

  test("coordinator-CWD files named git and codex with shebang payloads are neither read nor executed", async () => {
    const setup = await setupFakeCodex();
    const hostileRoot = await mkdtemp(join(tmpdir(), "sol-luna-hostile-cwd-"));
    temporaryRoots.push(hostileRoot);
    const gitMarker = join(hostileRoot, "git-marker.txt");
    const codexMarker = join(hostileRoot, "codex-marker.txt");
    for (const [name, marker] of [["git", gitMarker], ["codex", codexMarker]] as const) {
      await writeFile(join(hostileRoot, name), hostilePayloadSource(marker));
      await chmod(join(hostileRoot, name), 0o755);
    }

    // The worker subprocess runs with its coordinator CWD inside hostileRoot,
    // so any bare-name inspection or expansion would read or execute these.
    const { exitCode } = await runCliInCwd(setup.options, hostileRoot);
    const receipt = await readJson(join(setup.options.outputDir, "receipt.json"));

    expect(exitCode).toBe(0);
    expect(receipt.success).toBe(true);
    expect(receipt.git).toMatchObject({ headBefore: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(await Bun.file(gitMarker).exists()).toBe(false);
    expect(await Bun.file(codexMarker).exists()).toBe(false);
  });

  test("coordinator-CWD FIFOs named git and codex prove bare names are never opened for inspection", async () => {
    const setup = await setupFakeCodex();
    const hostileRoot = await mkdtemp(join(tmpdir(), "sol-luna-hostile-fifo-"));
    temporaryRoots.push(hostileRoot);
    // Opening a FIFO for reading blocks forever until a writer appears, so any
    // reintroduced bare-name peek would hang the observation deterministically
    // instead of completing. The bounded race below turns that into a fast,
    // deterministic failure rather than a stuck suite.
    for (const name of ["git", "codex"]) {
      await shell("mkfifo", [join(hostileRoot, name)], process.cwd());
    }
    const raced = await Promise.race([
      runCliInCwd(setup.options, hostileRoot).then((result) => ({ kind: "completed" as const, result })),
      Bun.sleep(25_000).then(() => ({ kind: "hung" as const })),
    ]);

    expect(raced.kind).toBe("completed");
    if (raced.kind === "completed") {
      const receipt = await readJson(join(setup.options.outputDir, "receipt.json"));
      expect(raced.result.exitCode).toBe(0);
      expect(receipt.success).toBe(true);
    }
  });

  test("a shebang-wrapped codexBin is executed through its exact inspected absolute target", async () => {
    const setup = await setupFakeCodex();
    const wrapperPath = join(setup.root, "wrapper codex;[safe]");
    const executedLog = join(setup.root, "executed-targets.log");
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      `printf '%s\\n' "$0" >> ${JSON.stringify(executedLog)}`,
      `exec ${JSON.stringify(setup.executable)} "$@"`,
      "",
    ].join("\n"));
    await chmod(wrapperPath, 0o755);

    const result = await runSolLunaWorker({ ...setup.options, codexBin: wrapperPath });

    expect(result.exitCode).toBe(0);
    expect(result.receipt.success).toBe(true);
    const executedTargets = (await Bun.file(executedLog).text()).split("\n").filter((line) => line.length > 0);
    // The preflight and the worker child both went through the wrapper, and sh
    // recorded exactly the inspected absolute target as its script argument.
    expect(executedTargets.length).toBeGreaterThanOrEqual(2);
    for (const target of executedTargets) expect(target).toBe(wrapperPath);
  });
});

describe("bounded noninteractive Git observations (#1666)", () => {
  interface FakeGitInjection {
    readonly binDir: string;
    readonly logPath: string;
    readonly pidPath?: string;
  }

  async function injectFakeGit(
    root: string,
    body: string,
  ): Promise<FakeGitInjection> {
    const probe = Bun.spawnSync(["sh", "-c", "command -v git"], { stdout: "pipe", stderr: "pipe" });
    const realGit = probe.stdout.toString().trim();
    if (probe.exitCode !== 0 || realGit.length === 0) throw new Error("real git binary unavailable for delegation");
    const binDir = join(root, "fake-git-bin");
    await mkdir(binDir);
    const logPath = join(root, "git-observations.log");
    const source = [
      "#!/bin/sh",
      `printf '%s\\n' "prompt=\${GIT_TERMINAL_PROMPT-UNSET} nosystem=\${GIT_CONFIG_NOSYSTEM-UNSET} global=\${GIT_CONFIG_GLOBAL-UNSET} cmd=$*" >> ${JSON.stringify(logPath)}`,
      body.replace("@REAL_GIT@", JSON.stringify(realGit)),
      "",
    ].join("\n");
    await writeFile(join(binDir, "git"), source);
    await chmod(join(binDir, "git"), 0o755);
    return { binDir, logPath };
  }

  function prependedPath(binDir: string): string {
    return `${binDir}:${process.env.PATH ?? ""}`;
  }

  async function withPathOverride<T>(path: string, run: () => Promise<T>): Promise<T> {
    const originalPath = process.env.PATH;
    process.env.PATH = path;
    try {
      return await run();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  }

  test("every Git observation runs noninteractively with neutralized config through one capture lifecycle", async () => {
    const setup = await setupFakeCodex();
    const injection = await injectFakeGit(setup.root, `exec @REAL_GIT@ "$@"`);
    // A modified tracked path plus an untracked path forces the per-path
    // diff/hash-object observations to run alongside the metadata probes.
    await writeFile(join(setup.options.repository, "tracked.txt"), "locally modified\n");
    await writeFile(join(setup.options.repository, "scratch-untracked.txt"), "untracked\n");
    const result = await withPathOverride(prependedPath(injection.binDir), () =>
      runSolLunaWorker(setup.options));
    const lines = (await Bun.file(injection.logPath).text()).split("\n").filter((line) => line.length > 0);

    expect(result.exitCode).toBe(0);
    expect(lines.length).toBeGreaterThanOrEqual(9);
    for (const line of lines) {
      expect(line).toContain("prompt=0");
      expect(line).toContain("nosystem=1");
      expect(line).toContain("global=/dev/null");
    }
    const observed = lines.map((line) => line.slice(line.indexOf("cmd=") + 4));
    const hasObservation = (...fragments: string[]) =>
      observed.some((command) => fragments.every((fragment) => command.includes(fragment)));
    // Metadata probes, snapshot, per-path diffs, hash-object: all present.
    expect(hasObservation("--git-dir")).toBe(true);
    expect(hasObservation("--git-common-dir")).toBe(true);
    expect(hasObservation("--git-path", "HEAD")).toBe(true);
    expect(hasObservation("--git-path", "index")).toBe(true);
    expect(hasObservation("rev-parse", "HEAD")).toBe(true);
    expect(hasObservation("status", "--porcelain=v1")).toBe(true);
    expect(hasObservation("diff", "--cached")).toBe(true);
    expect(hasObservation("diff", "--binary")).toBe(true);
    expect(hasObservation("hash-object", "--no-filters")).toBe(true);
  });

  test("a hung Git observation fails bounded via --git-timeout-ms without success or empty output", async () => {
    const setup = await setupFakeCodex();
    const injection = await injectFakeGit(setup.root, [
      `printf '%s\\n' "$$" > ${JSON.stringify(join(setup.root, "fake-git.pid"))}`,
      "sleep 30",
    ].join("\n"));
    const startedAt = Date.now();
    const { exitCode } = await runCliInCwd(
      { ...setup.options, gitTimeoutMs: 500 },
      setup.root,
      { PATH: prependedPath(injection.binDir) },
    );
    const elapsed = Date.now() - startedAt;
    const receipt = await readJson(join(setup.options.outputDir, "receipt.json"));

    expect(elapsed).toBeLessThan(15_000);
    expect(exitCode).toBe(1);
    expect(receipt.success).toBe(false);
    expect(String(receipt.harnessError)).toContain("timed out after 500ms");
    expect(receipt.git).toMatchObject({
      headBefore: null,
      headAfter: null,
      headRelationship: "unknown",
      changedPaths: [],
      commitsMade: [],
    });
    expect(receipt.child).toMatchObject({ outcome: "harness_failed" });

    const fakePid = Number.parseInt((await Bun.file(join(setup.root, "fake-git.pid")).text()).trim(), 10);
    expect(Number.isSafeInteger(fakePid)).toBe(true);
    expect(await waitFor(() => !pidAlive(fakePid), 10_000)).toBe(true);
  });

  test("Git spawn errors stay unknown relationship and never become non-descendant state", async () => {
    const setup = await setupFakeCodex();
    const emptyBin = join(setup.root, "empty-bin");
    await mkdir(emptyBin);
    const result = await withPathOverride(emptyBin, () => runSolLunaWorker(setup.options));
    const receipt = result.receipt;

    expect(result.exitCode).toBe(1);
    expect(receipt.success).toBe(false);
    expect(receipt.harnessError).toContain("unable to read Git state");
    expect(receipt.git.headBefore).toBeNull();
    expect(receipt.git.headAfter).toBeNull();
    // A missing git binary is an observation failure, not evidence of a
    // non-descendant head movement.
    expect(receipt.git.headRelationship).toBe("unknown");
    expect(receipt.git.commitsMade).toEqual([]);
    expect(receipt.git.committedPaths).toEqual([]);
    expect(receipt.child.outcome).toBe("harness_failed");
  });

  test("a failing merge-base ancestry probe stays unknown and never becomes non-descendant state", async () => {
    const setup = await setupFakeCodex({ mode: "rewind" });
    const injection = await injectFakeGit(setup.root, [
      'for arg in "$@"; do',
      '  if [ "$arg" = "merge-base" ]; then',
      "    exit 127",
      "  fi",
      "done",
      'exec @REAL_GIT@ "$@"',
    ].join("\n"));
    const result = await withPathOverride(prependedPath(injection.binDir), () =>
      runSolLunaWorker(setup.options));
    const receipt = result.receipt;

    // The rewind moved HEAD off-branch; ancestry could not be established
    // because the merge-base probe failed, which must stay "unknown".
    expect(receipt.git.headBefore).not.toBeNull();
    expect(receipt.git.headAfter).not.toBeNull();
    expect(receipt.git.headRelationship).toBe("unknown");
    expect(String(receipt.harnessError)).toContain("unable to establish Git head ancestry (exit 127)");
  });
});
