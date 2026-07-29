import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/auto-deploy-dashboard.yml", import.meta.url),
).text();

describe("automatic dashboard production dispatch", () => {
  test("reacts immediately to deployable main changes", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");

    for (const path of [
      '"site/**"',
      '"src/dashboard-assets.ts"',
      '"src/dashboard-deployment-diagnostics.ts"',
      '"src/verify-dashboard.ts"',
      '"package.json"',
      '"bun.lock"',
      '".github/workflows/deploy-dashboard.yml"',
      '".github/workflows/auto-deploy-dashboard.yml"',
    ]) {
      expect(workflow).toContain(path);
    }
  });

  test("has only the authority needed to dispatch the guarded workflow", () => {
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toContain("persist-credentials");
  });

  test("does not delay or drop a relevant main push", () => {
    expect(workflow).not.toContain("MAX_AUTO_DEPLOYS_PER_24H");
    expect(workflow).not.toContain("MIN_SECONDS_BETWEEN_AUTO_DEPLOYS");
    expect(workflow).not.toContain("24 hours ago");
    expect(workflow).not.toContain("release window");
    expect(workflow).not.toContain("cooldown");
    expect(workflow).not.toContain("active_count");
    expect(workflow).not.toContain("deployment coalesced");
  });

  test("dispatches the guarded main production target", () => {
    expect(workflow).toContain("actions/workflows/deploy-dashboard.yml/dispatches");
    expect(workflow).toContain("--data '{\"ref\":\"main\"}'");
    expect(workflow).toContain("Authorization: Bearer ${GITHUB_TOKEN}");
    expect(workflow).toContain("X-GitHub-Api-Version: 2022-11-28");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
