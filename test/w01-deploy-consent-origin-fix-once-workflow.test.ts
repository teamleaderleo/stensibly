import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-deploy-consent-origin-fix-once.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("W01 one-time consent-origin deployment workflow", () => {
  test("runs once from a main push of the workflow file", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("w01-deploy-consent-origin-fix-once.yml");
    expect(workflow).toContain('GITHUB_RUN_ATTEMPT\" != \"1');
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
  });

  test("pins the merged repair and uses the production gate", () => {
    expect(workflow).toContain("02697a4ba15b9c129d854a90acc63ccabaa6fc2d");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("group: stensibly-worker-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("persist-credentials: false");
  });

  test("checks the candidate before one deploy", () => {
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run typecheck");
    expect(workflow).toContain("bun run test");
    expect(workflow).toContain("bun run test:convex");
    expect(workflow).toContain("bun run worker:check");
    expect(workflow.match(/bun run worker:deploy/g)).toHaveLength(1);
  });

  test("captures recovery and verifies both origins", () => {
    expect(workflow).toContain("previous_version");
    expect(workflow).toContain("wrangler rollback");
    expect(workflow).toContain("https://api.stensibly.com");
    expect(workflow).toContain("https://stensibly-api.leoli-082000.workers.dev");
    expect(workflow.match(/bun run verify:hosted/g)?.length).toBeGreaterThanOrEqual(4);
    expect(workflow.match(/bun run verify:oauth/g)?.length).toBeGreaterThanOrEqual(4);
    expect(workflow).toContain("--expect enabled");
    expect(workflow).toContain("retention-days: 3");
  });
});
