import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_PRODUCTION_BINDINGS,
  SAFE_IGNORED_RELEASE_PATHS,
  deploymentSpecs,
  newestDeployment,
  releaseWorktreeProblems,
  sameVersions,
  validateProductionVersion,
  runProductionRelease,
  type ReleaseDependencies,
  type WorkerBinding,
} from "../scripts/worker-production-release.js";

const VERSION_A = "11111111-1111-4111-8111-111111111111";
const VERSION_B = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPLOYMENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHA = "c".repeat(40);

describe("production Worker release guard", () => {
  test("accepts the complete uploaded production binding contract", () => {
    expect(validateProductionVersion({
      id: VERSION_A,
      resources: { bindings: completeBindings() },
    }, VERSION_A)).toEqual([]);
  });

  test("rejects the missing-provider shape from stale version d63ad", () => {
    const omitted = new Set([
      "STENSIBLY_GITHUB_PROVIDER_PROJECT",
      "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
      "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED",
      "STENSIBLY_GITHUB_DELEGATED_READS_ENABLED",
      "STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED",
    ]);
    const problems = validateProductionVersion({
      id: VERSION_A,
      resources: { bindings: completeBindings().filter((binding) => !omitted.has(String(binding.name))) },
    }, VERSION_A);

    expect(problems).toHaveLength(5);
    for (const name of omitted) expect(problems).toContain(`required binding ${name} is missing`);
  });

  test("rejects the obsolete single-repository routing binding", () => {
    expect(validateProductionVersion({
      id: VERSION_A,
      resources: {
        bindings: [
          ...completeBindings(),
          {
            name: "STENSIBLY_GITHUB_PROVIDER_REPOSITORY",
            type: "plain_text",
            text: "teamleaderleo/stensibly",
          },
        ],
      },
    }, VERSION_A)).toContain(
      "obsolete binding STENSIBLY_GITHUB_PROVIDER_REPOSITORY must be absent",
    );
  });

  test("rejects a present enablement binding with the wrong production value", () => {
    for (const name of [
      "STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED",
      "STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED",
    ]) {
      const bindings = completeBindings().map((binding) => (
        binding.name === name ? { ...binding, text: "false" } : binding
      ));
      expect(validateProductionVersion({
        id: VERSION_A,
        resources: { bindings },
      }, VERSION_A)).toContain(
        `binding ${name} has an unexpected production value`,
      );
    }
  });

  test("requires the production rate limiter with Wrangler's actual binding type", () => {
    expect(REQUIRED_PRODUCTION_BINDINGS.OAUTH_REGISTRATION_RATE_LIMITER).toEqual({
      name: "OAUTH_REGISTRATION_RATE_LIMITER",
      type: "ratelimit",
    });
    const bindings = completeBindings().filter((binding) => (
      binding.name !== "OAUTH_REGISTRATION_RATE_LIMITER"
    ));
    expect(validateProductionVersion({
      id: VERSION_A,
      resources: { bindings },
    }, VERSION_A)).toContain("required binding OAUTH_REGISTRATION_RATE_LIMITER is missing");
    const wrongType = completeBindings().map((binding) => (
      binding.name === "OAUTH_REGISTRATION_RATE_LIMITER"
        ? { ...binding, type: "plain_text" }
        : binding
    ));
    expect(validateProductionVersion({
      id: VERSION_A,
      resources: { bindings: wrongType },
    }, VERSION_A)).toContain(
      "binding OAUTH_REGISTRATION_RATE_LIMITER has type plain_text; expected ratelimit",
    );
  });

  test("enumerates active auth and OAuth bindings without secret values", () => {
    const secretNames = [
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS",
      "STENSIBLY_AUTH_BOOTSTRAP_ROLE",
      "STENSIBLY_AUTH_ORIGIN",
      "STENSIBLY_AUTH_RETURN_ORIGINS",
      "STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS",
      "STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS",
      "STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS",
      "STENSIBLY_OAUTH_SIGNING_SECRET",
    ] as const;
    for (const name of secretNames) {
      const binding = REQUIRED_PRODUCTION_BINDINGS[name];
      expect(binding).toEqual({ name, type: "secret_text" });
      expect(binding?.text).toBeUndefined();
    }
  });

  test("permits only explicit ignored dependency and Wrangler output roots", () => {
    expect(SAFE_IGNORED_RELEASE_PATHS).toEqual([
      ".wrangler-dry-run/",
      "node_modules/",
    ]);
    expect(releaseWorktreeProblems([
      "!! .wrangler-dry-run/",
      "!! node_modules/",
    ].join("\n"))).toEqual([]);
    expect(releaseWorktreeProblems("!! .wrangler/\n")).toEqual([
      "an unapproved ignored path is present",
    ]);
    expect(releaseWorktreeProblems("?? scratch-worker.ts\n")).toEqual([
      "an ordinary untracked path is present",
    ]);
    expect(releaseWorktreeProblems("!! .env.production\n!! stensibly.sqlite\n")).toEqual([
      "an unapproved ignored path is present",
    ]);
    expect(releaseWorktreeProblems(" M src/cloudflare-worker.ts\n")).toEqual([
      "a tracked worktree change is present",
    ]);
  });

  test("selects the newest deployment by timestamp rather than provider list order", () => {
    const newest = newestDeployment([
      deployment(DEPLOYMENT_B, "2026-08-08T20:20:00Z", VERSION_B),
      deployment(DEPLOYMENT_A, "2026-08-08T20:10:00Z", VERSION_A),
    ]);
    expect(newest.id).toBe(DEPLOYMENT_B);
    expect(newest.versions).toEqual([{ version_id: VERSION_B, percentage: 100 }]);
  });

  test("preserves exact baseline distributions for automatic recovery", () => {
    const versions = [
      { version_id: VERSION_A, percentage: 90 },
      { version_id: VERSION_B, percentage: 10 },
    ];
    expect(deploymentSpecs(versions)).toEqual([`${VERSION_A}@90%`, `${VERSION_B}@10%`]);
    expect(sameVersions(versions, [...versions].reverse())).toBe(true);
    expect(sameVersions(versions, [{ version_id: VERSION_A, percentage: 100 }])).toBe(false);
  });

  test("fails closed on invalid or incomplete deployment distributions", () => {
    expect(() => deploymentSpecs([])).toThrow("Expected one or two deployed versions");
    expect(() => deploymentSpecs([
      { version_id: VERSION_A, percentage: 50 },
    ])).toThrow("percentages sum to 50");
    expect(() => newestDeployment([
      deployment(DEPLOYMENT_A, "2026-08-08T20:10:00Z", VERSION_A, 99),
    ])).toThrow("percentages sum to 99");
  });

  test("rejects a queued stale candidate before any Cloudflare command", async () => {
    const commands: string[] = [];
    await withCredentialEnvironment(async () => {
      await expect(runProductionRelease({
        expectedSha: SHA,
        oauthExpectation: "enabled",
      }, {
        ...unusedDependencies(),
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (args[0] === "status") return { stdout: "" };
          if (args[0] === "fetch") return { stdout: "" };
          if (args.join(" ") === "rev-parse HEAD") return { stdout: `${SHA}\n` };
          if (args.join(" ") === "rev-parse refs/remotes/origin/main") {
            return { stdout: `${"d".repeat(40)}\n` };
          }
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      })).rejects.toThrow("Stale production candidate");
    });
    expect(commands.some((command) => command.includes("wrangler"))).toBe(false);
  });

  test("rejects an ordinary untracked bundle input before any Cloudflare command", async () => {
    const commands: string[] = [];
    await withCredentialEnvironment(async () => {
      await expect(runProductionRelease({
        expectedSha: SHA,
        oauthExpectation: "enabled",
      }, {
        ...unusedDependencies(),
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (args[0] === "status") return { stdout: "?? scratch-worker.ts\n" };
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      })).rejects.toThrow("ordinary untracked path is present");
    });
    expect(commands.some((command) => command.includes("wrangler"))).toBe(false);
  });

  test("restores the exact baseline when post-promotion health fails", async () => {
    const harness = recoveryHarness(true);

    await withCredentialEnvironment(async () => {
      await expect(runProductionRelease({
        expectedSha: SHA,
        oauthExpectation: "enabled",
      }, harness.dependencies)).rejects.toThrow("previous deployment was restored");
    });

    expect(harness.healthAttempts()).toBe(6);
    expect(harness.commands.some((command) => command.includes(
      `wrangler versions deploy ${VERSION_B}@100%`,
    ))).toBe(true);
    expect(harness.commands.some((command) => command.includes(
      `wrangler versions deploy ${VERSION_A}@100%`,
    ))).toBe(true);
    for (const command of harness.commands.filter((entry) => entry.startsWith("bunx wrangler "))) {
      expect(command).toContain("--config wrangler.jsonc");
    }
    expect(harness.commands.find((command) => command.includes("wrangler versions upload"))).toContain(
      "--config wrangler.jsonc",
    );
    expect(harness.cleanupCalls()).toBe(1);
    expect(harness.activeVersion()).toBe(VERSION_A);
    expect(harness.fetches).toContain("https://candidate.example.workers.dev/ready");
    expect(harness.fetches).toContain(
      "https://stensibly-api.leoli-082000.workers.dev/health",
    );
  });

  test("waits for official-domain routing convergence without rolling back a healthy candidate", async () => {
    const harness = recoveryHarness(true, { officialPromotionLagAttempts: 11 });

    const result = await withCredentialEnvironment(() => runProductionRelease({
      expectedSha: SHA,
      oauthExpectation: "enabled",
    }, harness.dependencies));

    expect(result.recovered).toBe(false);
    expect(harness.activeVersion()).toBe(VERSION_B);
    expect(harness.officialPromotionAttempts()).toBe(12);
    expect(harness.commands).toContain("bun run scripts/verify-commander-read.ts");
    expect(harness.commands.some((command) => command.includes(
      `wrangler versions deploy ${VERSION_A}@100%`,
    ))).toBe(false);
  });

  test("restores the baseline when exact-version commander readback fails", async () => {
    const harness = recoveryHarness(true, { officialPromotionLagAttempts: 0, fallbackPromotionLagAttempts: 0 });
    const run = harness.dependencies.run;
    harness.dependencies.run = async (command, args, options) => {
      if (args.includes("scripts/verify-commander-read.ts")) {
        expect(options?.env).toEqual({ VERIFY_PROJECT: "stensibly", EXPECTED_WORKER_VERSION: VERSION_B });
        throw new Error("Commander readback failed");
      }
      return run(command, args, options);
    };
    await expect(withCredentialEnvironment(() => runProductionRelease({
      expectedSha: SHA, oauthExpectation: "enabled",
    }, harness.dependencies))).rejects.toThrow("previous deployment was restored");
    expect(harness.activeVersion()).toBe(VERSION_A);
  });

  test("waits for fallback-domain routing convergence without rolling back a healthy candidate", async () => {
    const harness = recoveryHarness(true, {
      fallbackPromotionLagAttempts: 11,
      officialPromotionLagAttempts: 0,
    });

    const result = await withCredentialEnvironment(() => runProductionRelease({
      expectedSha: SHA,
      oauthExpectation: "enabled",
    }, harness.dependencies));

    expect(result.recovered).toBe(false);
    expect(harness.activeVersion()).toBe(VERSION_B);
    expect(harness.fallbackPromotionAttempts()).toBe(12);
    expect(harness.commands.some((command) => command.includes(
      `wrangler versions deploy ${VERSION_A}@100%`,
    ))).toBe(false);
  });

  for (const failure of ["http_500", "missing_version", "network"] as const) {
    test(`does not treat official-domain ${failure} as a long routing-convergence wait`, async () => {
      const harness = recoveryHarness(true, { officialPromotionFailure: failure });

      await withCredentialEnvironment(async () => {
        await expect(runProductionRelease({
          expectedSha: SHA,
          oauthExpectation: "enabled",
        }, harness.dependencies)).rejects.toThrow("previous deployment was restored");
      });

      expect(harness.officialPromotionAttempts()).toBe(3);
      expect(harness.activeVersion()).toBe(VERSION_A);
    });

    test(`does not treat fallback-domain ${failure} as a long routing-convergence wait`, async () => {
      const harness = recoveryHarness(true, { fallbackPromotionFailure: failure });

      await withCredentialEnvironment(async () => {
        await expect(runProductionRelease({
          expectedSha: SHA,
          oauthExpectation: "enabled",
        }, harness.dependencies)).rejects.toThrow("previous deployment was restored");
      });

      expect(harness.fallbackPromotionAttempts()).toBe(3);
      expect(harness.activeVersion()).toBe(VERSION_A);
    });
  }

  test("waits for official-domain recovery routing to return to the restored baseline", async () => {
    const harness = recoveryHarness(true, {
      officialPromotionFailure: "http_500",
      officialRecoveryLagAttempts: 11,
    });

    await withCredentialEnvironment(async () => {
      await expect(runProductionRelease({
        expectedSha: SHA,
        oauthExpectation: "enabled",
      }, harness.dependencies)).rejects.toThrow("previous deployment was restored");
    });

    expect(harness.officialRecoveryAttempts()).toBe(12);
    expect(harness.activeVersion()).toBe(VERSION_A);
  });

  test("waits for fallback-domain recovery routing to return to the restored baseline", async () => {
    const harness = recoveryHarness(true, {
      fallbackPromotionFailure: "http_500",
      fallbackRecoveryLagAttempts: 11,
    });

    await withCredentialEnvironment(async () => {
      await expect(runProductionRelease({
        expectedSha: SHA,
        oauthExpectation: "enabled",
      }, harness.dependencies)).rejects.toThrow("previous deployment was restored");
    });

    expect(harness.fallbackRecoveryAttempts()).toBe(12);
    expect(harness.activeVersion()).toBe(VERSION_A);
  });

  test("keeps recovery false when restored baseline health cannot be proved", async () => {
    const harness = recoveryHarness(false);
    const outputDirectory = await mkdtemp(join(tmpdir(), "stensibly-release-output-test-"));
    const githubOutput = join(outputDirectory, "github-output.txt");
    try {
      await withCredentialEnvironment(async () => {
        await expect(runProductionRelease({
          expectedSha: SHA,
          oauthExpectation: "enabled",
          githubOutput,
        }, harness.dependencies)).rejects.toThrow(
          "recovery health verification at https://stensibly-api.leoli-082000.workers.dev failed",
        );
      });

      const output = await readFile(githubOutput, "utf8");
      expect(output).toContain("recovered=false");
      expect(output).not.toContain("recovered=true");
      expect(harness.activeVersion()).toBe(VERSION_A);
      expect(harness.healthAttempts()).toBe(7);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});

function completeBindings(): WorkerBinding[] {
  return Object.entries(REQUIRED_PRODUCTION_BINDINGS).map(([name, expected]) => ({
    name,
    type: expected.type,
    ...(expected.text !== undefined ? { text: expected.text } : {}),
  }));
}

function deployment(
  id: string,
  createdOn: string,
  versionId: string,
  percentage = 100,
): Record<string, unknown> {
  return {
    id,
    created_on: createdOn,
    versions: [{ version_id: versionId, percentage }],
  };
}

function unusedDependencies(): ReleaseDependencies {
  return {
    async run(command, args) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
    async fetch() {
      throw new Error("Unexpected fetch");
    },
    sleep: async () => {},
    cleanupWranglerTemporaryDirectories: async () => {},
    async createWranglerOutputFile() {
      const directory = await import("node:fs/promises").then(({ mkdtemp }) => (
        mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/stensibly-release-test-`)
      ));
      return { directory, path: `${directory}/output.jsonl` };
    },
    async removeTemporaryDirectory(path) {
      await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true }));
    },
  };
}

function recoveryHarness(
  recoveryHealthy: boolean,
  options: {
    fallbackPromotionLagAttempts?: number;
    fallbackPromotionFailure?: "http_500" | "missing_version" | "network";
    fallbackRecoveryLagAttempts?: number;
    officialPromotionLagAttempts?: number;
    officialPromotionFailure?: "http_500" | "missing_version" | "network";
    officialRecoveryLagAttempts?: number;
  } = {},
): {
  dependencies: ReleaseDependencies;
  commands: string[];
  fetches: string[];
  activeVersion(): string;
  cleanupCalls(): number;
  healthAttempts(): number;
  fallbackPromotionAttempts(): number;
  fallbackRecoveryAttempts(): number;
  officialPromotionAttempts(): number;
  officialRecoveryAttempts(): number;
} {
  const commands: string[] = [];
  const fetches: string[] = [];
  let activeVersion = VERSION_A;
  let deploymentId = DEPLOYMENT_A;
  let healthAttempts = 0;
  let cleanupCalls = 0;
  let fallbackPromotionAttempts = 0;
  let fallbackRecoveryAttempts = 0;
  let officialPromotionAttempts = 0;
  let officialRecoveryAttempts = 0;
  const dependencies: ReleaseDependencies = {
    ...unusedDependencies(),
    async run(command, args, options) {
      const rendered = [command, ...args].join(" ");
      commands.push(rendered);
      if (command === "git" && args[0] === "status") return { stdout: "" };
      if (command === "git" && args[0] === "fetch") return { stdout: "" };
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return { stdout: `${SHA}\n` };
      }
      if (command === "git" && args.join(" ") === "rev-parse refs/remotes/origin/main") {
        return { stdout: `${SHA}\n` };
      }
      if (rendered.includes("wrangler deployments list")) {
        return { stdout: JSON.stringify([
          deployment(deploymentId, "2026-08-08T20:20:00Z", activeVersion),
        ]) };
      }
      if (rendered.includes("wrangler versions upload")) {
        const outputPath = options?.env?.WRANGLER_OUTPUT_FILE_PATH;
        if (!outputPath) throw new Error("Missing Wrangler output path");
        await Bun.write(outputPath, `${JSON.stringify({
          type: "version-upload",
          version_id: VERSION_B,
          preview_url: "https://candidate.example.workers.dev",
        })}\n`);
        return { stdout: "uploaded" };
      }
      if (rendered.includes(`wrangler versions view ${VERSION_B}`)) {
        return { stdout: JSON.stringify({
          id: VERSION_B,
          resources: { bindings: completeBindings() },
        }) };
      }
      if (rendered.includes(`wrangler versions deploy ${VERSION_B}@100%`)) {
        activeVersion = VERSION_B;
        deploymentId = DEPLOYMENT_B;
        return { stdout: "promoted" };
      }
      if (rendered.includes(`wrangler versions deploy ${VERSION_A}@100%`)) {
        activeVersion = VERSION_A;
        deploymentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        return { stdout: "recovered" };
      }
      if (command === "bun" && args[0] === "run") return { stdout: "verified" };
      throw new Error(`Unexpected command: ${rendered}`);
    },
    async fetch(input) {
      fetches.push(input);
      healthAttempts += 1;
      if (input.startsWith("https://candidate.example.workers.dev")) {
        return new Response("healthy", {
          status: 200,
          headers: { "x-stensibly-worker-version-id": VERSION_B },
        });
      }
      if (
        activeVersion === VERSION_B
        && (options.fallbackPromotionLagAttempts !== undefined || options.fallbackPromotionFailure)
        && input.startsWith("https://stensibly-api.leoli-082000.workers.dev")
      ) {
        fallbackPromotionAttempts += 1;
        if (options.fallbackPromotionFailure === "http_500") {
          return new Response("failure", { status: 500 });
        }
        if (options.fallbackPromotionFailure === "missing_version") {
          return new Response("healthy without identity", { status: 200 });
        }
        if (options.fallbackPromotionFailure === "network") {
          throw new Error("simulated network failure");
        }
        if (fallbackPromotionAttempts <= (options.fallbackPromotionLagAttempts ?? 0)) {
          return new Response("stale route", {
            status: 200,
            headers: { "x-stensibly-worker-version-id": VERSION_A },
          });
        }
        return new Response("healthy", {
          status: 200,
          headers: { "x-stensibly-worker-version-id": VERSION_B },
        });
      }
      if (
        activeVersion === VERSION_B
        && (options.officialPromotionLagAttempts !== undefined || options.officialPromotionFailure)
      ) {
        if (input.startsWith("https://api.stensibly.com")) {
          officialPromotionAttempts += 1;
          if (options.officialPromotionFailure === "http_500") {
            return new Response("failure", { status: 500 });
          }
          if (options.officialPromotionFailure === "missing_version") {
            return new Response("healthy without identity", { status: 200 });
          }
          if (options.officialPromotionFailure === "network") {
            throw new Error("simulated network failure");
          }
          if (officialPromotionAttempts <= (options.officialPromotionLagAttempts ?? 0)) {
            return new Response("stale route", {
              status: 200,
              headers: { "x-stensibly-worker-version-id": VERSION_A },
            });
          }
        }
        return new Response("healthy", {
          status: 200,
          headers: { "x-stensibly-worker-version-id": VERSION_B },
        });
      }
      if (
        activeVersion === VERSION_A
        && options.fallbackRecoveryLagAttempts !== undefined
        && input.startsWith("https://stensibly-api.leoli-082000.workers.dev")
      ) {
        fallbackRecoveryAttempts += 1;
        if (fallbackRecoveryAttempts <= options.fallbackRecoveryLagAttempts) {
          return new Response("stale candidate route", {
            status: 200,
            headers: { "x-stensibly-worker-version-id": VERSION_B },
          });
        }
      }
      if (
        activeVersion === VERSION_A
        && options.officialRecoveryLagAttempts !== undefined
        && input.startsWith("https://api.stensibly.com")
      ) {
        officialRecoveryAttempts += 1;
        if (officialRecoveryAttempts <= options.officialRecoveryLagAttempts) {
          return new Response("stale candidate route", {
            status: 200,
            headers: { "x-stensibly-worker-version-id": VERSION_B },
          });
        }
      }
      if (activeVersion === VERSION_B || !recoveryHealthy) {
        return new Response("failure", { status: 500 });
      }
      return new Response("healthy", {
        status: 200,
        headers: { "x-stensibly-worker-version-id": VERSION_A },
      });
    },
    sleep: async () => {},
    cleanupWranglerTemporaryDirectories: async () => {
      cleanupCalls += 1;
    },
  };
  return {
    dependencies,
    commands,
    fetches,
    activeVersion: () => activeVersion,
    cleanupCalls: () => cleanupCalls,
    healthAttempts: () => healthAttempts,
    fallbackPromotionAttempts: () => fallbackPromotionAttempts,
    fallbackRecoveryAttempts: () => fallbackRecoveryAttempts,
    officialPromotionAttempts: () => officialPromotionAttempts,
    officialRecoveryAttempts: () => officialRecoveryAttempts,
  };
}

async function withCredentialEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const names = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "STENSIBLY_TOKEN"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "test-secret-present";
  try {
    return await operation();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
