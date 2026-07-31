import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_RELEASE_WINDOW_CONTRACT_VERSION,
  decideDashboardRelease,
  hasActiveDashboardRun,
  isDashboardReleasePath,
  latestAttemptedDashboardSha,
  latestSuccessfulDashboardSha,
  runDashboardReleaseWindow,
  type DashboardWorkflowRun,
} from "../scripts/dashboard-release-window.ts";

const currentSha = "a".repeat(40);
const baselineSha = "b".repeat(40);
const olderSha = "c".repeat(40);
const publisherPath = "/actions/workflows/publish-dashboard-on-main.yml";
const baseEnvironment = Object.freeze({
  FORCE_DASHBOARD_RELEASE: "false",
  GITHUB_API_URL: "https://api.github.test",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "teamleaderleo/stensibly",
  GITHUB_TOKEN: "test-token",
});

describe("dashboard release-window policy", () => {
  test("publishes one versioned contract and a closed dashboard path allowlist", () => {
    expect(DASHBOARD_RELEASE_WINDOW_CONTRACT_VERSION).toBe(1);
    for (const path of [
      "site/index.html",
      "site/labs/studio-canvas/app.js",
      "package.json",
      "bun.lock",
      "src/dashboard-assets.ts",
      "src/dashboard-deployment-diagnostics.ts",
      "src/verify-dashboard.ts",
      "scripts/link-vercel-project-domain.sh",
      ".github/workflows/auto-deploy-dashboard.yml",
      ".github/workflows/deploy-dashboard.yml",
      ".github/workflows/publish-dashboard-on-main.yml",
    ]) expect(isDashboardReleasePath(path)).toBe(true);

    for (const path of [
      "test/dashboard.test.ts",
      "docs/dashboard-auto-publication.md",
      "src/worker.ts",
      "/site/index.html",
      "site/../package.json",
      "site\\index.html",
      "site//index.html",
      "site/index.html\nother",
    ]) expect(isDashboardReleasePath(path)).toBe(false);
  });

  test("coalesces every active GitHub Actions state", () => {
    for (const status of ["requested", "waiting", "pending", "queued", "in_progress"]) {
      expect(hasActiveDashboardRun([workflowRun({ status })])).toBe(true);
    }
    expect(hasActiveDashboardRun([
      workflowRun({ status: "completed", conclusion: "success" }),
      workflowRun({ status: "completed", conclusion: "failure" }),
    ])).toBe(false);
  });

  test("selects the newest successful publication and newest attempt independently", () => {
    const runs = [
      workflowRun({ headSha: olderSha, createdAt: "2026-07-31T10:00:00Z", conclusion: "success" }),
      workflowRun({ headSha: currentSha, createdAt: "2026-07-31T12:00:00Z", conclusion: "failure" }),
      workflowRun({ headSha: baselineSha, createdAt: "2026-07-31T11:00:00Z", conclusion: "success" }),
      workflowRun({ headSha: "invalid", createdAt: "2026-07-31T14:00:00Z", conclusion: "success" }),
      workflowRun({ headSha: baselineSha, createdAt: "invalid", conclusion: "success" }),
    ];
    expect(latestSuccessfulDashboardSha(runs)).toBe(baselineSha);
    expect(latestAttemptedDashboardSha(runs)).toBe(currentSha);
    expect(latestSuccessfulDashboardSha([])).toBeNull();
    expect(latestAttemptedDashboardSha([])).toBeNull();
  });

  test("dispatches force, a first baseline, and relevant accumulated changes", () => {
    expect(decideDashboardRelease({
      force: true,
      activeRun: true,
      currentSha,
      baselineSha: currentSha,
      attemptedSha: currentSha,
    })).toEqual({ action: "dispatch", reason: "manual_force" });
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha,
      attemptedSha: baselineSha,
      compareStatus: "ahead",
      changedFiles: ["docs/readme.md", "site/app.js"],
    })).toEqual({ action: "dispatch", reason: "relevant_changes" });
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha: null,
      attemptedSha: null,
    })).toEqual({ action: "dispatch", reason: "missing_baseline" });
  });

  test("skips occupied, current, attempted, empty, uncertain, and non-linear windows", () => {
    expect(decideDashboardRelease({
      force: false,
      activeRun: true,
      currentSha,
      baselineSha,
      attemptedSha: baselineSha,
      compareStatus: "ahead",
      changedFiles: ["site/app.js"],
    })).toEqual({ action: "skip", reason: "active_run" });
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha: currentSha,
      attemptedSha: currentSha,
    })).toEqual({ action: "skip", reason: "already_current" });
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha,
      attemptedSha: currentSha,
    })).toEqual({ action: "skip", reason: "already_attempted" });
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha,
      attemptedSha: baselineSha,
      compareStatus: "ahead",
      changedFiles: ["test/dashboard.test.ts"],
    })).toEqual({ action: "skip", reason: "no_relevant_changes" });
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha,
      attemptedSha: baselineSha,
      compareStatus: "unavailable",
    })).toEqual({ action: "skip", reason: "comparison_unavailable" });
    for (const compareStatus of ["diverged", "behind"] as const) {
      expect(decideDashboardRelease({
        force: false,
        activeRun: false,
        currentSha,
        baselineSha,
        attemptedSha: baselineSha,
        compareStatus,
      })).toEqual({ action: "skip", reason: "history_not_linear" });
    }
    expect(decideDashboardRelease({
      force: false,
      activeRun: false,
      currentSha,
      baselineSha,
      attemptedSha: baselineSha,
      compareStatus: "ahead",
      changedFiles: Array.from({ length: 300 }, (_, index) => `test/file-${index}.ts`),
      compareTruncated: true,
    })).toEqual({ action: "skip", reason: "comparison_truncated" });
  });
});

