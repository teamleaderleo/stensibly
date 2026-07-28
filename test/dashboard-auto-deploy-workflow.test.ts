import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/auto-deploy-dashboard.yml", import.meta.url),
).text();

describe("automatic dashboard production dispatch", () => {
  test("runs only for dashboard-related pushes to main", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("paths:");
    for (const path of [
      "site/**",
      "src/dashboard-assets.ts",
      "src/dashboard-deployment-diagnostics.ts",
      "src/verify-dashboard.ts",
      "package.json",
      "bun.lock",
      "tsconfig.json",
      ".github/workflows/deploy-dashboard.yml",
      ".github/workflows/auto-deploy-dashboard.yml",
    ]) {
      expect(workflow).toContain(`- ${path}`);
    }
    expect(workflow).not.toContain("pull_request:");
  });

  test("has only the authority needed to dispatch the guarded workflow", () => {
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toContain("persist-credentials");
  });

  test("dispatches the existing main-only production workflow", () => {
    expect(workflow).toContain("actions/workflows/deploy-dashboard.yml/dispatches");
    expect(workflow).toContain("--data '{\"ref\":\"main\"}'");
    expect(workflow).toContain("Authorization: Bearer ${GITHUB_TOKEN}");
    expect(workflow).toContain("X-GitHub-Api-Version: 2022-11-28");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
