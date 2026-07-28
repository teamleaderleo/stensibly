import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-deploy-oauth-token-reason-once.yml", import.meta.url),
  "utf8",
);

describe("W01 one-time OAuth token reason deployment", () => {
  test("runs only when the exact same-repository execution PR is opened non-draft", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain("types:\n      - opened\n    paths:");
    expect(workflow).not.toContain("      - synchronize\n");
    expect(workflow).not.toContain("      - reopened\n");
    expect(workflow).not.toContain("      - ready_for_review\n");
    expect(workflow).toContain("github.event.action == 'opened'");
    expect(workflow).toContain(
      "EXECUTION_BRANCH: nightjar/402-deploy-token-reason",
    );
    expect(workflow).toContain(
      "github.head_ref == 'nightjar/402-deploy-token-reason'",
    );
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain("github.event.pull_request.draft == false");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("pins the accepted token reason source and protected production surface", () => {
    expect(workflow).toContain(
      "REQUIRED_SOURCE_SHA: 97971f1061e99f19d3087987ce4a4524e48c5923",
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

  test("claims one durable generation before deployment without a pipefail race", () => {
    expect(workflow).toContain(
      'EXECUTION_MARKER: "<!-- stensibly-w01-oauth-token-reason-once:97971f1061e99f19d3087987ce4a4524e48c5923 -->"',
    );
    expect(workflow).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/issues/402/comments?per_page=100"',
    );
    expect(workflow).toContain(
      "--paginate --jq '.[].body' > /tmp/issue-402-comments.txt",
    );
    expect(workflow).toContain(
      'grep -Fq "$EXECUTION_MARKER" /tmp/issue-402-comments.txt',
    );
    expect(workflow).not.toContain("--jq '.[].body' | grep");
    expect(workflow).toContain("This production generation was already claimed");
    expect(workflow).toContain("gh issue comment 402 --body-file /tmp/execution-claim.md");
    expect(workflow).toContain("group: stensibly-worker-production");
    const claim = workflow.indexOf("Claim the single-use production generation");
    const deploy = workflow.indexOf("Deploy accepted token reason diagnostic");
    expect(claim).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(claim);
  });

  test("gates, deploys, and verifies both fixed origins with OAuth enabled", () => {
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
    expect(workflow).toContain("id: verify");
  });

  test("captures an exact recovery point and restores only after deployment or verification failure", () => {
    expect(workflow).toContain(
      "bunx wrangler deployments list --name stensibly-api --json",
    );
    expect(workflow).toContain("evidence/pre-version.txt");
    expect(workflow).toContain(
      "(steps.deploy.outcome == 'failure' || steps.verify.outcome == 'failure')",
    );
    expect(workflow).not.toContain(
      "if: failure() && steps.deploy.outcome != 'skipped'",
    );
    expect(workflow).toContain(
      'bunx wrangler rollback "$pre_version" --name stensibly-api',
    );
    expect(workflow).toContain("restored-oauth-canonical.txt");
    expect(workflow).toContain("restored-oauth-worker.txt");
  });

  test("posts and retains bounded evidence without secret values", () => {
    expect(workflow).toContain("permissions:\n  contents: read\n  issues: write");
    expect(workflow).toContain("gh issue comment 402");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("contains_secret_values: false");
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).not.toContain("echo $CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("echo $STENSIBLY_READ_TOKEN");
    expect(workflow).not.toContain("wrangler secret list");
  });
});
