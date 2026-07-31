import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/auto-deploy-dashboard.yml", import.meta.url),
).text();

describe("dashboard release-window workflow", () => {
  test("runs every two hours and retains an explicit manual queue", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain('cron: "17 */2 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("force:");
    expect(workflow).toContain("type: boolean");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("pull_request:");
  });

  test("uses only repository reads and guarded workflow dispatch authority", () => {
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("oven-sh/setup-bun@v2");
  });

  test("serializes coordinator decisions and delegates production effects", () => {
    expect(workflow).toContain("group: stensibly-dashboard-auto-dispatch");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("timeout-minutes: 5");
    expect(workflow).toContain("bun scripts/dashboard-release-window.ts");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(workflow).toContain("FORCE_DASHBOARD_RELEASE: ${{ inputs.force || false }}");
    expect(workflow).not.toContain("vercel");
    expect(workflow).not.toContain("curl");
    expect(workflow).not.toContain("alias set");
  });
});
