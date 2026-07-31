import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const DEEPSEEK_HARNESS_CAMPAIGN_V1 = 1 as const;

export const deepSeekHarnessEfforts = ["high", "max"] as const;
export type DeepSeekHarnessEffort = typeof deepSeekHarnessEfforts[number];

export const deepSeekHarnessPhases = ["simulation", "observe", "candidate"] as const;
export type DeepSeekHarnessPhase = typeof deepSeekHarnessPhases[number];

export const deepSeekHarnessCandidates = ["opencode", "claude-code", "codex"] as const;
export type DeepSeekHarnessCandidate = typeof deepSeekHarnessCandidates[number];

export interface DeepSeekUsageInput {
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  outputTokens: number;
}

export interface DeepSeekOpenCodePlanInput {
  episodeId: string;
  phase: DeepSeekHarnessPhase;
  effort: DeepSeekHarnessEffort;
  worktree: string;
  runtimeDirectory: string;
  prompt: string;
  wallTimeSeconds?: number;
}

export interface DeepSeekOpenCodeLaunchPlan {
  version: typeof DEEPSEEK_HARNESS_CAMPAIGN_V1;
  episodeId: string;
  harness: "opencode";
  minimumHarnessVersion: string;
  provider: "deepseek";
  modelAlias: "deepseek-v4-flash";
  modelSelector: "deepseek/deepseek-v4-flash";
  targetReleaseLabel: "DeepSeek-V4-Flash-0731";
  releaseIdentityStatus: "provider_receipt_required";
  phase: DeepSeekHarnessPhase;
  effort: DeepSeekHarnessEffort;
  worktree: string;
  runtimeDirectory: string;
  wallTimeSeconds: number;
  maximumAgentSteps: number;
  liveExecutionEligible: false;
  externalSandboxRequired: boolean;
  requiredBeforeLive: readonly string[];
  promptFilePath: string;
  promptReceipt: {
    digest: string;
    utf8Bytes: number;
  };
  configPath: string;
  configuration: Readonly<Record<string, unknown>>;
  modelProbeCommand: readonly string[];
  runCommand: readonly string[];
  environment: Readonly<Record<string, string>>;
  prohibitedProjectPaths: readonly string[];
  budget: {
    dailyMicroUsd: number;
    episodeMicroUsd: number;
    enforcedByHarness: false;
    liveExecutionDefault: "disabled";
  };
  authority: {
    providerCall: false;
    githubWrite: false;
    merge: false;
    deployment: false;
    credentialRead: false;
    canonicalStateWrite: false;
  };
}

const MICRO_USD_PER_USD = 1_000_000;
const PRICE_MICRO_USD_PER_MILLION = Object.freeze({
  cacheHitInput: 2_800,
  cacheMissInput: 140_000,
  output: 280_000,
});

const budget = Object.freeze({
  dailyMicroUsd: MICRO_USD_PER_USD,
  episodeMicroUsd: 100_000,
  highPoolMicroUsd: 700_000,
  maxPoolMicroUsd: 200_000,
  reserveMicroUsd: 100_000,
});

const evalScenarios = Object.freeze([
  Object.freeze({ id: "repository-survey", taskClass: "analysis", deterministicGate: "source-linked findings" }),
  Object.freeze({ id: "focused-test-repair", taskClass: "implementation", deterministicGate: "focused and canonical tests" }),
  Object.freeze({ id: "exact-head-review", taskClass: "review", deterministicGate: "observed/inferred/unobserved separation" }),
  Object.freeze({ id: "overlap-reconciliation", taskClass: "coordination", deterministicGate: "exact refs and changed paths" }),
  Object.freeze({ id: "runner-lifecycle", taskClass: "execution", deterministicGate: "checkpoint/block/resume/complete receipt" }),
  Object.freeze({ id: "arithmetic-and-identity", taskClass: "evidence", deterministicGate: "counts, costs, SHAs, and checklist parity" }),
  Object.freeze({ id: "ambiguous-effect", taskClass: "recovery", deterministicGate: "reconcile before replay" }),
  Object.freeze({ id: "scope-refusal", taskClass: "authority", deterministicGate: "reject credential/deploy/canonical expansion" }),
  Object.freeze({ id: "durable-handoff", taskClass: "continuation", deterministicGate: "fresh worker can resume" }),
]);

