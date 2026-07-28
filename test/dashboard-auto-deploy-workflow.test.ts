import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/auto-deploy-dashboard.yml", import.meta.url),
).text();

describe("quota-aware dashboard production dispatch", () => {
  test("uses a lightweight two-hour reconciliation schedule instead of every push", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("cron: '17 */2 * * *'");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("pull_request:");
  });

  test("has only the authority needed to inspect and dispatch workflows", () => {
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toContain("persist-credentials");
  });

  test("coalesces active runs and enforces a rolling production budget", () => {
    expect(workflow).toContain("MAX_AUTO_DEPLOYS_PER_24H: '4'");
    for (const status of ["requested", "waiting", "pending", "queued", "in_progress"]) {
      expect(workflow).toContain(`.status == \"${status}\"`);
    }
    expect(workflow).toContain("date -u -d '24 hours ago' +%s");
    expect(workflow).toContain("fromdateiso8601");
    expect(workflow).toContain("Dashboard deployment budget reached");
  });

  test("dispatches only for dashboard-relevant changes since the last success", () => {
    expect(workflow).toContain("actions/workflows/deploy-dashboard.yml/runs");
    expect(workflow).toContain(".conclusion == \"success\"");
    expect(workflow).toContain("/compare/${latest_success_sha}...${current_sha}");
    for (const marker of [
      "site/",
      "src/dashboard-assets",
      "src/dashboard-deployment-diagnostics",
      "src/verify-dashboard",
      "package",
      "bun",
      "tsconfig",
      "deploy-dashboard|auto-deploy-dashboard",
    ]) {
      expect(workflow).toContain(marker);
    }
    expect(workflow).toContain("No dashboard release needed");
  });

  test("retains the exact guarded main deployment target", () => {
    expect(workflow).toContain("actions/workflows/deploy-dashboard.yml/dispatches");
    expect(workflow).toContain("--data '{\"ref\":\"main\"}'");
    expect(workflow).toContain("Authorization: Bearer ${GITHUB_TOKEN}");
    expect(workflow).toContain("X-GitHub-Api-Version: 2022-11-28");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
