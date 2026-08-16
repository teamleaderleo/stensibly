import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/canonical-json.ts";
import { compileDashboardDeploymentMarker } from "../scripts/dashboard-deployment-marker.ts";
import {
  readExactCiReceiptDirectory,
  runDeploymentReconciliationObserver,
  type DeploymentReconciliationEnvironment,
} from "../scripts/observe-deployment-reconciliation.ts";

const currentSha = "a".repeat(40);
const baselineSha = "b".repeat(40);
const baselineRootTree = "c".repeat(40);
const currentRootTree = "d".repeat(40);
const baselineSiteTree = "e".repeat(40);
const currentSiteTree = "f".repeat(40);
const otherSha = "9".repeat(40);
const repository = "teamleaderleo/stensibly";
const repositoryId = 1310091990;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("deployment reconciliation observer adapter", () => {
  test("binds exact GitHub evidence and classifies only the dashboard site tree", async () => {
    const fixture = await localFixture();
    const calls: string[] = [];
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub(calls),
    );

    expect(result.ci).toEqual(expect.objectContaining({
      runId: "123",
      runAttempt: "1",
      workflowId: "319014676",
      workflowPath: ".github/workflows/ci.yml",
      sourceRevision: currentSha,
      receiptContentDigest: fixture.contentDigest,
    }));
    expect(result.observer).toEqual(expect.objectContaining({
      workflowRevision: currentSha,
      sourceRevision: currentSha,
    }));
    expect(result.targets).toEqual([
      expect.objectContaining({
        target: "worker",
        decision: "classification_unknown",
        reason: "dependency_classifier_not_implemented",
      }),
      expect.objectContaining({
        target: "convex",
        decision: "classification_unknown",
        reason: "dependency_classifier_not_implemented",
      }),
      expect.objectContaining({
        target: "dashboard",
        decision: "would_dispatch",
        reason: "site_tree_changed",
        latestSuccessfulWorkflow: {
          runId: "700",
          runAttempt: 2,
          revision: baselineSha,
          updatedAt: "2026-08-16T10:00:00Z",
        },
        baselineAuthority: "public_deployment_marker",
        providerCurrentVerified: true,
        providerCurrent: {
          kind: "dashboard-public-marker",
          sourceRevision: baselineSha,
          workflowRunId: "700",
          workflowRunAttempt: 2,
          markerFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        classifier: {
          kind: "site-tree-oid",
          contractVersion: 1,
          baselineTreeOid: baselineSiteTree,
          currentTreeOid: currentSiteTree,
        },
      }),
    ]);
    expect(result.authorizesMutation).toBe(false);
    expect(result.authorizesDeployment).toBe(false);
    expect(result.authorizesRetry).toBe(false);
    expect(await Bun.file(fixture.outputPath).json()).toEqual(result);
    expect(calls).toContain(`/repos/${repository}/actions/runs/123`);
    expect(calls).toContain(`/repos/${repository}/actions/workflows/ci.yml`);
    expect(calls).toContain(`/repos/${repository}/actions/runs/123/artifacts?name=exact-ref-validation-receipt-123-1&per_page=2`);
    expect(calls).toContain(`/repos/${repository}/actions/runs/700`);
    expect(calls).toContain(`/repos/${repository}/actions/workflows/publish-dashboard-on-main.yml`);
    expect(calls).toContain(`/repos/${repository}/compare/${baselineSha}...${currentSha}?per_page=1`);
    expect(calls.some((call) => call.includes("/.well-known/stensibly-deployment.json"))).toBe(true);
    expect(calls.some((call) => call.includes("deploy-worker.yml/runs"))).toBe(false);
    expect(calls.some((call) => call.includes("deploy-convex.yml/runs"))).toBe(false);
  });

  test("admits a bounded comparison response with a large provider diff patch", async () => {
    const fixture = await localFixture();
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { comparePatchLength: 48_000 }),
    );

    expect(result.targets[2]).toEqual(expect.objectContaining({
      target: "dashboard",
      decision: "would_dispatch",
      reason: "site_tree_changed",
      history: "ahead",
    }));
  });

  test("rejects duplicate-key JSON, unexpected files, and symlinked receipt files", async () => {
    const duplicate = await exactReceiptDirectory('{"schemaVersion":"a","schemaVersion":"b"}\n');
    await expect(readExactCiReceiptDirectory(duplicate)).rejects.toThrow("Duplicate JSON object key");

    const unexpected = await exactReceiptDirectory(JSON.stringify(exactReceipt()));
    await writeFile(join(unexpected, "extra.txt"), "unexpected", "utf8");
    await expect(readExactCiReceiptDirectory(unexpected)).rejects.toThrow("exactly the JSON and checksum");

    const linked = await exactReceiptDirectory(JSON.stringify(exactReceipt()));
    const linkedJson = join(linked, "exact-ref-validation-receipt.json");
    await unlink(linkedJson);
    await symlink(join(linked, "exact-ref-validation-receipt.sha256"), linkedJson);
    await expect(readExactCiReceiptDirectory(linked)).rejects.toThrow("bounded ordinary files");
  });

  test("rejects run, repository, artifact, and local content drift", async () => {
    const fixture = await localFixture();
    await expect(runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { runRepositoryId: repositoryId + 1 }),
    )).rejects.toThrow("exact canonical main-push identity");

    const artifactFixture = await localFixture();
    await expect(runDeploymentReconciliationObserver(
      artifactFixture.environment,
      githubStub([], { artifactHeadSha: baselineSha }),
    )).rejects.toThrow("artifact metadata");

    const damaged = await localFixture();
    await writeFile(
      join(damaged.receiptDirectory, "exact-ref-validation-receipt.json"),
      `${JSON.stringify({ ...exactReceipt(), status: "failure" })}\n`,
      "utf8",
    );
    await expect(runDeploymentReconciliationObserver(
      damaged.environment,
      githubStub([]),
    )).rejects.toThrow("checksum");
  });

  test("keeps every artifact and output path inside RUNNER_TEMP", async () => {
    const fixture = await localFixture();
    await expect(runDeploymentReconciliationObserver({
      ...fixture.environment,
      CI_RECEIPT_DIRECTORY: join(tmpdir(), "outside-receipt"),
    }, githubStub([]))).rejects.toThrow("inside RUNNER_TEMP");
    await expect(runDeploymentReconciliationObserver({
      ...fixture.environment,
      DEPLOYMENT_RECONCILIATION_OUTPUT: join(tmpdir(), "outside-output.json"),
    }, githubStub([]))).rejects.toThrow("inside RUNNER_TEMP");
  });

  test("rejects an oversized API response before retaining provider content", async () => {
    const fixture = await localFixture();
    await expect(runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { oversizedRun: true }),
    )).rejects.toThrow("exceeded the reconciliation bound");
  });

  test("requires exactly one name-filtered artifact in an exact envelope", async () => {
    const excessive = await localFixture();
    await expect(runDeploymentReconciliationObserver(
      excessive.environment,
      githubStub([], { artifactTotalCount: 101, artifactArrayLength: 1 }),
    )).rejects.toThrow("Artifact total count");

    const mismatched = await localFixture();
    await expect(runDeploymentReconciliationObserver(
      mismatched.environment,
      githubStub([], { artifactTotalCount: 1, artifactArrayLength: 2 }),
    )).rejects.toThrow("Artifact list envelope is invalid");
  });

  test("uses the exact successful publication named by the public marker", async () => {
    const fixture = await localFixture();
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([]),
    );
    expect(result.targets[2]?.latestSuccessfulWorkflow).toEqual({
      runId: "700",
      runAttempt: 2,
      revision: baselineSha,
      updatedAt: "2026-08-16T10:00:00Z",
    });
    expect(result.targets[2]?.providerCurrentVerified).toBe(true);
    expect(result.targets[2]?.decision).toBe("would_dispatch");
  });

  test("fails closed when the marker does not bind a successful protected run", async () => {
    const fixture = await localFixture();
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { dashboardRunConclusion: "failure" }),
    );
    expect(result.targets[2]).toEqual(expect.objectContaining({
      decision: "classification_unknown",
      reason: "provider_current_observation_failed",
      providerCurrentVerified: false,
      providerCurrent: null,
    }));
  });

  test("fails closed on malformed or oversized public marker evidence", async () => {
    const fixture = await localFixture();
    const malformed = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { dashboardMarkerFingerprint: `sha256:${"0".repeat(64)}` }),
    );
    expect(malformed.targets[2]?.reason).toBe("provider_current_observation_failed");

    const oversizedFixture = await localFixture();
    const oversized = await runDeploymentReconciliationObserver(
      oversizedFixture.environment,
      githubStub([], { oversizedDashboardMarker: true }),
    );
    expect(oversized.targets[2]?.reason).toBe("provider_current_observation_failed");
  });

  test("fails closed when provider current moves during observation", async () => {
    const fixture = await localFixture();
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { dashboardMarkerRevisions: [baselineSha, otherSha] }),
    );
    expect(result.targets[2]).toEqual(expect.objectContaining({
      decision: "classification_unknown",
      reason: "provider_current_observation_failed",
      providerCurrentVerified: false,
      providerCurrent: null,
    }));
  });

  test("reuses one dashboard tree read when the successful baseline is current", async () => {
    const fixture = await localFixture();
    const calls: string[] = [];
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub(calls, {
        dashboardMarkerRevision: currentSha,
      }),
    );
    expect(result.targets[2]?.decision).toBe("not_relevant");
    expect(calls.filter((call) => call.endsWith(`/git/commits/${currentSha}`))).toHaveLength(1);
    expect(calls.some((call) => call.includes("/compare/"))).toBe(false);
  });

  test("makes target evidence non-actionable when main advances during observation", async () => {
    const fixture = await localFixture();
    const result = await runDeploymentReconciliationObserver(
      fixture.environment,
      githubStub([], { mainRevisions: [currentSha, otherSha] }),
    );
    expect(result.currentMainRevision).toBe(otherSha);
    expect(result.targets.map((target) => target.decision)).toEqual([
      "waiting_current_main",
      "waiting_current_main",
      "waiting_current_main",
    ]);
    expect(result.targets.some((target) =>
      target.decision === "would_dispatch" || target.decision === "not_relevant")).toBe(false);
  });

  test("rejects observer workflow or checked-out source provenance drift", async () => {
    const workflowDrift = await localFixture();
    await expect(runDeploymentReconciliationObserver({
      ...workflowDrift.environment,
      GITHUB_WORKFLOW_SHA: otherSha,
    }, githubStub([]))).rejects.toThrow("Observer workflow and source revisions");

    const sourceDrift = await localFixture();
    await expect(runDeploymentReconciliationObserver({
      ...sourceDrift.environment,
      OBSERVER_SOURCE_REVISION: otherSha,
    }, githubStub([]))).rejects.toThrow("Observer workflow and source revisions");
  });
});

