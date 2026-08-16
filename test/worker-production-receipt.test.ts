import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileWorkerProductionReceipt,
  observeWorkerProviderCurrent,
  runWorkerProductionReceipt,
  type WorkerProductionReceiptDependencies,
} from "../scripts/worker-production-receipt.js";

const SOURCE_SHA = "a".repeat(40);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const STALE_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const BASELINE_ID = "33333333-3333-4333-8333-333333333333";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("production Worker provider-current receipt", () => {
  test("binds the exact sole active provider version to its protected source annotation", () => {
    expect(observeWorkerProviderCurrent(inventory(), SOURCE_SHA, VERSION_ID)).toEqual({
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      sourceRevision: SOURCE_SHA,
      createdAt: "2026-08-16T06:28:58.462931Z",
    });
  });

  test("rejects annotation, source, and active-version drift", () => {
    expect(() => observeWorkerProviderCurrent(inventory({
      message: `Promote exact Stensibly main ${"b".repeat(40)}`,
    }), SOURCE_SHA, VERSION_ID)).toThrow("not bound to the expected source revision");
    expect(() => observeWorkerProviderCurrent(inventory({ source: "dashboard" }), SOURCE_SHA, VERSION_ID))
      .toThrow("unexpected provider strategy");
    expect(() => observeWorkerProviderCurrent(inventory({ percentage: 90 }), SOURCE_SHA, VERSION_ID))
      .toThrow("percentages sum to 90");
  });

  test("compiles a content-minimised non-authorizing receipt", () => {
    const provider = observeWorkerProviderCurrent(inventory(), SOURCE_SHA, VERSION_ID);
    const receipt = compileWorkerProductionReceipt({
      repository: "teamleaderleo/stensibly",
      sourceRevision: SOURCE_SHA,
      workflowRevision: SOURCE_SHA,
      runId: "123",
      runAttempt: "1",
      baselineDeploymentId: BASELINE_ID,
      provider,
      observedAt: "2026-08-16T07:00:00.000Z",
    });

    expect(receipt.schemaVersion).toBe("stensibly-worker-production-deployment-receipt/1");
    expect(receipt.production).toEqual(provider);
    expect(receipt.verifiedOrigins.map((origin) => origin.versionId)).toEqual([
      VERSION_ID,
      VERSION_ID,
    ]);
    expect(receipt.providerCurrentVerified).toBe(true);
    expect(receipt.authorizesDeployment).toBe(false);
    expect(receipt.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("token");
  });

  test("reads Cloudflare once, verifies both public origins, and writes only inside RUNNER_TEMP", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-worker-receipt-test-"));
    temporaryRoots.push(root);
    const output = join(root, "receipt.json");
    const calls: string[] = [];
    const dependencies: WorkerProductionReceiptDependencies = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        return { stdout: JSON.stringify(inventory()) };
      },
      async fetch(input) {
        calls.push(input);
        return new Response("healthy", {
          status: 200,
          headers: { "x-stensibly-worker-version-id": VERSION_ID },
        });
      },
      async sleep() {
        throw new Error("matching origins must not sleep");
      },
      now: () => new Date("2026-08-16T07:00:00.000Z"),
    };
    const receipt = await runWorkerProductionReceipt(environment(root, output), dependencies);

    expect(calls[0]).toContain(
      "bunx wrangler deployments list --name stensibly-api --json --config wrangler.jsonc",
    );
    expect(calls).toContain("https://stensibly-api.leoli-082000.workers.dev/health");
    expect(calls).toContain("https://api.stensibly.com/health");
    expect(await Bun.file(output).json()).toEqual(receipt);

    await expect(runWorkerProductionReceipt(
      environment(root, join(tmpdir(), "outside-receipt.json")),
      dependencies,
    )).rejects.toThrow("inside RUNNER_TEMP");
    expect(calls).toHaveLength(3);
  });

  test("accepts a temporarily stale public origin only after it converges to provider current", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-worker-receipt-convergence-"));
    temporaryRoots.push(root);
    const output = join(root, "receipt.json");
    let fallbackReads = 0;
    const sleeps: number[] = [];
    const receipt = await runWorkerProductionReceipt(environment(root, output), {
      async run() {
        return { stdout: JSON.stringify(inventory()) };
      },
      async fetch(input) {
        const isFallback = input.includes("workers.dev");
        if (isFallback) fallbackReads += 1;
        const versionId = isFallback && fallbackReads < 3 ? STALE_VERSION_ID : VERSION_ID;
        return new Response("healthy", {
          status: 200,
          headers: { "x-stensibly-worker-version-id": versionId },
        });
      },
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
      },
      now: () => new Date("2026-08-16T07:00:00.000Z"),
    });

    expect(fallbackReads).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(receipt.production.versionId).toBe(VERSION_ID);
    expect(await Bun.file(output).json()).toEqual(receipt);
  });

  test("strictly bounds and parses the provider deployment inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-worker-receipt-json-"));
    temporaryRoots.push(root);
    for (const stdout of [
      `${JSON.stringify(inventory())}${JSON.stringify(inventory())}`,
      JSON.stringify(["x".repeat(128 * 1_024)]),
    ]) {
      await expect(runWorkerProductionReceipt(environment(root, join(root, `${Math.random()}.json`)), {
        async run() { return { stdout }; },
        async fetch() { throw new Error("health must not be read"); },
        async sleep() { throw new Error("sleep must not run"); },
        now: () => new Date("2026-08-16T07:00:00.000Z"),
      })).rejects.toThrow();
    }
  });

  test("fails before writing when a public origin never converges with provider current", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-worker-receipt-drift-"));
    temporaryRoots.push(root);
    let fallbackReads = 0;
    let officialReads = 0;
    const sleeps: number[] = [];
    await expect(runWorkerProductionReceipt(environment(root, join(root, "receipt.json")), {
      async run() {
        return { stdout: JSON.stringify(inventory()) };
      },
      async fetch(input) {
        if (input.includes("workers.dev")) {
          fallbackReads += 1;
          return new Response("healthy", {
            status: 200,
            headers: { "x-stensibly-worker-version-id": VERSION_ID },
          });
        }
        officialReads += 1;
        return new Response("healthy", {
          status: 200,
          headers: { "x-stensibly-worker-version-id": STALE_VERSION_ID },
        });
      },
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
      },
      now: () => new Date("2026-08-16T07:00:00.000Z"),
    })).rejects.toThrow("does not match provider current");
    expect(fallbackReads).toBe(1);
    expect(officialReads).toBe(8);
    expect(sleeps).toEqual(Array.from({ length: 7 }, () => 5_000));
    expect(await Bun.file(join(root, "receipt.json")).exists()).toBe(false);
  });
});

function environment(root: string, output: string): Record<string, string> {
  return {
    GITHUB_REPOSITORY: "teamleaderleo/stensibly",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: SOURCE_SHA,
    GITHUB_WORKFLOW_SHA: SOURCE_SHA,
    EXPECTED_BASELINE_DEPLOYMENT_ID: BASELINE_ID,
    EXPECTED_CANDIDATE_VERSION_ID: VERSION_ID,
    RUNNER_TEMP: root,
    WORKER_PRODUCTION_RECEIPT_OUTPUT: output,
  };
}

function inventory(overrides: {
  source?: string;
  strategy?: string;
  message?: string;
  triggeredBy?: string;
  percentage?: number;
} = {}): unknown[] {
  return [{
    id: DEPLOYMENT_ID,
    source: overrides.source ?? "wrangler",
    strategy: overrides.strategy ?? "percentage",
    annotations: {
      "workers/message": overrides.message ?? `Promote exact Stensibly main ${SOURCE_SHA}`,
      "workers/triggered_by": overrides.triggeredBy ?? "deployment",
    },
    versions: [{
      version_id: VERSION_ID,
      percentage: overrides.percentage ?? 100,
    }],
    created_on: "2026-08-16T06:28:58.462931Z",
  }];
}
