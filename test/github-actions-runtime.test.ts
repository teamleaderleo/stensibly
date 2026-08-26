import { describe, expect, test } from "bun:test";

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-worker.yml",
  ".github/workflows/deploy-dashboard.yml",
] as const;

const node24CheckoutReferences = [
  "actions/checkout@v6",
  "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
] as const;

describe("GitHub Actions JavaScript runtimes", () => {
  test("uses the Node 24 checkout action in every workflow", async () => {
    for (const path of workflowPaths) {
      const workflow = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
      expect(
        node24CheckoutReferences.some((reference) => workflow.includes(reference)),
        `${path} should use a reviewed Node 24 checkout v6 reference`,
      ).toBe(true);
      expect(workflow, `${path} should not use the Node 20 checkout action`).not.toContain(
        "actions/checkout@v4",
      );
    }
  });
});
