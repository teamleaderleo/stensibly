import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-observe-consent-deployment-once.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("W01 one-time consent deployment observer", () => {
  test("is a one-time main-push observer with narrow permissions", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("w01-observe-consent-deployment-once.yml");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("issues: write");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
  });

  test("pins the exact deployment workflow, head, and issue", () => {
    expect(workflow).toContain("w01-deploy-consent-origin-fix-once.yml");
    expect(workflow).toContain("67d43d34e4fd99905d49f94c653893426e5772fb");
    expect(workflow).toContain('TARGET_ISSUE: "286"');
    expect(workflow).toContain("GITHUB_RUN_ATTEMPT");
  });

  test("uses the Actions API and records a bounded result", () => {
    expect(workflow).toContain("gh api");
    expect(workflow).toContain(".workflow_runs[]");
    expect(workflow).toContain("seq 1 100");
    expect(workflow).toContain("sleep 20");
    expect(workflow).toContain("gh issue comment");
    expect(workflow).toContain('conclusion" != "success');
    expect(workflow).not.toContain("secrets.");
  });
});
