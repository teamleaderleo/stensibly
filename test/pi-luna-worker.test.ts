import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeVerification } from "../scripts/pi-luna-worker-extension.ts";
import {
  buildEffectiveReadOnlyMounts,
  buildPiResumeCommand,
  buildPiWorkerArgs,
  parsePiOutput,
  piEnvironment,
  runPiLunaWorker,
  type PiLunaWorkerOptions,
} from "../scripts/pi-luna-worker.ts";
import { PI_LUNA_TOOL_NAMES } from "../scripts/pi-luna-worker-contract.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function shell(command: string, args: readonly string[], cwd = process.cwd()): Promise<void> {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command} failed: ${stderr || stdout}`);
}

async function makeRepository(root: string): Promise<string> {
  const repository = join(root, "repository");
  await shell("git", ["init", "-q", repository]);
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await shell("git", ["-C", repository, "add", "tracked.txt"]);
  await shell("git", [
    "-C", repository,
    "-c", "user.name=Pi Luna Test",
    "-c", "user.email=pi-luna@example.invalid",
    "commit", "-q", "-m", "initial",
  ]);
  return repository;
}

async function makeLinkedWorktree(repository: string, root: string): Promise<string> {
  const worktree = join(root, "linked-worktree");
  await shell("git", ["-C", repository, "worktree", "add", "-q", "-b", "pi-luna-linked", worktree]);
  return worktree;
}

interface FakePiSetup {
  readonly root: string;
  readonly repository: string;
  readonly brief: string;
  readonly executable: string;
  readonly argsPath: string;
  readonly envPath: string;
  readonly stdinPath: string;
  readonly descendantPidPath: string;
  readonly options: PiLunaWorkerOptions;
}

type FakePiMode = "ready" | "auth-reject" | "timeout";

