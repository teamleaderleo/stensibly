import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/auto-deploy-dashboard.yml", import.meta.url),
).text();

describe("frontend-window dashboard production dispatch", () => {
  test("uses four fixed release windows instead of reacting to every push", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("cron: '17 0,4,16,20 * * *'");
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

  test("coalesces active runs and enforces daily and cooldown budgets", () => {
    expect(workflow).toContain("MAX_AUTO_DEPLOYS_PER_24H: '4'");
    expect(workflow).toContain("MIN_SECONDS_BETWEEN_AUTO_DEPLOYS: '10800'");
    for (const status of ["requested", "waiting", "pending", "queued", "in_progress"]) {
      expect(workflow).toContain(`.status == \"${status}\"`);
    }
    expect(workflow).toContain("date -u -d '24 hours ago' +%s");
    expect(workflow).toContain("fromdateiso8601");
    expect(workflow).toContain("Dashboard release budget reached");
    expect(workflow).toContain("Dashboard release cooldown");
  });

  test("automatically releases only deployable site changes", () => {
    expect(workflow).toContain("FRONTEND_PATH_PATTERN: '^site/'");
    expect(workflow).toContain("--arg pattern \"${FRONTEND_PATH_PATTERN}\"");
    expect(workflow).toContain("No frontend release needed");
    expect(workflow).toContain("Backend, policy, test, dependency, and workflow churn stays in GitHub Actions");

    for (const broadMarker of [
      "src/dashboard-assets\\.ts$",
      "src/dashboard-deployment-diagnostics\\.ts$",
      "src/verify-dashboard\\.ts$",
      "package\\.json$",
      "bun\\.lock$",
      "tsconfig\\.json$",
      "deploy-dashboard|auto-deploy-dashboard",
    ]) {
      expect(workflow).not.toContain(broadMarker);
    }
  });

  test("fails closed when the release baseline cannot be bounded", () => {
    expect(workflow).toContain("Dashboard release baseline required");
    expect(workflow).toContain("Dashboard comparison unavailable");
    expect(workflow).toContain("Dashboard history needs review");
    expect(workflow).toContain("Dashboard comparison too large");
    expect(workflow).toContain('compare_status}" != "ahead"');
    expect(workflow).toContain('total_commits}" -gt 250');
  });

  test("retains the exact guarded main production target", () => {
    expect(workflow).toContain("actions/workflows/deploy-dashboard.yml/runs");
    expect(workflow).toContain("actions/workflows/deploy-dashboard.yml/dispatches");
    expect(workflow).toContain("--data '{\"ref\":\"main\"}'");
    expect(workflow).toContain("Authorization: Bearer ${GITHUB_TOKEN}");
    expect(workflow).toContain("X-GitHub-Api-Version: 2022-11-28");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
