import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
}): string {
  return `#!/usr/bin/env bun
const argsPath = ${JSON.stringify(input.argsPath)};
const stdinPath = ${JSON.stringify(input.stdinPath)};
const resultPath = ${JSON.stringify(input.resultPath)};
const authMode = ${JSON.stringify(input.authMode)};
const workerExit = ${input.workerExit};

if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (authMode === "chatgpt") console.log("Logged in using ChatGPT");
  else console.log("Logged in using API key");
  process.exit(authMode === "chatgpt" ? 0 : 1);
}

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
  ];
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