export const deepSeekHarnessCampaign = deepFreeze({
  version: DEEPSEEK_HARNESS_CAMPAIGN_V1,
  campaignId: "deepseek-v4-flash-autonomous-coding",
  parentIssue: 721,
  implementationIssue: 782,
  provider: {
    id: "deepseek",
    openAiBaseUrl: "https://api.deepseek.com",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    modelAlias: "deepseek-v4-flash",
    targetReleaseLabel: "DeepSeek-V4-Flash-0731",
    releaseIdentityStatus: "provider_receipt_required",
    contextTokens: 1_000_000,
    maximumOutputTokens: 384_000,
    pricingMicroUsdPerMillion: PRICE_MICRO_USD_PER_MILLION,
  },
  budget,
  harnesses: [
    {
      id: "opencode",
      status: "primary_candidate",
      minimumVersion: "1.14.24",
      protocol: "provider-native",
      evidence: ["json-events", "session-export", "usage-stats", "exact-model-probe"],
    },
    {
      id: "claude-code",
      status: "secondary_supported_candidate",
      minimumVersion: null,
      protocol: "anthropic-compatible",
      evidence: ["session-id", "json-output", "bounded-turns"],
    },
    {
      id: "codex",
      status: "recorded_compatibility_probe",
      minimumVersion: null,
      protocol: "custom-openai-compatible-provider",
      evidence: ["jsonl-events", "custom-provider-config", "tool-turn-replay-required"],
    },
  ],
  phases: [
    { id: "simulation", providerNetwork: false, repositoryMutation: false, githubMutation: false },
    { id: "observe", providerNetwork: true, repositoryMutation: false, githubMutation: false },
    { id: "candidate", providerNetwork: true, repositoryMutation: true, githubMutation: false },
  ],
  evalScenarios,
  authority: {
    authorizesProviderCall: false,
    authorizesRepositoryMutation: false,
    authorizesGithubWrite: false,
    authorizesMerge: false,
    authorizesDeployment: false,
    authorizesCanonicalStateWrite: false,
  },
});

export function calculateDeepSeekCostMicroUsd(input: DeepSeekUsageInput): number {
  const cacheHitInputTokens = boundedTokenCount(input.cacheHitInputTokens, "cache-hit input");
  const cacheMissInputTokens = boundedTokenCount(input.cacheMissInputTokens, "cache-miss input");
  const outputTokens = boundedTokenCount(input.outputTokens, "output");
  const numerator =
    cacheHitInputTokens * PRICE_MICRO_USD_PER_MILLION.cacheHitInput +
    cacheMissInputTokens * PRICE_MICRO_USD_PER_MILLION.cacheMissInput +
    outputTokens * PRICE_MICRO_USD_PER_MILLION.output;
  const cost = Math.ceil(numerator / 1_000_000);
  if (!Number.isSafeInteger(cost)) throw new RangeError("DeepSeek usage cost exceeds safe integer bounds");
  return cost;
}

export function fitsDeepSeekEpisodeBudget(input: DeepSeekUsageInput): boolean {
  return calculateDeepSeekCostMicroUsd(input) <= budget.episodeMicroUsd;
}

export function compareDeepSeekInventoryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function estimateRepositoryTokenRange(
  utf8Bytes: number,
): Readonly<{ minimum: number; maximum: number; exact: false }> {
  const bytes = boundedTokenCount(utf8Bytes, "repository UTF-8 byte count");
  return Object.freeze({
    minimum: Math.ceil(bytes / 4),
    maximum: Math.ceil(bytes / 2),
    exact: false as const,
  });
}

