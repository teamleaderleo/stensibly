import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-deploy-oauth-diagnostic-once.yml", import.meta.url),
  "utf8",
);

describe("W01 one-time OAuth callback diagnostic deployment", () => {
  test("runs only when the workflow is first added to main", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain(
      "paths:\n      - \".github/workflows/w01-deploy-oauth-diagnostic-once.yml\"",
    );
    expect(workflow).toContain(
      "contains(github.event.head_commit.added, '.github/workflows/w01-deploy-oauth-diagnostic-once.yml')",
    );
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("pins the accepted diagnostic and uses the protected production surface", () => {
    expect(workflow).toContain(
      "REQUIRED_SOURCE_SHA: 06b17e1ce80b702a836078f6e88746666bb25046",
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$REQUIRED_SOURCE_SHA" "$GITHUB_SHA"',
    );
    expect(workflow).toContain("environment:\n      name: production");
    expect(workflow).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("secrets.STENSIBLY_READ_TOKEN");
    expect(workflow).toContain("persist-credentials: false");
  });

  test("gates, deploys, and verifies both fixed origins", () => {
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "bun run test:convex",
      "bun run worker:check",
      "bun run worker:deploy",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("https://api.stensibly.com");
    expect(workflow).toContain("https://stensibly-api.leoli-082000.workers.dev");
    expect(workflow).toContain("bun run verify:hosted");
    expect(workflow).toContain("bun run verify:oauth -- --expect enabled");
    expect(workflow).toContain(
      'bun run verify:oauth -- --endpoint "$WORKER_ORIGIN" --issuer "$CANONICAL_ORIGIN" --expect enabled',
    );
    expect(workflow).toContain("for attempt in 1 2 3 4 5");
  });

  test("captures an exact recovery point and rolls back after failed verification", () => {
    expect(workflow).toContain(
      "bunx wrangler deployments list --name stensibly-api --json",
    );
    expect(workflow).toContain("evidence/pre-version.txt");
    expect(workflow).toContain(
      "if: failure() && steps.deploy.outcome != 'skipped'",
    );
    expect(workflow).toContain(
      'bunx wrangler rollback "$pre_version" --name stensibly-api',
    );
    expect(workflow).toContain("restored-oauth-canonical.txt");
    expect(workflow).toContain("restored-oauth-worker.txt");
  });

  test("retains bounded evidence without secret values", () => {
    expect(workflow).toContain("contains_secret_values: false");
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).not.toContain("echo $CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("echo $STENSIBLY_READ_TOKEN");
    expect(workflow).not.toContain("wrangler secret list");
  });
});
