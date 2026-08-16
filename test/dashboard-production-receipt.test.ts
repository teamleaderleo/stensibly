import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileDashboardProductionReceipt,
  observeDashboardProviderCurrent,
  runDashboardProductionReceipt,
  type DashboardProductionReceiptDependencies,
} from "../scripts/dashboard-production-receipt.js";

const SOURCE_SHA = "a".repeat(40);
const PROJECT_ID = "prj_Abc123";
const TEAM_ID = "team_Def456";
const DEPLOYMENT_ID = "dpl_Ghi789";
const DEPLOYMENT_ORIGIN = "https://stensibly-example.vercel.app";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("production dashboard provider-current receipt", () => {
  test("binds the canonical alias to one ready production deployment and exact source", () => {
    expect(observation()).toEqual({
      deploymentId: DEPLOYMENT_ID,
      immutableOrigin: DEPLOYMENT_ORIGIN,
      sourceRevision: SOURCE_SHA,
      createdAt: "2026-08-16T06:41:01.517Z",
      readyAt: "2026-08-16T06:41:04.792Z",
      aliasUpdatedAt: "2026-08-16T06:41:23.018Z",
    });
  });

  test("rejects alias, project, source, state, and time drift", () => {
    expect(() => observation({ aliasProjectId: "prj_Other" }))
      .toThrow("alias project");
    expect(() => observation({ aliasDeploymentId: "dpl_Other" }))
      .toThrow("alias deployment identity");
    expect(() => observation({ projectId: "prj_Other" }))
      .toThrow("deployment project ID");
    expect(() => observation({ sourceRevision: "b".repeat(40) }))
      .toThrow("commit revision");
    expect(() => observation({ readyState: "BUILDING" }))
      .toThrow("deployment state");
    expect(() => observation({ aliasUpdatedAt: 1_786_862_460_000 }))
      .toThrow("times are incoherent");
  });

  test("compiles a content-minimised non-authorizing receipt", () => {
    const receipt = compileDashboardProductionReceipt({
      repository: "teamleaderleo/stensibly",
      sourceRevision: SOURCE_SHA,
      workflowRevision: SOURCE_SHA,
      runId: "123",
      runAttempt: "1",
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
      provider: observation(),
      observedAt: "2026-08-16T07:09:00.000Z",
    });

    expect(receipt.schemaVersion).toBe("stensibly-dashboard-production-deployment-receipt/1");
    expect(receipt.canonical.host).toBe("www.stensibly.com");
    expect(receipt.production.deploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.providerCurrentVerified).toBe(true);
    expect(receipt.authorizesDeployment).toBe(false);
    expect(receipt.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("secret-token");
  });

  test("reads the exact Vercel records and writes only inside RUNNER_TEMP", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-dashboard-receipt-"));
    temporaryRoots.push(root);
    const output = join(root, "receipt.json");
    const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const dependencies: DashboardProductionReceiptDependencies = {
      async fetch(input, init) {
        calls.push({
          url: input,
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        });
        return jsonResponse(input.includes("/v4/aliases/") ? alias() : deployment());
      },
      now: () => new Date("2026-08-16T07:09:00.000Z"),
    };
    const receipt = await runDashboardProductionReceipt(environment(root, output), dependencies);

    expect(calls).toEqual([
      {
        url: `https://api.vercel.com/v4/aliases/www.stensibly.com?teamId=${TEAM_ID}`,
        authorization: "Bearer secret-token",
        redirect: "error",
      },
      {
        url: `https://api.vercel.com/v13/deployments/${DEPLOYMENT_ID}?teamId=${TEAM_ID}`,
        authorization: "Bearer secret-token",
        redirect: "error",
      },
    ]);
    expect(await Bun.file(output).json()).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain("secret-token");

    await expect(runDashboardProductionReceipt(
      environment(root, join(tmpdir(), "outside-dashboard-receipt.json")),
      dependencies,
    )).rejects.toThrow("inside RUNNER_TEMP");
    expect(calls).toHaveLength(2);
  });

  test("fails before writing on bounded transport or strict JSON errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "stensibly-dashboard-receipt-json-"));
    temporaryRoots.push(root);
    for (const response of [
      new Response("{}{}", { status: 200, headers: { "content-type": "application/json" } }),
      new Response("x", { status: 503, headers: { "content-type": "application/json" } }),
      new Response("[]", {
        status: 200,
        headers: { "content-length": "999999", "content-type": "application/json" },
      }),
    ]) {
      const output = join(root, `${Math.random()}.json`);
      await expect(runDashboardProductionReceipt(environment(root, output), {
        async fetch() { return response.clone(); },
        now: () => new Date("2026-08-16T07:09:00.000Z"),
      })).rejects.toThrow();
      expect(await Bun.file(output).exists()).toBe(false);
    }
  });
});

function observation(overrides: ObservationOverrides = {}) {
  return observeDashboardProviderCurrent(alias(overrides), deployment(overrides), {
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    deploymentOrigin: DEPLOYMENT_ORIGIN,
    sourceRevision: SOURCE_SHA,
  });
}

interface ObservationOverrides {
  aliasProjectId?: string;
  aliasDeploymentId?: string;
  projectId?: string;
  sourceRevision?: string;
  readyState?: string;
  aliasUpdatedAt?: number;
}

function alias(overrides: ObservationOverrides = {}) {
  return {
    alias: "www.stensibly.com",
    projectId: overrides.aliasProjectId ?? PROJECT_ID,
    deploymentId: overrides.aliasDeploymentId ?? DEPLOYMENT_ID,
    deployment: { id: DEPLOYMENT_ID, url: "stensibly-example.vercel.app" },
    updatedAt: overrides.aliasUpdatedAt ?? 1_786_862_483_018,
  };
}

function deployment(overrides: ObservationOverrides = {}) {
  return {
    id: DEPLOYMENT_ID,
    name: "stensibly",
    url: "stensibly-example.vercel.app",
    readyState: overrides.readyState ?? "READY",
    target: "production",
    createdAt: 1_786_862_461_517,
    ready: 1_786_862_464_792,
    project: { id: overrides.projectId ?? PROJECT_ID, name: "stensibly" },
    team: { id: TEAM_ID },
    meta: {
      githubCommitOrg: "teamleaderleo",
      githubCommitRepo: "stensibly",
      githubCommitRef: "main",
      githubCommitSha: overrides.sourceRevision ?? SOURCE_SHA,
      githubOrg: "teamleaderleo",
      githubRepo: "stensibly",
    },
  };
}

function environment(root: string, output: string): Record<string, string> {
  return {
    GITHUB_REPOSITORY: "teamleaderleo/stensibly",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: SOURCE_SHA,
    GITHUB_WORKFLOW_SHA: SOURCE_SHA,
    EXPECTED_REVISION: SOURCE_SHA,
    VERCEL_PROJECT_ID: PROJECT_ID,
    VERCEL_ORG_ID: TEAM_ID,
    VERCEL_TOKEN: "secret-token",
    DEPLOYMENT_URL: DEPLOYMENT_ORIGIN,
    RUNNER_TEMP: root,
    DASHBOARD_PRODUCTION_RECEIPT_OUTPUT: output,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