describe("dashboard release-window GitHub coordinator", () => {
  test("queues the repaired publisher once for relevant accumulated changes", async () => {
    const calls: ApiCall[] = [];
    const request = createGithubStub(calls, {
      currentSha,
      runs: [workflowRun({ headSha: baselineSha, conclusion: "success" })],
      comparison: { status: "ahead", files: ["docs/readme.md", "site/app.js"] },
    });
    await expect(runDashboardReleaseWindow(baseEnvironment, request)).resolves.toEqual({
      action: "dispatch",
      reason: "relevant_changes",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "POST"]);
    expect(calls.at(-1)?.url.endsWith(`${publisherPath}/dispatches`)).toBe(true);
    expect(calls.at(-1)?.body).toBe('{"ref":"main"}');
  });

  test("exits when the successful publication already covers main", async () => {
    const calls: ApiCall[] = [];
    await expect(runDashboardReleaseWindow(baseEnvironment, createGithubStub(calls, {
      currentSha,
      runs: [workflowRun({ headSha: currentSha, conclusion: "success" })],
    }))).resolves.toEqual({ action: "skip", reason: "already_current" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  });

  test("does not retry an unchanged failed publication automatically", async () => {
    const calls: ApiCall[] = [];
    await expect(runDashboardReleaseWindow(baseEnvironment, createGithubStub(calls, {
      currentSha,
      runs: [
        workflowRun({ headSha: baselineSha, conclusion: "success", createdAt: "2026-07-31T10:00:00Z" }),
        workflowRun({ headSha: currentSha, conclusion: "failure", createdAt: "2026-07-31T12:00:00Z" }),
      ],
    }))).resolves.toEqual({ action: "skip", reason: "already_attempted" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  });

  test("coalesces scheduled work while force queues the publisher", async () => {
    const active = workflowRun({ status: "in_progress", conclusion: null, headSha: baselineSha });
    const scheduledCalls: ApiCall[] = [];
    await expect(runDashboardReleaseWindow(
      baseEnvironment,
      createGithubStub(scheduledCalls, { currentSha, runs: [active] }),
    )).resolves.toEqual({ action: "skip", reason: "active_run" });
    expect(scheduledCalls.map((call) => call.method)).toEqual(["GET", "GET"]);

    const forcedCalls: ApiCall[] = [];
    await expect(runDashboardReleaseWindow(
      { ...baseEnvironment, FORCE_DASHBOARD_RELEASE: "true" },
      createGithubStub(forcedCalls, { currentSha, runs: [active] }),
    )).resolves.toEqual({ action: "dispatch", reason: "manual_force" });
    expect(forcedCalls.map((call) => call.method)).toEqual(["GET", "GET", "POST"]);
  });

  test("fails closed before API use for an invalid ref or force value", async () => {
    let calls = 0;
    const request = (async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await expect(runDashboardReleaseWindow(
      { ...baseEnvironment, GITHUB_REF: "refs/heads/feature" },
      request,
    )).rejects.toThrow("main branch");
    await expect(runDashboardReleaseWindow(
      { ...baseEnvironment, FORCE_DASHBOARD_RELEASE: "yes" },
      request,
    )).rejects.toThrow("must be true or false");
    expect(calls).toBe(0);
  });
});

interface ApiCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

function workflowRun(override: Partial<DashboardWorkflowRun> = {}): DashboardWorkflowRun {
  return {
    status: "completed",
    conclusion: "success",
    headSha: olderSha,
    createdAt: "2026-07-31T10:00:00Z",
    ...override,
  };
}

function createGithubStub(
  calls: ApiCall[],
  fixture: Readonly<{
    currentSha: string;
    runs: readonly DashboardWorkflowRun[];
    comparison?: Readonly<{
      status: "ahead" | "identical" | "behind" | "diverged";
      files: readonly string[];
    }>;
  }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, body });

    if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
      return jsonResponse({ object: { sha: fixture.currentSha } });
    }
    if (method === "GET" && url.includes(`${publisherPath}/runs?`)) {
      return jsonResponse({ workflow_runs: fixture.runs.map((run) => ({
        status: run.status,
        conclusion: run.conclusion,
        head_sha: run.headSha,
        created_at: run.createdAt,
      })) });
    }
    if (method === "GET" && url.includes("/compare/")) {
      if (!fixture.comparison) return jsonResponse({ message: "missing comparison" }, 404);
      return jsonResponse({
        status: fixture.comparison.status,
        files: fixture.comparison.files.map((filename) => ({ filename })),
      });
    }
    if (method === "POST" && url.endsWith(`${publisherPath}/dispatches`)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ message: "unexpected request" }, 404);
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
