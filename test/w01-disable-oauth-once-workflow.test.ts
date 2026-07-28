import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-disable-oauth-once.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

const oauthBindings = [
  "STENSIBLY_OAUTH_SIGNING_SECRET",
  "STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS",
  "STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS",
  "STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS",
] as const;

describe("one-time production OAuth disable workflow", () => {
  test("has one push-to-main generation and no recurring or manual trigger", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain(
      'paths:\n      - ".github/workflows/w01-disable-oauth-once.yml"',
    );
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("cron:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain('if: github.event_name == \'push\' && github.ref == \'refs/heads/main\'');
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("binds the human decision and exact pre-change recovery point", () => {
    expect(workflow).toContain("APPROVAL_REFERENCE: issue-220-comment-5103728457");
    expect(workflow).toContain("PREFLIGHT_REFERENCE: issue-410-comment-5103768286");
    expect(workflow).toContain(
      "EXPECTED_PRECHANGE_DEPLOYMENT_ID: abd768e5-d932-4477-a1a8-1db897c003fe",
    );
    expect(workflow).toContain(
      "EXPECTED_PRECHANGE_VERSION_ID: ad65a3af-137a-4275-88a5-bb93acd073df",
    );
    expect(workflow).toContain(".versions[0].percentage == 100");
    expect(workflow).toContain("Active Worker deployment/version drifted after preflight");
  });

  test("deletes exactly the four OAuth bindings with JSON null semantics", () => {
    const removalStart = workflow.indexOf("Delete exactly the four MCP OAuth bindings");
    const removalEnd = workflow.indexOf("Prove exact post-change binding names");
    expect(removalStart).toBeGreaterThan(-1);
    expect(removalEnd).toBeGreaterThan(removalStart);
    const removal = workflow.slice(removalStart, removalEnd);

    for (const name of oauthBindings) {
      expect(removal).toContain(`\"${name}\": null`);
    }
    expect(removal.match(/: null/g)).toHaveLength(4);
    expect(removal).toContain('bunx wrangler secret bulk "$removal_file" --name stensibly-api');
    expect(removal).not.toContain("GITHUB_OAUTH_CLIENT_SECRET\": null");
    expect(removal).not.toContain("STENSIBLY_SERVICE_SECRET\": null");
  });

  test("requires exact pre- and post-change binding-name sets", () => {
    for (const required of [
      "CONVEX_URL",
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS",
      "STENSIBLY_AUTH_BOOTSTRAP_ROLE",
      "STENSIBLY_AUTH_ORIGIN",
      "STENSIBLY_AUTH_RETURN_ORIGINS",
      "STENSIBLY_SERVICE_SECRET",
    ]) {
      expect(workflow).toContain(required);
    }
    expect(workflow).toContain("Production binding-name set drifted after preflight");
    expect(workflow).toContain(
      "Post-change binding-name set is not the exact approved hosted-auth-only set",
    );
  });

  test("proves bearer compatibility and both public states around the change", () => {
    expect(workflow.match(/bun run verify:hosted/g)).toHaveLength(6);
    expect(workflow.match(/--expect enabled/g)).toHaveLength(4);
    expect(workflow.match(/--expect disabled/g)).toHaveLength(2);
    expect(workflow).toContain("https://api.stensibly.com");
    expect(workflow).toContain("https://stensibly-api.leoli-082000.workers.dev");
  });

  test("restores the exact pre-change version after any failed mutation", () => {
    expect(workflow).toContain(
      "if: failure() && steps.disable_oauth.outcome != 'skipped'",
    );
    expect(workflow).toContain(
      'bunx wrangler rollback "$EXPECTED_PRECHANGE_VERSION_ID"',
    );
    expect(workflow).toContain(
      'Restore exact pre-change version after failed #410 OAuth disable transition',
    );
    expect(workflow).not.toContain("bunx wrangler rollback\n");
    expect(workflow).toContain("restored-oauth-canonical.txt");
    expect(workflow).toContain("restored-oauth-worker.txt");
  });

  test("runs the full repository gate before production mutation", () => {
    const gate = workflow.indexOf("Run exact source gate");
    const mutation = workflow.indexOf("Delete exactly the four MCP OAuth bindings");
    expect(gate).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(gate);
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "bun run test:convex",
      "bun run worker:check",
    ]) {
      expect(workflow).toContain(command);
    }
  });
});