function fakePiSource(input: {
  readonly mode: FakePiMode;
  readonly argsPath: string;
  readonly envPath: string;
  readonly stdinPath: string;
  readonly descendantPidPath: string;
  readonly repository: string;
}): string {
  return `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = ${JSON.stringify(input.mode)};
const argsPath = ${JSON.stringify(input.argsPath)};
const envPath = ${JSON.stringify(input.envPath)};
const stdinPath = ${JSON.stringify(input.stdinPath)};
const descendantPidPath = ${JSON.stringify(input.descendantPidPath)};
const repository = ${JSON.stringify(input.repository)};
const args = process.argv.slice(2);
const invocation = { args, env: {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_LUNA_CONFIG_PATH: process.env.PI_LUNA_CONFIG_PATH,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  SECRET_SENTINEL: process.env.SECRET_SENTINEL,
  PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
}, mode };

if (args[0] === "--version") {
  console.log("pi 0.84.4");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "check") {
  appendFileSync(argsPath, JSON.stringify(invocation) + "\\n");
  if (mode === "auth-reject") {
    console.log(JSON.stringify({ status: "not_ready", provider: "openai-codex", reason: "credentials_not_configured" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ready", provider: "openai-codex", authType: "oauth" }));
  process.exit(0);
}

writeFileSync(argsPath, JSON.stringify(args));
writeFileSync(envPath, JSON.stringify(process.env));
writeFileSync(stdinPath, Buffer.from(await new Response(Bun.stdin.stream()).arrayBuffer()));
const sessionId = args[args.indexOf("--session-id") + 1];
if (mode === "timeout") {
  process.on("SIGTERM", () => {});
  const descendant = Bun.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(descendantPidPath, String(descendant.pid));
  console.log(JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: repository }));
  setInterval(() => {}, 10_000);
  await new Promise(() => {});
}

console.log(JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: repository }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "luna_repo_read", args: { path: "tracked.txt" } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 2, output: 1, totalTokens: 3 } } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "luna_repo_read", result: { content: [{ type: "text", text: "ok" }] }, isError: false }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "result-1", toolName: "luna_result", args: {} }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "result-1", toolName: "luna_result", result: { details: {
  status: "complete",
  summary: "fake Pi completed",
  changedPaths: [],
  verification: ["typecheck"],
  remainingLimits: [],
} }, isError: false }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 5, output: 4, totalTokens: 9 } } }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
}

async function setupFakePi(mode: FakePiMode = "ready"): Promise<FakePiSetup> {
  const root = await mkdtemp(join(tmpdir(), "pi-luna-worker-test-"));
  temporaryRoots.push(root);
  const repository = await makeRepository(root);
  const brief = join(root, "brief.md");
  const outputDir = join(root, "evidence");
  const piAgentDir = join(root, "pi-agent");
  const executable = join(root, "fake-pi");
  const argsPath = join(root, "args.json");
  const envPath = join(root, "env.json");
  const stdinPath = join(root, "stdin.bin");
  const descendantPidPath = join(root, "descendant.pid");
  await mkdir(piAgentDir, { mode: 0o700 });
  await writeFile(brief, "Canonical Pi brief bytes\nsecond line\n");
  await writeFile(executable, fakePiSource({ mode, argsPath, envPath, stdinPath, descendantPidPath, repository }));
  await chmod(executable, 0o755);
  const options: PiLunaWorkerOptions = {
    repository,
    brief,
    outputDir,
    runId: "pi-luna-test-01",
    piAgentDir,
    piBin: executable,
    timeoutMs: 5_000,
    captureCapBytes: 64 * 1024,
    editAuthority: "workspace-write",
    osBoundary: "none",
    verificationCommands: [{ id: "typecheck", argv: [process.execPath, "-e", "process.stdout.write('ok')"] }],
  };
  return { root, repository, brief, executable, argsPath, envPath, stdinPath, descendantPidPath, options };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
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

test("piEnvironment forwards only the bounded allowlist and explicit Pi keys", () => {
  const environment = piEnvironment({
    PATH: "/ambient/path",
    HOME: "/ambient/home",
    OPENAI_API_KEY: "must-not-pass",
    SECRET_SENTINEL: "must-not-pass",
    PI_CODING_AGENT_SESSION_DIR: "must-not-pass",
  }, {
    path: "/safe/bin",
    home: "/safe/home",
    tmpdir: "/safe/tmp",
    piAgentDir: "/safe/pi-agent",
    extensionConfigPath: "/safe/config.json",
  });
  expect(environment).toEqual({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    TMPDIR: "/safe/tmp",
    LANG: "C",
    LC_ALL: "C",
    PI_CODING_AGENT_DIR: "/safe/pi-agent",
    PI_LUNA_CONFIG_PATH: "/safe/config.json",
  });
});

test("parsePiOutput sums provider usage and records the terminating result/tool counts", () => {
  const parsed = parsePiOutput([
    JSON.stringify({ type: "session", id: "session-1" }),
    JSON.stringify({ type: "tool_execution_start", toolName: "luna_repo_read" }),
    JSON.stringify({ type: "tool_execution_end", toolName: "luna_repo_read", isError: false }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 3, output: 2, totalTokens: 5 } } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 7, output: 4, totalTokens: 11 } } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "luna_result", result: { details: {
      status: "partial", summary: "bounded", changedPaths: [], verification: [], remainingLimits: ["review"],
    } }, isError: false }),
  ].join("\n"));
  expect(parsed.sessionId).toBe("session-1");
  expect(parsed.usage).toEqual({ input: 10, output: 6, totalTokens: 16 });
  expect(parsed.toolCounts).toEqual({
    started: 1,
    completed: 2,
    failed: 0,
    byName: { luna_repo_read: 1, luna_result: 1 },
    unexpected: [],
  });
  expect(parsed.result).toMatchObject({ status: "partial", summary: "bounded" });
});

test("buildEffectiveReadOnlyMounts preserves declarations, deduplicates paths, and is empty without containment", () => {
  expect(buildEffectiveReadOnlyMounts("bwrap", ["/usr/bin", "/usr/bin/", "/usr/bin"], "/usr/bin")).toEqual(["/usr/bin"]);
  expect(buildEffectiveReadOnlyMounts("none", ["/usr/bin"], "/git/common")).toEqual([]);
});

describe("fake Pi Luna worker", () => {
  test("rejects non-OAuth auth before the worker invocation and publishes a receipt", async () => {
    const setup = await setupFakePi("auth-reject");
    const result = await runPiLunaWorker(setup.options);
    const receipt = await readJson(result.receiptPath);
    const argsLog = await readFile(setup.argsPath, "utf8");

    expect(result.exitCode).toBe(1);
    expect(receipt.success).toBe(false);
    expect((receipt.preflight as Record<string, unknown>).auth).toMatchObject({
      status: "not_ready",
      authType: null,
      ready: false,
    });
    expect(receipt.harnessError).toContain("ready/oauth");
    expect(argsLog).not.toContain("--mode");
    expect(JSON.stringify(receipt)).not.toContain("must-not-pass");
  });

  test("uses the exact reviewed tool surface, isolated session identity, and scrubbed Pi environment", async () => {
    const setup = await setupFakePi();
    const previousSecret = process.env.SECRET_SENTINEL;
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.SECRET_SENTINEL = "secret-from-parent";
    process.env.OPENAI_API_KEY = "api-key-from-parent";
    try {
      const result = await runPiLunaWorker(setup.options);
      const args = JSON.parse(await readFile(setup.argsPath, "utf8")) as string[];
      const environment = await readJson(setup.envPath);
      const receipt = await readJson(result.receiptPath);
      const sessionDir = (receipt.pi as Record<string, unknown>).session as Record<string, unknown>;
      const expectedArgs = buildPiWorkerArgs(
        sessionDir.directory as string,
        sessionDir.requestedId as string,
      );

      expect(result.exitCode).toBe(0);
      expect(receipt.success).toBe(true);
      expect(args).toEqual([...expectedArgs]);
      expect(args[args.indexOf("--model") + 1]).toBe("openai-codex/gpt-5.6-luna");
      expect(args[args.indexOf("--thinking") + 1]).toBe("max");
      expect(args[args.indexOf("--tools") + 1]).toBe(PI_LUNA_TOOL_NAMES.join(","));
      expect(args.filter((arg) => arg === "--extension")).toHaveLength(1);
      expect(args).toContain("--no-builtin-tools");
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--no-skills");
      expect(args).toContain("--no-prompt-templates");
      expect(args).toContain("--no-themes");
      expect(args).toContain("--no-context-files");
      expect(environment).toMatchObject({ PI_CODING_AGENT_DIR: setup.options.piAgentDir });
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.SECRET_SENTINEL).toBeUndefined();
      expect(environment.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
      expect(await readFile(setup.stdinPath, "utf8")).toBe(await readFile(setup.brief, "utf8"));
      expect((receipt.pi as Record<string, unknown>).version).toBe("0.84.4");
      expect((receipt.pi as Record<string, unknown>).provider).toBe("openai-codex");
      expect((receipt.pi as Record<string, unknown>).model).toBe("gpt-5.6-luna");
      expect((receipt.pi as Record<string, unknown>).reasoningEffort).toBe("max");
      expect((receipt.invocation as Record<string, unknown>).boundary).toMatchObject({
        mode: "none",
        bwrapBin: null,
      });
      expect((receipt.pi as Record<string, unknown>).resume).toMatchObject({
        command: buildPiResumeCommand(
          setup.executable,
          sessionDir.directory as string,
          sessionDir.requestedId as string,
        ),
        identity: { sessionId: sessionDir.requestedId, directory: sessionDir.directory },
      });
      expect(receipt.usage).toEqual({ input: 7, output: 5, totalTokens: 12 });
      expect(receipt.toolCounts).toMatchObject({ started: 2, completed: 2, failed: 0 });
    } finally {
      if (previousSecret === undefined) delete process.env.SECRET_SENTINEL;
      else process.env.SECRET_SENTINEL = previousSecret;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test("auto-mounts a linked worktree Git common directory and records the effective receipt identity", async () => {
    const setup = await setupFakePi();
    const worktree = await makeLinkedWorktree(setup.repository, setup.root);
    const commonDirectory = await realpath(join(setup.repository, ".git"));
    const verificationPath = [dirnameOf(process.execPath), "/usr/bin", "/bin"].join(":");
    const explicitMounts = ["/usr/bin", "/usr/bin/"];
    const result = await runPiLunaWorker({
      ...setup.options,
      repository: worktree,
      osBoundary: "bwrap",
      bwrapBin: setup.executable,
      verificationPath,
      verificationExecutableDirs: explicitMounts,
    });
    const receipt = await readJson(result.receiptPath);
    const boundary = (receipt.invocation as Record<string, unknown>).boundary as Record<string, unknown>;
    const expectedMounts = [...new Set(verificationPath.split(":")), commonDirectory];

    expect(result.exitCode).toBe(0);
    expect(receipt.success).toBe(true);
    expect(receipt.repository).toBe(await realpath(worktree));
    expect(boundary).toMatchObject({
      mode: "bwrap",
      bwrapBin: setup.executable,
      readOnlyMounts: expectedMounts,
    });
    expect((boundary.readOnlyMounts as readonly string[]).filter((path) => path === commonDirectory)).toHaveLength(1);
  });

  test("fails closed with a bounded receipt when Git metadata cannot be resolved", async () => {
    const setup = await setupFakePi();
    const notARepository = join(setup.root, "not-a-repository");
    await mkdir(notARepository);

    const result = await runPiLunaWorker({ ...setup.options, repository: notARepository });
    const receipt = await readJson(result.receiptPath);

    expect(result.exitCode).toBe(1);
    expect(receipt.success).toBe(false);
    expect(receipt.harnessError).toContain("Git common directory resolution failed");
    expect((receipt.harnessError as string).length).toBeLessThanOrEqual(500);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("not_started");
    expect((receipt.invocation as Record<string, unknown>).boundary).toMatchObject({
      mode: "none",
      readOnlyMounts: [],
    });
    await expect(lstat(setup.argsPath)).rejects.toThrow();
  });

  test("times out and kills a fake Pi process group with its descendant", async () => {
    const setup = await setupFakePi("timeout");
    const startedAt = Date.now();
    const result = await runPiLunaWorker({ ...setup.options, timeoutMs: 200 });
    const elapsed = Date.now() - startedAt;
    const receipt = await readJson(result.receiptPath);
    const descendantPid = Number.parseInt((await readFile(setup.descendantPidPath, "utf8")).trim(), 10);

    expect(result.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(10_000);
    expect(receipt.success).toBe(false);
    expect((receipt.child as Record<string, unknown>).outcome).toBe("timeout");
    expect((receipt.child as Record<string, unknown>).timedOut).toBe(true);
    expect(await waitFor(() => !pidAlive(descendantPid), 5_000)).toBe(true);
  });

  test("refuses an immutable attempt directory and preserves its prior receipt", async () => {
    const setup = await setupFakePi();
    const first = await runPiLunaWorker(setup.options);
    const before = await readFile(first.receiptPath, "utf8");
    await expect(runPiLunaWorker({ ...setup.options, runId: "pi-luna-test-02" })).rejects.toThrow("managed attempt artifact");
    expect(await readFile(first.receiptPath, "utf8")).toBe(before);
    expect(await readdir(setup.options.outputDir)).toContain("receipt.json");
  });

  test("keeps PI_CODING_AGENT_DIR out of extension verification children", async () => {
    const setup = await setupFakePi();
    const command = [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({ agent: process.env.PI_CODING_AGENT_DIR ?? null, config: process.env.PI_LUNA_CONFIG_PATH ?? null, secret: process.env.SECRET_SENTINEL ?? null }))",
    ];
    const config = {
      schemaVersion: "pi-luna-extension/1" as const,
      repository: setup.repository,
      editAuthority: "read-only" as const,
      toolOutputCapBytes: 4096,
      fileReadCapBytes: 4096,
      toolTimeoutMs: 1000,
      osBoundary: "none" as const,
      bwrapBin: null,
      toolPath: "/usr/bin:/bin",
      toolHome: join(setup.root, "home"),
      toolTmpdir: join(setup.root, "tmp"),
      verificationExecutableDirs: [dirnameOf(process.execPath)],
      verificationCommands: [{ id: "env", argv: command }],
    };
    await mkdir(config.toolHome, { mode: 0o700 });
    await mkdir(config.toolTmpdir, { mode: 0o700 });
    const result = await executeVerification(config, "env");
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("agent");
    expect(text).toContain("config");
    expect(text).not.toContain(setup.options.piAgentDir);
    expect(text).not.toContain("SECRET_SENTINEL");
  });
});

function dirnameOf(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
}
