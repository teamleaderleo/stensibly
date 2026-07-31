import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  calculateDeepSeekCostMicroUsd,
  deepSeekHarnessCampaign,
  estimateRepositoryTokenRange,
  fitsDeepSeekEpisodeBudget,
  planDeepSeekOpenCodeEpisode,
} from "../src/deepseek-harness-campaign.js";

const plannerSource = readFileSync(
  join(import.meta.dir, "..", "scripts", "plan-deepseek-opencode.ts"),
  "utf8",
);
const inventorySource = readFileSync(
  join(import.meta.dir, "..", "scripts", "measure-repository-context.ts"),
  "utf8",
);

const baseInput = {
  episodeId: "issue-782-observe-1",
  phase: "observe" as const,
  effort: "high" as const,
  worktree: "/tmp/stensibly-worktrees/issue-782-observe-1",
  runtimeDirectory: "/tmp/stensibly-runtimes/issue-782-observe-1",
  prompt: "Inspect the exact assigned revision and report source-linked findings.",
};

describe("DeepSeek V4 Flash harness campaign", () => {
  test("publishes one frozen, authority-free dollar-a-day campaign", () => {
    expect(deepSeekHarnessCampaign.version).toBe(1);
    expect(deepSeekHarnessCampaign.provider.modelAlias).toBe("deepseek-v4-flash");
    expect(deepSeekHarnessCampaign.provider.targetReleaseLabel).toBe("DeepSeek-V4-Flash-0731");
    expect(deepSeekHarnessCampaign.provider.releaseIdentityStatus).toBe("provider_receipt_required");
    expect(deepSeekHarnessCampaign.budget.dailyMicroUsd).toBe(1_000_000);
    expect(
      deepSeekHarnessCampaign.budget.highPoolMicroUsd +
      deepSeekHarnessCampaign.budget.maxPoolMicroUsd +
      deepSeekHarnessCampaign.budget.reserveMicroUsd,
    ).toBe(deepSeekHarnessCampaign.budget.dailyMicroUsd);
    expect(deepSeekHarnessCampaign.budget.episodeMicroUsd).toBe(100_000);
    expect(deepSeekHarnessCampaign.evalScenarios).toHaveLength(9);
    expect(deepSeekHarnessCampaign.harnesses.find((entry) => entry.id === "codex")?.status)
      .toBe("recorded_compatibility_probe");
    expect(Object.values(deepSeekHarnessCampaign.authority)).toEqual([false, false, false, false, false, false]);
    expect(Object.isFrozen(deepSeekHarnessCampaign)).toBe(true);
    expect(Object.isFrozen(deepSeekHarnessCampaign.evalScenarios)).toBe(true);
  });

  test("calculates cache-hit, cache-miss, and output costs exactly in micro-dollars", () => {
    expect(calculateDeepSeekCostMicroUsd({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 100_000,
      outputTokens: 20_000,
    })).toBe(19_600);
    expect(calculateDeepSeekCostMicroUsd({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 500_000,
      outputTokens: 75_000,
    })).toBe(91_000);
    expect(calculateDeepSeekCostMicroUsd({
      cacheHitInputTokens: 400_000,
      cacheMissInputTokens: 100_000,
      outputTokens: 75_000,
    })).toBe(36_120);
    expect(fitsDeepSeekEpisodeBudget({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 500_000,
      outputTokens: 75_000,
    })).toBe(true);
    expect(fitsDeepSeekEpisodeBudget({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 1_000_000,
      outputTokens: 0,
    })).toBe(false);
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateDeepSeekCostMicroUsd({
        cacheHitInputTokens: invalid,
        cacheMissInputTokens: 0,
        outputTokens: 0,
      })).toThrow("safe integer");
    }
  });

  test("labels repository token sizing as a bounded estimate", () => {
    expect(estimateRepositoryTokenRange(4_000_000)).toEqual({
      minimum: 1_000_000,
      maximum: 2_000_000,
      exact: false,
    });
    expect(() => estimateRepositoryTokenRange(-1)).toThrow("safe integer");
  });

  test("plans an isolated read-only OpenCode observation", () => {
    const plan = planDeepSeekOpenCodeEpisode(baseInput);
    expect(plan.minimumHarnessVersion).toBe("1.14.24");
    expect(plan.modelSelector).toBe("deepseek/deepseek-v4-flash");
    expect(plan.releaseIdentityStatus).toBe("provider_receipt_required");
    expect(plan.maximumAgentSteps).toBe(12);
    expect(plan.runCommand).toContain("--format");
    expect(plan.runCommand).toContain("json");
    expect(plan.runCommand).toContain("--variant");
    expect(plan.runCommand).toContain("high");
    expect(plan.runCommand).toContain("--file");
    expect(plan.runCommand).toContain(plan.promptFilePath);
    expect(plan.runCommand).not.toContain(baseInput.prompt);
    expect(plan.promptReceipt.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.promptReceipt.utf8Bytes).toBe(Buffer.byteLength(baseInput.prompt, "utf8"));
    expect(plan.modelProbeCommand).toEqual(["opencode", "--pure", "models", "deepseek", "--verbose"]);
    expect(plan.environment.OPENCODE_CONFIG).toBe(plan.configPath);
    expect(plan.environment.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("true");
    expect(plan.environment.OPENCODE_DISABLE_CLAUDE_CODE).toBe("true");
    expect(plan.environment.DEEPSEEK_API_KEY).toBe("<secret-handle:deepseek>");
    expect(JSON.stringify(plan)).not.toMatch(/(?:github_pat_|gh[pousr]_|sk-(?:proj-)?)/iu);
    const agent = (plan.configuration.agent as Record<string, { permission: Record<string, unknown> }>)["stensibly-deepseek-observe"]!;
    expect(agent.permission.read).toBe("allow");
    expect(agent.permission.edit).toBeUndefined();
    expect(agent.permission.bash).toBeUndefined();
    expect(agent.permission.webfetch).toBe("deny");
    expect(agent.permission.external_directory).toBe("deny");
    expect(plan.configuration.share).toBe("disabled");
    expect(plan.configuration.enabled_providers).toEqual(["deepseek"]);
    expect(plan.configuration.plugin).toEqual([]);
    expect(plan.configuration.mcp).toEqual({});
    expect(plan.budget.enforcedByHarness).toBe(false);
    expect(plan.budget.liveExecutionDefault).toBe("disabled");
    expect(Object.values(plan.authority)).toEqual([false, false, false, false, false, false]);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  test("keeps candidate work local and denies external or terminal commands", () => {
    const plan = planDeepSeekOpenCodeEpisode({
      ...baseInput,
      episodeId: "issue-782-candidate-1",
      phase: "candidate",
      effort: "max",
    });
    expect(plan.maximumAgentSteps).toBe(18);
    const agent = (plan.configuration.agent as Record<string, { permission: Record<string, unknown> }>)["stensibly-deepseek-candidate"]!;
    expect(agent.permission.edit).toBe("allow");
    const bash = agent.permission.bash as Record<string, string>;
    expect(bash["bun test*"]).toBe("allow");
    expect(bash["git status*"]).toBe("allow");
    expect(bash["git commit*"]).toBe("deny");
    expect(bash["git push*"]).toBe("deny");
    expect(bash["gh *"]).toBe("deny");
    expect(bash["curl *"]).toBe("deny");
    expect(agent.permission.webfetch).toBe("deny");
    expect(agent.permission.websearch).toBe("deny");
    expect(plan.authority.githubWrite).toBe(false);
    expect(plan.authority.merge).toBe(false);
    expect(plan.authority.deployment).toBe(false);
  });

  test("fails closed on unsafe identities, paths, prompts, and limits", () => {
    expect(() => planDeepSeekOpenCodeEpisode({
      ...baseInput,
      episodeId: "UPPERCASE",
    })).toThrow("lowercase bounded identifier");
    expect(() => planDeepSeekOpenCodeEpisode({
      ...baseInput,
      worktree: "relative/worktree",
    })).toThrow("absolute path");
    expect(() => planDeepSeekOpenCodeEpisode({
      ...baseInput,
      runtimeDirectory: `${baseInput.worktree}/runtime`,
    })).toThrow("outside the worktree");
    expect(() => planDeepSeekOpenCodeEpisode({
      ...baseInput,
      prompt: "Use Bearer abcdefghijklmnopqrstuvwxyz",
    })).toThrow("credential-shaped");
    expect(() => planDeepSeekOpenCodeEpisode({
      ...baseInput,
      wallTimeSeconds: 5_401,
    })).toThrow("60 to 5400");
    expect(() => planDeepSeekOpenCodeEpisode({
      ...baseInput,
      phase: "production" as never,
    })).toThrow("unsupported");
  });

  test("keeps live execution explicit and repository inventory privacy-safe", () => {
    for (const source of [plannerSource, inventorySource]) {
      expect(source).not.toMatch(/(?:github_pat_|gh[pousr]_|stn\.tok_|sk-proj-)[A-Za-z0-9._~+\/-]+/iu);
    }
    expect(plannerSource).toContain("STENSIBLY_DEEPSEEK_LIVE");
    expect(plannerSource).toContain("STENSIBLY_DEEPSEEK_ACCEPT_OPENCODE_BUDGET_GAP");
    expect(plannerSource).toContain("rejectProjectOverrides");
    expect(plannerSource).toContain("did not expose exact model selector");
    expect(inventorySource).toContain('Bun.spawnSync(["git", "-C", root, "ls-files", "-z"]');
    expect(inventorySource).toContain("metadata.isSymbolicLink()");
    expect(inventorySource).not.toContain("repositoryRoot: root");
    expect(inventorySource).not.toContain("workingDirectory");
  });
});
