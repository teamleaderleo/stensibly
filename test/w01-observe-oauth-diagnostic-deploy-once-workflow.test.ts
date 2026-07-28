import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-observe-oauth-diagnostic-deploy-once.yml", import.meta.url),
  "utf8",
);

describe("W01 OAuth diagnostic deployment observer", () => {
  test("is one-time and read-only against deployment state", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain(
      "contains(github.event.head_commit.added, '.github/workflows/w01-observe-oauth-diagnostic-deploy-once.yml')",
    );
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("worker:deploy");
    expect(workflow).not.toContain("wrangler rollback");
  });

  test("queries the exact deployment generation and proves its critical steps", () => {
    expect(workflow).toContain(
      "DEPLOYMENT_SHA: 0bb34bafc614c12c40e948bdc78ff72860763907",
    );
    expect(workflow).toContain(
      "DEPLOYMENT_WORKFLOW: w01-deploy-oauth-diagnostic-once.yml",
    );
    expect(workflow).toContain("actions/workflows/$DEPLOYMENT_WORKFLOW/runs?head_sha=$DEPLOYMENT_SHA");
    expect(workflow).toContain("Deploy accepted diagnostic to the dogfood Worker");
    expect(workflow).toContain("Verify deployed bearer and enabled OAuth state");
    expect(workflow).toContain("$matches[0].conclusion == \"success\"");
  });

  test("records the active Worker and independently verifies both origins", () => {
    expect(workflow).toContain("wrangler deployments list --name stensibly-api --json");
    expect(workflow).toContain("https://api.stensibly.com");
    expect(workflow).toContain("https://stensibly-api.leoli-082000.workers.dev");
    expect(workflow).toContain("bun run verify:hosted");
    expect(workflow).toContain("bun run verify:oauth -- --expect enabled");
    expect(workflow).toContain("oauth-worker.txt");
  });

  test("posts only bounded evidence and retains it briefly", () => {
    expect(workflow).toContain("permissions:\n  actions: read\n  contents: read\n  issues: write");
    expect(workflow).toContain("gh issue comment 402 --body-file evidence/issue-comment.md");
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).not.toContain("echo $CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("echo $STENSIBLY_READ_TOKEN");
  });
});