async function localFixture(): Promise<Readonly<{
  environment: DeploymentReconciliationEnvironment;
  receiptDirectory: string;
  outputPath: string;
  contentDigest: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), "stensibly-deployment-reconciliation-"));
  temporaryRoots.push(root);
  const receiptDirectory = join(root, "exact-ci-receipt");
  const json = `${JSON.stringify(exactReceipt())}\n`;
  await writeReceiptFiles(receiptDirectory, json);
  const outputPath = join(root, "deployment-reconciliation-shadow.json");
  return Object.freeze({
    environment: Object.freeze({
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_REPOSITORY: repository,
      GITHUB_REPOSITORY_ID: String(repositoryId),
      GITHUB_TOKEN: "test-token",
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_SHA: currentSha,
      OBSERVER_SOURCE_REVISION: currentSha,
      RUNNER_TEMP: root,
      CI_RECEIPT_DIRECTORY: receiptDirectory,
      DEPLOYMENT_RECONCILIATION_OUTPUT: outputPath,
      TRIGGER_RUN_ID: "123",
      TRIGGER_RUN_ATTEMPT: "1",
      TRIGGER_HEAD_SHA: currentSha,
    }),
    receiptDirectory,
    outputPath,
    contentDigest: sha256(json),
  });
}

async function exactReceiptDirectory(json: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stensibly-exact-ci-receipt-"));
  temporaryRoots.push(root);
  const directory = join(root, "receipt");
  await writeReceiptFiles(directory, json);
  return directory;
}

