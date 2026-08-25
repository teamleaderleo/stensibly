import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runSolLunaCli, runSolLunaWorker, type SolLunaWorkerOptions } from "../scripts/sol-luna-worker.js";

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

type FakeCodexMode = "standard" | "hang-with-descendant" | "noisy" | "commit-rename-and-create";

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

  const bodies: Record<FakeCodexMode, string> = {
    standard: standardBody,
    "hang-with-descendant": hangBody,
    noisy: noisyBody,
    "commit-rename-and-create": commitBody,
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
    "--codex-bin", options.codexBin ?? "codex",
    ...(options.timeoutMs === undefined ? [] : ["--timeout-ms", String(options.timeoutMs)]),
    ...(options.captureCapBytes === undefined ? [] : ["--capture-cap-bytes", String(options.captureCapBytes)]),
  ];
}

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

describe("disposable Sol/Luna Codex worker harness", () => {
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
    expect(receipt.schemaVersion).toBe("sol-luna-worker-receipt/2");
    expect(receipt.success).toBe(true);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("worker_succeeded");
    expect((receipt.child as Record<string, unknown>).timedOut).toBe(false);
    expect((receipt.child as Record<string, unknown>).stdinOutcome).toBe("delivered_without_error");
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
      committedPaths: [],
      changedPaths: [],
    });
    expect(Buffer.from(stdin).toString("utf8")).toBe(await Bun.file(setup.options.brief).text());
    expect(args).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      "gpt-5.6-luna",
      "--config",
      'model_reasoning_effort="max"',
      "--sandbox",
      "workspace-write",
      "--cd",
      setup.options.repository,
      "--output-schema",
      setup.options.outputSchema,
      "-",
    ]);
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
});
