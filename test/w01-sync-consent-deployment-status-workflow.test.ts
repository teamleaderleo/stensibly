import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-sync-consent-deployment-status.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("W01 recurring consent deployment status sync", () => {
  test("runs every five minutes and supports immediate refresh", () => {
    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("w01-sync-consent-deployment-status.yml");
  });

  test("uses narrow read and issue-update permissions", () => {
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).not.toContain("secrets.");
  });

  test("reads the latest deployment run and updates one durable comment", () => {
    expect(workflow).toContain("w01-deploy-consent-origin-fix-once.yml");
    expect(workflow).toContain('TARGET_ISSUE: "286"');
    expect(workflow).toContain("per_page=1");
    expect(workflow).toContain("w01-consent-deployment-status");
    expect(workflow).toContain("issues/comments/$comment_id");
    expect(workflow).toContain("--method PATCH");
    expect(workflow).toContain("--method POST");
  });

  test("surfaces failed deployments while allowing queued runs to keep syncing", () => {
    expect(workflow).toContain('status" == "completed');
    expect(workflow).toContain('conclusion" != "success');
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow).not.toContain("GITHUB_RUN_ATTEMPT");
  });
});
