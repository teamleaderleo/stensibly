import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, symlink, unlink, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ANTIGRAVITY_ENVIRONMENT_KEYS,
  antigravityEnvironment,
  admitSubscriptionAuthFile,
  mountSubscriptionAuthFile,
  subscriptionAuthLinkIntact,
  buildAntigravityArgs,
  parseAntigravityStream,
  parseQuotaText,
  quotaDelta,
  runAntigravityGeminiWorker,
} from "../scripts/antigravity-gemini-worker";
import { projectAntigravityEconomics } from "../scripts/antigravity-gemini-accounting";
import { ANTIGRAVITY_MODEL } from "../scripts/antigravity-gemini-worker-contract";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function command(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function setupFakeAgy(mode: "ready" | "auth-failed" | "exit-failed" | "signal-failed" | "auth-replaced" = "ready") {
  // Auth admission deliberately rejects shared writable ancestors such as /tmp.
  const root = await mkdtemp(join(process.cwd(), ".antigravity-worker-test-"));
  roots.push(root);
  const repository = join(root, "repository");
  const outputParent = join(root, "attempts");
  const outputDir = join(outputParent, "attempt-1");
  const brief = join(root, "brief.md");
  const agyBin = join(root, "agy");
  const envLog = join(root, "env.json");
  const argsLog = join(root, "args.json");
  const quotaCount = join(root, "quota-count.txt");
  await mkdir(repository);
  await mkdir(outputParent);
  await writeFile(join(repository, "README.md"), "before\n");
  await writeFile(brief, "Change README.md from before to after.\n");
  await command(repository, ["git", "init", "-q"]);
  await command(repository, ["git", "config", "user.name", "Test"]);
  await command(repository, ["git", "config", "user.email", "test@example.invalid"]);
  await command(repository, ["git", "add", "README.md"]);
  await command(repository, ["git", "commit", "-qm", "base"]);
  await command(repository, ["git", "remote", "add", "origin", "git@github.com:teamleaderleo/example.git"]);

  const source = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));
