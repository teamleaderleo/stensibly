import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  planDeepSeekOpenCodeEpisode,
  type DeepSeekHarnessEffort,
  type DeepSeekHarnessPhase,
} from "../src/deepseek-harness-campaign.js";

const parsed = parseArgs({
  options: {
    episode: { type: "string" },
    phase: { type: "string", default: "observe" },
    effort: { type: "string", default: "high" },
    worktree: { type: "string" },
    runtime: { type: "string" },
    prompt: { type: "string" },
    "wall-seconds": { type: "string" },
    execute: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

const episodeId = required(parsed.values.episode, "--episode");
const worktree = required(parsed.values.worktree, "--worktree");
const runtimeDirectory = required(parsed.values.runtime, "--runtime");
const promptPath = required(parsed.values.prompt, "--prompt");
const prompt = await readFile(promptPath, "utf8");
const wallTimeSeconds = parsed.values["wall-seconds"] === undefined
  ? undefined
  : Number(parsed.values["wall-seconds"]);

const plan = planDeepSeekOpenCodeEpisode({
  episodeId,
  phase: parsed.values.phase as DeepSeekHarnessPhase,
  effort: parsed.values.effort as DeepSeekHarnessEffort,
  worktree,
  runtimeDirectory,
  prompt,
  wallTimeSeconds,
});

console.log(JSON.stringify(plan, null, 2));

if (parsed.values.execute) {
  await execute(plan, prompt);
}

async function execute(
  plan: ReturnType<typeof planDeepSeekOpenCodeEpisode>,
  prompt: string,
): Promise<void> {
  if (!plan.liveExecutionEligible || plan.phase !== "observe") {
    throw new Error("This first campaign executor permits observe episodes only; candidate execution requires an external secret-stripping and egress sandbox");
  }
  if (process.env.STENSIBLY_DEEPSEEK_LIVE !== "1") {
    throw new Error("Live DeepSeek execution requires STENSIBLY_DEEPSEEK_LIVE=1");
  }
  if (process.env.STENSIBLY_DEEPSEEK_ACCEPT_OPENCODE_BUDGET_GAP !== "1") {
    throw new Error(
      "OpenCode reports usage after model turns and cannot enforce the campaign dollar ceiling itself; acknowledge with STENSIBLY_DEEPSEEK_ACCEPT_OPENCODE_BUDGET_GAP=1",
    );
  }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Live DeepSeek execution requires DEEPSEEK_API_KEY");
  await rejectProjectOverrides(plan.worktree, plan.prohibitedProjectPaths);
  await mkdir(plan.runtimeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(plan.configPath, `${JSON.stringify(plan.configuration, null, 2)}\n`, { mode: 0o600 });
  await writeFile(plan.promptFilePath, prompt, { mode: 0o600 });

  const version = Bun.spawnSync(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0) throw new Error("OpenCode is unavailable");
  const observedVersion = new TextDecoder().decode(version.stdout).trim().replace(/^v/u, "");
  if (compareVersions(observedVersion, plan.minimumHarnessVersion) < 0) {
    throw new Error(`OpenCode ${plan.minimumHarnessVersion}+ is required; observed ${observedVersion || "unknown"}`);
  }

  const environment = {
    ...process.env,
    ...plan.environment,
    DEEPSEEK_API_KEY: apiKey,
  };
  const modelProbe = Bun.spawnSync(plan.modelProbeCommand, { env: environment, stdout: "pipe", stderr: "pipe" });
  if (modelProbe.exitCode !== 0) throw new Error("OpenCode DeepSeek model discovery failed");
  const modelOutput = new TextDecoder().decode(modelProbe.stdout);
  if (!modelOutput.split(/\r?\n/u).some((line) => line.trim().startsWith(plan.modelSelector))) {
    throw new Error(`OpenCode did not expose exact model selector ${plan.modelSelector}`);
  }
  await run(plan.runCommand, environment, plan.wallTimeSeconds * 1_000);
}

async function rejectProjectOverrides(worktree: string, patterns: readonly string[]): Promise<void> {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      const entries = await Array.fromAsync(new Bun.Glob(`${prefix}*`).scan({ cwd: worktree, onlyFiles: false, dot: true }));
      if (entries.length > 0) throw new Error(`Live OpenCode execution rejects project-local private/config path ${entries[0]}`);
      continue;
    }
    const candidate = join(worktree, pattern);
    try {
      await lstat(candidate);
      throw new Error(`Live OpenCode execution rejects project-local private/config path ${basename(candidate)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function run(command: readonly string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const child = Bun.spawn(command, {
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      signal: controller.signal,
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}`);
  } finally {
    clearTimeout(timer);
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index]! - rightParts[index]!;
  }
  return 0;
}

function versionParts(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) throw new Error(`Unsupported semantic version: ${value || "empty"}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}
