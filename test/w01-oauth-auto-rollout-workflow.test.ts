import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-oauth-auto-rollout.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("contained W01 OAuth rollout workflow", () => {
  test("has no automatic trigger", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("cron:");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("branches:");
  });

  test("fails closed before any step can execute", () => {
    expect(workflow).toContain("if: ${{ false }}");
    expect(workflow).toContain("contained by issue #367");
    expect(workflow).not.toContain("environment:\n      name: production");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("wrangler");
    expect(workflow).not.toContain("convex deploy");
  });

  test("preserves the exact provenance and repair boundary", () => {
    expect(workflow).toContain("PR #358");
    expect(workflow).toContain(
      "c0008c32cccc6eb4ad6c443360cda49c7a3bb0df",
    );
    expect(workflow).toContain("evidence and partial-state findings");
  });
});