if (args.includes("--version")) { console.log("1.1.22"); process.exit(0); }
if (args[0] === "models") {
  if (${JSON.stringify(mode)} === "auth-failed") { console.error("Please sign in"); process.exit(1); }
  console.log("${ANTIGRAVITY_MODEL} Gemini 3.7 Flash (High)"); process.exit(0);
}
if (args.includes("/usage")) {
  const count = existsSync(${JSON.stringify(quotaCount)}) ? Number(readFileSync(${JSON.stringify(quotaCount)}, "utf8")) : 0;
  writeFileSync(${JSON.stringify(quotaCount)}, String(count + 1));
  const remaining = count === 0 ? 96 : 94;
  console.log("Gemini 3.7 Flash (High) 5-hour: " + remaining + "% remaining resets 2026-09-01T05:00:00Z");
  console.log("Gemini 3.7 Flash (High) weekly: 88% remaining resets 2026-09-07T00:00:00Z");
  process.exit(0);
}
writeFileSync(${JSON.stringify(envLog)}, JSON.stringify(process.env));
let input = "";
for await (const chunk of Bun.stdin.stream()) input += new TextDecoder().decode(chunk);
const event = JSON.parse(input.trim());
if (!event.message.content.includes("Change README.md")) process.exit(9);
writeFileSync("README.md", "after\\n");
console.log(JSON.stringify({event:"init",conversation_id:"conv-1",init:{cwd:process.cwd(),tools:["read_file","write_to_file","run_command"],permission_mode:"request-review",model:"${ANTIGRAVITY_MODEL}"}}));
console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"conv-1",step_index:0,state:"DONE",step_type:"user_input"}}));
console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"conv-1",step_index:1,state:"DONE",step_type:"tool",tool_name:"write_to_file",duration_seconds:0.1}}));
console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"conv-1",step_index:2,state:"DONE",step_type:"agent_response",duration_seconds:0.2,usage:{input_tokens:12,output_tokens:8,thinking_tokens:3,cache_read_tokens:4,total_tokens:20}}}));
console.log(JSON.stringify({event:"result",result:{conversation_id:"conv-1",status:"SUCCESS",response:"done",duration_seconds:0.4,num_turns:1,structured_output:{status:"complete",summary:"Changed the file",changed_paths:["README.md"],verification_attempts:[],remaining_limits:["External verification required"]},usage:{input_tokens:12,output_tokens:8,thinking_tokens:3,cache_read_tokens:4,total_tokens:20}}}));
if (${JSON.stringify(mode)} === "auth-replaced") {
  const auth = process.env.HOME + "/.gemini/antigravity-cli/antigravity-oauth-token";
  unlinkSync(auth); writeFileSync(auth, "fictional-new-profile", { mode: 0o600 });
}
if (${JSON.stringify(mode)} === "exit-failed") process.exit(7);
if (${JSON.stringify(mode)} === "signal-failed") process.kill(process.pid, "SIGTERM");
`;
  await writeFile(agyBin, source, { mode: 0o700 });
  await chmod(agyBin, 0o700);
  return { root, repository, outputDir, brief, agyBin, envLog, argsLog };
}

test("Antigravity arguments pin Gemini Flash High, high effort, sandbox, and stream JSON", () => {
  const args = buildAntigravityArgs("/admitted/workspace");
  expect(args.slice(0, 2)).toEqual(["--add-dir", "/admitted/workspace"]);
  expect(args).toContain(ANTIGRAVITY_MODEL);
  expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
  expect(args).toContain("--sandbox");
  expect(args).toContain("--disable-slash-commands");
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args.slice(2, 6)).toEqual(["--input-format", "stream-json", "--output-format", "stream-json"]);
});

test("environment forwards only the auth/runtime allowlist and never API keys", () => {
  const environment = antigravityEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    XDG_RUNTIME_DIR: "/run/user/1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
    GEMINI_API_KEY: "must-not-pass",
    GOOGLE_API_KEY: "must-not-pass",
    SECRET_SENTINEL: "must-not-pass",
  });
  expect(environment).toMatchObject({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    XDG_RUNTIME_DIR: "/run/user/1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
  });
  expect(Object.keys(environment).every(key => (ANTIGRAVITY_ENVIRONMENT_KEYS as readonly string[]).includes(key))).toBe(true);
  expect(environment.GEMINI_API_KEY).toBeUndefined();
  expect(environment.GOOGLE_API_KEY).toBeUndefined();
  expect(environment.SECRET_SENTINEL).toBeUndefined();
});

test("stream parser records exact token classes and step counts", () => {
  const parsed = parseAntigravityStream([
    JSON.stringify({ event: "init", init: { model: ANTIGRAVITY_MODEL, permission_mode: "request-review", tools: ["read_file"] } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "read_file" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response" } }),
    JSON.stringify({ event: "result", result: {
      conversation_id: "conv", status: "SUCCESS", response: "ok", duration_seconds: 1.25, num_turns: 1,
      structured_output: { status: "complete", summary: "ok", changed_paths: [], verification_attempts: [], remaining_limits: [] },
      usage: { input_tokens: 101, cache_read_tokens: 80, output_tokens: 11, thinking_tokens: 7, total_tokens: 112 },
    } }),
  ].join("\n"));
  expect(parsed.usage).toEqual({
    inputTokens: 101,
    cachedInputTokens: 80,
    outputTokens: 11,
    reasoningTokens: 7,
    totalRecordedTokens: 112,
  });
  expect(parsed.stepCount).toBe(2);
  expect(parsed.toolCounts).toEqual({ read_file: 1 });
  expect(parsed.result?.status).toBe("complete");
});

test("quota parser preserves remaining percentages and derives only same-generation deltas", () => {
  const before = parseQuotaText(
    "Gemini 3.7 Flash (High) 5-hour: 96% remaining resets 2026-09-01T05:00:00Z\nGemini weekly: 88% remaining resets 2026-09-07T00:00:00Z\n",
    "2026-09-01T01:00:00Z",
  );
  const after = parseQuotaText(
    "Gemini 3.7 Flash (High) 5-hour: 94% remaining resets 2026-09-01T05:00:00Z\nGemini weekly: 88% remaining resets 2026-09-07T00:00:00Z\n",
    "2026-09-01T01:10:00Z",
  );
  expect(before.parseState).toBe("recorded");
  expect(before.observations[0]).toMatchObject({
    windowClass: "five_hour",
    windowMinutes: 300,
    usedPercent: null,
    remainingPercent: 96,
  });
  expect(quotaDelta(before, after, "five_hour")).toBe(2);
  expect(quotaDelta(before, after, "weekly")).toBe(0);
});

describe("fake Antigravity worker", () => {
  test("runs one task-private edit and emits a bounded provisional receipt", async () => {
    const setup = await setupFakeAgy();
    const previousSecret = process.env.SECRET_SENTINEL;
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    process.env.SECRET_SENTINEL = "parent-secret";
    process.env.GEMINI_API_KEY = "api-key";
    try {
      const run = await runAntigravityGeminiWorker({
        repository: setup.repository,
        brief: setup.brief,
        outputDir: setup.outputDir,
        runId: "gemini-test-1",
        nodeId: "big-red",
        nodeGeneration: 7,
        agyBin: setup.agyBin,
      });
      const receipt = JSON.parse(await readFile(run.receiptPath, "utf8"));
      const environment = JSON.parse(await readFile(setup.envLog, "utf8"));
      const args = JSON.parse(await readFile(setup.argsLog, "utf8"));
      expect(run.exitCode).toBe(0);
      expect(receipt.success).toBe(true);
      expect(receipt.harness).toMatchObject({
        provider: "google-antigravity",
        authClass: "google-account-subscription",
        model: ANTIGRAVITY_MODEL,
        reasoningEffort: "high",
        accountSessionReady: true,
      });
      expect(receipt.source).toMatchObject({
        repositoryIdentity: "teamleaderleo/example",
        cleanBefore: true,
        cleanAfter: false,
        changedPaths: ["README.md"],
      });
      expect(receipt.usage).toEqual({
        inputTokens: 12,
        cachedInputTokens: 4,
        outputTokens: 8,
        reasoningTokens: 3,
        totalRecordedTokens: 20,
      });
      expect(receipt.economics).toMatchObject({
        fiveHourQuotaDeltaPercent: 2,
        weeklyQuotaDeltaPercent: 0,
        acceptedOutcome: "unknown",
        tokensPerAcceptedTask: null,
      });
      expect(receipt.provisional.verificationOutcome).toBe("unknown");
      expect(receipt.activity).toMatchObject({ requests: 1, turns: 1, steps: 3, toolSteps: 1 });
      expect(args).toEqual(["-p", "/usage", "--output-format", "text"]);
      expect(environment.GEMINI_API_KEY).toBeUndefined();
      expect(environment.SECRET_SENTINEL).toBeUndefined();
      expect(JSON.stringify(receipt)).not.toContain("parent-secret");
      expect(await readFile(join(setup.repository, "README.md"), "utf8")).toBe("after\n");
      const envelope = await projectAntigravityEconomics({
        receipt: run.receiptPath,
        output: join(setup.root, "unused.json"),
        usageSampleId: "gemini-test-1",
        acceptedOutcome: "accepted",
        verificationOutcome: "passed",
        operatorInterventionMinutes: 2,
        cleanupRework: "none",
        collectedAt: "2026-09-01T02:00:00Z",
      });
      expect(envelope.samples[0]).toMatchObject({
        provider: "google-antigravity",
        harness: "agy",
        usage_sample_id: "gemini-test-1",
        accepted_outcome: "accepted",
        verification_outcome: "passed",
        five_hour_quota_delta_percent: 2,
        weekly_quota_delta_percent: 0,
        operator_intervention_minutes: 2,
      });
      expect(JSON.stringify(envelope)).not.toContain(setup.repository);
      await expect(
        projectAntigravityEconomics({
          receipt: run.receiptPath,
          output: join(setup.root, "unused-2.json"),
          usageSampleId: "gemini-test-1",
          acceptedOutcome: "accepted",
          verificationOutcome: "not_run",
          operatorInterventionMinutes: 0,
          cleanupRework: "none",
        })
      ).rejects.toThrow("require passed external verification");
    } finally {
      if (previousSecret === undefined) delete process.env.SECRET_SENTINEL;
      else process.env.SECRET_SENTINEL = previousSecret;
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
    }
  });

  test("fails closed before worker launch when subscription auth is unavailable", async () => {
    const setup = await setupFakeAgy("auth-failed");
    const run = await runAntigravityGeminiWorker({
      repository: setup.repository,
      brief: setup.brief,
      outputDir: setup.outputDir,
      runId: "gemini-test-auth",
      nodeId: "big-red",
      nodeGeneration: 8,
      agyBin: setup.agyBin,
    });
    expect(run.exitCode).toBe(1);
    expect(run.receipt.success).toBe(false);
    expect(run.receipt.harness.accountSessionReady).toBe(false);
    expect(run.receipt.child.outcome).toBe("not_started");
    expect(run.receipt.harnessError).toContain("subscription session is not ready");
    expect(run.receipt.usage.totalRecordedTokens).toBeNull();
  });
});

for (const mode of ["exit-failed", "signal-failed"] as const) {
  test(`worker rejects a SUCCESS event followed by ${mode}`, async () => {
    const setup = await setupFakeAgy(mode);
    const run = await runAntigravityGeminiWorker({
      repository: setup.repository,
      brief: setup.brief,
      outputDir: setup.outputDir,
      runId: `test-${mode}`,
      nodeId: "big-red",
      nodeGeneration: 1,
      agyBin: setup.agyBin,
    });
    const receipt = JSON.parse(await readFile(run.receiptPath, "utf8"));
    expect(run.exitCode).not.toBe(0);
    expect(receipt.workerResult.status).toBe("complete");
    expect(receipt.success).toBe(false);
    expect(receipt.child.outcome).toBe("worker_failed");
    expect(receipt.harnessError).toContain("process did not exit cleanly");
    expect(receipt.provisional.acceptedOutcome).toBe("unknown");
    if (mode === "exit-failed") expect(receipt.child.exitCode).toBe(7);
    else expect(receipt.child.signal).toBe("SIGTERM");
  });
}

async function setupAuthFixture() {
  const setup = await setupFakeAgy();
  const auth = join(setup.root, "subscription-profile");
  await writeFile(auth, "fictional-profile-before", { mode: 0o600 });
  return { ...setup, auth };
}

test("explicit auth link preserves source refresh and cleans only the disposable home", async () => {
  const setup = await setupAuthFixture();
  const admitted = await admitSubscriptionAuthFile(setup.auth, setup.repository, setup.outputDir);
  const home = join(setup.root, "isolated-home");
  await mkdir(home, { mode: 0o700 });
  const target = await mountSubscriptionAuthFile(home, admitted);
  expect(await subscriptionAuthLinkIntact(target, admitted)).toBe(true);
  await writeFile(target, "fictional-profile-refreshed");
  expect(await readFile(setup.auth, "utf8")).toBe("fictional-profile-refreshed");
  await rm(home, { recursive: true });
  expect((await lstat(setup.auth)).isFile()).toBe(true);
  expect(await readFile(setup.auth, "utf8")).toBe("fictional-profile-refreshed");
});

test("atomic profile replacement is classified for protected recovery", async () => {
  const setup = await setupAuthFixture();
  const home = join(setup.root, "isolated-home");
  await mkdir(home, { mode: 0o700 });
  const target = await mountSubscriptionAuthFile(home, setup.auth);
  await unlink(target);
  await writeFile(target, "fictional-new-profile", { mode: 0o600 });
  expect(await subscriptionAuthLinkIntact(target, setup.auth)).toBe(false);
  expect(await readFile(setup.auth, "utf8")).toBe("fictional-profile-before");
});

test("auth admission rejects shared, symlinked, workspace and writable-parent profiles", async () => {
  const setup = await setupAuthFixture();
  await chmod(setup.auth, 0o644);
  await expect(admitSubscriptionAuthFile(setup.auth, setup.repository, setup.outputDir)).rejects.toThrow("private operator-owned");
  await chmod(setup.auth, 0o600);
  const link = join(setup.root, "profile-link");
  await symlink(setup.auth, link);
  await expect(admitSubscriptionAuthFile(link, setup.repository, setup.outputDir)).rejects.toThrow("private operator-owned");
  await expect(admitSubscriptionAuthFile(setup.auth, setup.root, setup.outputDir)).rejects.toThrow("private operator-owned");
  await chmod(setup.root, 0o777);
  await expect(admitSubscriptionAuthFile(setup.auth, setup.repository, setup.outputDir)).rejects.toThrow("private operator-owned");
  await chmod(setup.root, 0o700);
});

test("worker records auth mechanism without source path or profile bytes and preserves source", async () => {
  const setup = await setupAuthFixture();
  const run = await runAntigravityGeminiWorker({
    repository: setup.repository, brief: setup.brief, outputDir: setup.outputDir,
    runId: "explicit-auth", nodeId: "big-red", nodeGeneration: 1,
    agyBin: setup.agyBin, subscriptionAuthFile: setup.auth,
  });
  const receiptText = await readFile(run.receiptPath, "utf8");
  const receipt = JSON.parse(receiptText);
  expect(receipt.success).toBe(true);
  expect(receipt.invocation.environment.subscriptionAuth).toBe("explicit-file-link");
  expect(receipt.invocation.environment.protectedAuthRecoveryRequired).toBe(false);
  expect(receiptText).not.toContain(setup.auth);
  expect(receiptText).not.toContain(setup.repository);
  expect(receipt.invocation.args.slice(0, 2)).toEqual(["--add-dir", "<admitted-workspace>"]);
  expect(receiptText).not.toContain("fictional-profile-before");
  expect(await readFile(setup.auth, "utf8")).toBe("fictional-profile-before");
  await expect(lstat(join(setup.outputDir, ".agy-home"))).rejects.toThrow();
});

test("worker retains an atomically refreshed auth profile for explicit recovery", async () => {
  const setup = await setupFakeAgy("auth-replaced");
  const auth = join(setup.root, "subscription-profile");
  await writeFile(auth, "fictional-original-profile", { mode: 0o600 });
  const run = await runAntigravityGeminiWorker({
    repository: setup.repository, brief: setup.brief, outputDir: setup.outputDir,
    runId: "auth-refresh-recovery", nodeId: "big-red", nodeGeneration: 1,
    agyBin: setup.agyBin, subscriptionAuthFile: auth,
  });
  const receipt = JSON.parse(await readFile(run.receiptPath, "utf8"));
  expect(run.exitCode).not.toBe(0);
  expect(receipt.success).toBe(false);
  expect(receipt.invocation.environment.protectedAuthRecoveryRequired).toBe(true);
  expect(await readFile(auth, "utf8")).toBe("fictional-original-profile");
  expect(await readFile(join(setup.outputDir, ".agy-home/.gemini/antigravity-cli/antigravity-oauth-token"), "utf8")).toBe("fictional-new-profile");
});
