import { describe, expect, test } from "bun:test";

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-worker.yml",
  ".github/workflows/deploy-dashboard.yml",
] as const;

describe("GitHub Actions JavaScript runtimes", () => {
  test("uses the Node 24 checkout action in every workflow", async () => {
    for (const path of workflowPaths) {
      const workflow = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
      expect(workflow, `${path} should use checkout v6`).toContain("actions/checkout@v6");
      expect(workflow, `${path} should not use the Node 20 checkout action`).not.toContain(
        "actions/checkout@v4",
      );
    }
  });
});