async function writeReceiptFiles(directory: string, json: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const digest = sha256(json).slice("sha256:".length);
  await Promise.all([
    writeFile(join(directory, "exact-ref-validation-receipt.json"), json, "utf8"),
    writeFile(
      join(directory, "exact-ref-validation-receipt.sha256"),
      `${digest}  exact-ref-validation-receipt.json\n`,
      "utf8",
    ),
  ]);
}

function exactReceipt() {
  return {
    schemaVersion: "stensibly-ci-exact-ref-receipt/1",
    repository,
    eventName: "push",
    sourceRevision: currentSha,
    eventRevision: currentSha,
    workflowRevision: currentSha,
    workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
    validationProfile: "full_parallel",
    inputValid: true,
    status: "success",
    jobs: {
      browserEvidence: "success",
      repositoryTests: "success",
      runtimeParity: "success",
      serialFull: "skipped",
    },
    run: {
      id: "123",
      attempt: "1",
      url: `https://github.com/${repository}/actions/runs/123`,
    },
    completedAt: "2026-08-16T11:59:00Z",
  };
}

function githubStub(
  calls: string[],
  override: GitHubStubOverride = {},
): typeof fetch {
  let mainRead = 0;
  let markerRead = 0;
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = `${url.pathname}${url.search}`;
    calls.push(call);
    if (url.hostname === "www.stensibly.com") {
      const markerRevisions = override.dashboardMarkerRevisions
        ?? [override.dashboardMarkerRevision ?? baselineSha];
      const markerRevision = markerRevisions[
        Math.min(markerRead, markerRevisions.length - 1)
      ] ?? baselineSha;
      markerRead += 1;
      const marker = compileDashboardDeploymentMarker({
        repository,
        sourceRevision: markerRevision,
        workflowRevision: markerRevision,
        runId: "700",
        runAttempt: "2",
      });
      const body = override.oversizedDashboardMarker
        ? "x".repeat(2_049)
        : JSON.stringify({
          ...marker,
          fingerprint: override.dashboardMarkerFingerprint ?? marker.fingerprint,
        });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const prefix = `/repos/${repository}`;
    const path = call.slice(prefix.length);
    if (override.oversizedRun && path === "/actions/runs/123") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
      });
    }
    if (path === "/git/ref/heads/main") {
      const revisions = override.mainRevisions ?? [currentSha];
      const revision = revisions[Math.min(mainRead, revisions.length - 1)] ?? currentSha;
      mainRead += 1;
      return new Response(JSON.stringify({ object: { sha: revision } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = responseFixture(path, override);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function responseFixture(
  path: string,
  override: GitHubStubOverride,
): unknown {
  if (path === "/actions/runs/123") return {
    id: 123,
    run_attempt: 1,
    workflow_id: 319014676,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: currentSha,
    status: "completed",
    conclusion: "success",
    repository: { id: override.runRepositoryId ?? repositoryId, full_name: repository },
    head_repository: { id: repositoryId, full_name: repository },
  };
  if (path === "/actions/workflows/ci.yml") return {
    id: 319014676,
    name: "CI",
    path: ".github/workflows/ci.yml",
  };
  if (path === "/actions/runs/700") return {
    id: 700,
    run_attempt: 2,
    workflow_id: 1447,
    path: ".github/workflows/publish-dashboard-on-main.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: override.dashboardMarkerRevision ?? baselineSha,
    status: "completed",
    conclusion: override.dashboardRunConclusion ?? "success",
    updated_at: "2026-08-16T10:00:00Z",
    repository: { id: repositoryId, full_name: repository },
    head_repository: { id: repositoryId, full_name: repository },
  };
  if (path === "/actions/workflows/publish-dashboard-on-main.yml") return {
    id: 1447,
    name: "Publish Dashboard Production",
    path: ".github/workflows/publish-dashboard-on-main.yml",
  };
  if (path === "/actions/runs/123/artifacts?name=exact-ref-validation-receipt-123-1&per_page=2") {
    const artifact = {
      id: 789,
      name: "exact-ref-validation-receipt-123-1",
      size_in_bytes: 16_000,
      expired: false,
      digest: `sha256:${"1".repeat(64)}`,
      workflow_run: {
        id: 123,
        repository_id: repositoryId,
        head_repository_id: repositoryId,
        head_branch: "main",
        head_sha: override.artifactHeadSha ?? currentSha,
      },
    };
    return {
      total_count: override.artifactTotalCount ?? 1,
      artifacts: Array.from({ length: override.artifactArrayLength ?? 1 }, () => artifact),
    };
  }
  if (path === `/compare/${baselineSha}...${currentSha}?per_page=1`) return {
    status: "ahead",
    files: override.comparePatchLength === undefined
      ? []
      : [{ patch: "x".repeat(override.comparePatchLength) }],
  };
  if (path === `/git/commits/${baselineSha}`) return { tree: { sha: baselineRootTree } };
  if (path === `/git/commits/${currentSha}`) return { tree: { sha: currentRootTree } };
  if (path === `/git/trees/${baselineRootTree}`) {
    return { tree: [{ path: "site", type: "tree", sha: baselineSiteTree }] };
  }
  if (path === `/git/trees/${currentRootTree}`) {
    return { tree: [{ path: "site", type: "tree", sha: currentSiteTree }] };
  }
  throw new Error(`Unexpected GitHub test request: ${path}`);
}

interface GitHubStubOverride {
  readonly runRepositoryId?: number;
  readonly artifactHeadSha?: string;
  readonly artifactTotalCount?: number;
  readonly artifactArrayLength?: number;
  readonly oversizedRun?: boolean;
  readonly dashboardMarkerRevision?: string;
  readonly dashboardMarkerRevisions?: readonly string[];
  readonly dashboardMarkerFingerprint?: string;
  readonly oversizedDashboardMarker?: boolean;
  readonly dashboardRunConclusion?: "success" | "failure";
  readonly mainRevisions?: readonly string[];
  readonly comparePatchLength?: number;
}