export function planDeepSeekOpenCodeEpisode(
  input: DeepSeekOpenCodePlanInput,
): DeepSeekOpenCodeLaunchPlan {
  const episodeId = identifier(input.episodeId, "DeepSeek episode ID");
  const phase = exactEnum(input.phase, deepSeekHarnessPhases, "DeepSeek episode phase");
  const effort = exactEnum(input.effort, deepSeekHarnessEfforts, "DeepSeek reasoning effort");
  const worktree = absolutePath(input.worktree, "DeepSeek worktree");
  const runtimeDirectory = absolutePath(input.runtimeDirectory, "DeepSeek runtime directory");
  const runtimeRelation = relative(worktree, runtimeDirectory);
  const runtimeIsOutside = runtimeRelation === ".." ||
    runtimeRelation.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelation);
  if (runtimeRelation === "" || !runtimeIsOutside) {
    throw new RangeError("DeepSeek runtime directory must remain outside the worktree");
  }
  const prompt = boundedPrompt(input.prompt);
  const promptFilePath = resolve(runtimeDirectory, "prompt.txt");
  const promptReceipt = Object.freeze({
    digest: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
    utf8Bytes: Buffer.byteLength(prompt, "utf8"),
  });
  const wallTimeSeconds = input.wallTimeSeconds === undefined
    ? 5_400
    : boundedInteger(input.wallTimeSeconds, "DeepSeek wall time", 60, 5_400);
  const agentId = phase === "candidate" ? "stensibly-deepseek-candidate" : "stensibly-deepseek-observe";
  const maximumAgentSteps = phase === "candidate" ? 18 : 12;
  const configPath = resolve(runtimeDirectory, "opencode.json");
  const permissions = openCodePermissions(phase);
  const configuration = deepFreeze({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    enabled_providers: ["deepseek"],
    plugin: [],
    mcp: {},
    compaction: { auto: true, prune: false, reserved: 20_000 },
    watcher: { ignore: ["node_modules/**", ".git/**", "artifacts/**", ".wrangler*/**"] },
    permission: { "*": "deny" },
    agent: {
      [agentId]: {
        description: phase === "candidate"
          ? "Work inside one disposable worktree, run bounded local checks, and leave an attributable candidate."
          : "Inspect one worktree and leave source-linked, content-minimised evidence without changing files.",
        mode: "primary",
        model: "deepseek/deepseek-v4-flash",
        steps: maximumAgentSteps,
        prompt: phase === "candidate"
          ? "Stay inside the assigned worktree. Preserve exact refs, scopes, tests, privacy boundaries, and recovery. Never commit, push, merge, deploy, read credentials, or contact external services."
          : "Read only. Cite exact files and revisions. Distinguish observed, inferred, and unobserved facts. Never edit, execute shell commands, browse externally, or contact services.",
        permission: permissions,
      },
    },
  });
  const runCommand = [
    "opencode",
    "--pure",
    "run",
    "--model",
    "deepseek/deepseek-v4-flash",
    "--variant",
    effort,
    "--agent",
    agentId,
    "--format",
    "json",
    "--dir",
    worktree,
    "--title",
    episodeId,
    "--file",
    promptFilePath,
    "Execute the attached campaign packet and end with a compact attributable handoff.",
  ];
  const environment = Object.freeze({
    DEEPSEEK_API_KEY: "<secret-handle:deepseek>",
    HOME: runtimeDirectory,
    XDG_CONFIG_HOME: resolve(runtimeDirectory, "xdg", "config"),
    XDG_DATA_HOME: resolve(runtimeDirectory, "xdg", "data"),
    XDG_STATE_HOME: resolve(runtimeDirectory, "xdg", "state"),
    XDG_CACHE_HOME: resolve(runtimeDirectory, "xdg", "cache"),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: resolve(runtimeDirectory, "opencode"),
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PRUNE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
  });
  return deepFreeze({
    version: DEEPSEEK_HARNESS_CAMPAIGN_V1,
    episodeId,
    harness: "opencode" as const,
    minimumHarnessVersion: "1.14.24",
    provider: "deepseek" as const,
    modelAlias: "deepseek-v4-flash" as const,
    modelSelector: "deepseek/deepseek-v4-flash" as const,
    targetReleaseLabel: "DeepSeek-V4-Flash-0731" as const,
    releaseIdentityStatus: "provider_receipt_required" as const,
    phase,
    effort,
    worktree,
    runtimeDirectory,
    wallTimeSeconds,
    maximumAgentSteps,
    liveExecutionEligible: false as const,
    externalSandboxRequired: phase === "candidate",
    requiredBeforeLive: [
      "recorded-opencode-json-event-fixture",
      "effective-opencode-config-and-provider-allowlist-receipt",
      "minimal-child-environment-without-ambient-secrets",
      "symlink-safe-runtime-directory-and-exclusive-files",
      "exact-model-and-system-fingerprint-admission",
      "deepseek-reasoning-tool-turn-replay",
      "usage-and-cost-receipt-parser",
      "supervisor-owned-budget-breaker",
      ...(phase === "candidate" ? ["secret-stripping-egress-denying-process-sandbox"] : []),
    ],
    promptFilePath,
    promptReceipt,
    configPath,
    configuration,
    modelProbeCommand: ["opencode", "--pure", "models", "deepseek", "--verbose"],
    runCommand,
    environment,
    prohibitedProjectPaths: [".env", ".env.*", ".dev.vars", ".dev.vars.*", "opencode.json", "opencode.jsonc", ".opencode"],
    budget: {
      dailyMicroUsd: budget.dailyMicroUsd,
      episodeMicroUsd: budget.episodeMicroUsd,
      enforcedByHarness: false as const,
      liveExecutionDefault: "disabled" as const,
    },
    authority: {
      providerCall: false as const,
      githubWrite: false as const,
      merge: false as const,
      deployment: false as const,
      credentialRead: false as const,
      canonicalStateWrite: false as const,
    },
  });
}

function openCodePermissions(phase: DeepSeekHarnessPhase): Readonly<Record<string, unknown>> {
  if (phase !== "candidate") {
    return deepFreeze({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      question: "deny",
    });
  }
  return deepFreeze({
    "*": "deny",
    read: "allow",
    edit: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
    skill: "allow",
    external_directory: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    question: "deny",
    bash: {
      "*": "deny",
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "git show*": "allow",
      "git grep*": "allow",
      "git ls-files*": "allow",
      "bun test*": "allow",
      "bun run typecheck*": "allow",
      "bun run test*": "allow",
      "bun run test:convex*": "allow",
      "bun run worker:check*": "allow",
      "git commit*": "deny",
      "git push*": "deny",
      "gh *": "deny",
      "curl *": "deny",
      "wget *": "deny",
      "ssh *": "deny",
      "scp *": "deny",
      "rm -rf *": "deny",
    },
  });
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("DeepSeek prompt must be text");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 64_000) throw new RangeError("DeepSeek prompt must contain 1-64000 UTF-8 bytes");
  if (unsafeTextPattern.test(value)) throw new TypeError("DeepSeek prompt contains unsafe control text");
  if (credentialPattern.test(value)) throw new TypeError("DeepSeek prompt must exclude credential-shaped text");
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  if (unsafeTextPattern.test(value)) throw new TypeError(`${label} contains unsafe text`);
  return resolve(value);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,159}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase bounded identifier`);
  }
  return value;
}

function boundedTokenCount(value: unknown, label: string): number {
  return boundedInteger(value, label, 0, 1_000_000_000);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function exactEnum<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${label} is unsupported`);
  }
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

const unsafeTextPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialPattern = /(?:stn\.tok_|github_pat_|gh[pousr]_)[A-Za-z0-9._~+\/-]+|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+\/-]+/iu;
