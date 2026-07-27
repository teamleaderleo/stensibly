import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-oauth-auto-rollout.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

function section(start: string, end: string): string {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThan(-1);
  expect(endIndex).toBeGreaterThan(startIndex);
  return workflow.slice(startIndex, endIndex);
}

const oauthBindings = [
  "STENSIBLY_OAUTH_SIGNING_SECRET",
  "STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS",
  "STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS",
  "STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS",
];

describe("manual W01 OAuth rollout workflow", () => {
  test("has no scheduled or push-triggered production authority", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("cron:");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("branches:");
    expect(workflow).not.toContain("paths:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("group: w01-oauth-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment:\n      name: production");
  });

  test("requires an explicit fresh approval, generation, and confirmation", () => {
    expect(workflow).toContain("approval_reference:");
    expect(workflow).toContain("rollout_generation:");
    expect(workflow).toContain("confirm_rollout:");
    expect(workflow).toContain("if: ${{ inputs.confirm_rollout == true }}");
    expect(workflow).toContain("APPROVAL_REFERENCE: ${{ inputs.approval_reference }}");
    expect(workflow).toContain("ROLLOUT_GENERATION: ${{ inputs.rollout_generation }}");
    expect(workflow).toContain("^issue-[0-9]+-comment-[0-9]+$");
    expect(workflow).toContain("^w01-[A-Za-z0-9._-]{1,64}$");
    expect(workflow).toContain("INVALID_APPROVAL_REFERENCE");
    expect(workflow).toContain("INVALID_ROLLOUT_GENERATION");
    expect(workflow).not.toContain("issue-220-comment-5093505474");
    expect(workflow).not.toContain("issue-220-comment-5094418635");
  });

  test("pins every rollout command to the exact reviewed application revision", () => {
    expect(workflow).toContain(
      "ROLLOUT_SOURCE_SHA: 5ee0852904dad614d46edbd10453e96e04ba409f",
    );
    expect(workflow).toContain("ref: ${{ env.ROLLOUT_SOURCE_SHA }}");
    expect(workflow).toContain("deployed source: \\`$ROLLOUT_SOURCE_SHA\\`");
    expect(workflow).not.toContain("github.sha");
  });

  test("uses exact protected secret mappings without accepting secret inputs", () => {
    for (const name of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "STENSIBLY_READ_TOKEN",
      "CONVEX_DEPLOY_KEY",
    ]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(workflow).toContain(
      "GITHUB_OAUTH_CLIENT_ID: ${{ secrets.STENSIBLY_GITHUB_OAUTH_CLIENT_ID }}",
    );
    expect(workflow).toContain(
      "GITHUB_OAUTH_CLIENT_SECRET: ${{ secrets.STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET }}",
    );
    expect(workflow).not.toContain("inputs.client");
    expect(workflow).not.toContain("inputs.secret");
    expect(workflow).toContain('"$CONVEX_DEPLOY_KEY" != prod:*');
    expect(workflow).toContain("CONVEX_DEPLOY_KEY_PRODUCTION_SCOPE");
  });

  test("uses fixed reviewed identities and accepts no free-form targets", () => {
    expect(workflow).toContain("CANONICAL_ORIGIN: https://api.stensibly.com");
    expect(workflow).toContain(
      "WORKER_ORIGIN: https://stensibly-api.leoli-082000.workers.dev",
    );
    expect(workflow).toContain("AUTH_RETURN_ORIGINS: https://www.stensibly.com");
    expect(workflow).toContain('AUTH_ALLOWED_GITHUB_SUBJECTS: "13091533"');
    expect(workflow).toContain("AUTH_BOOTSTRAP_ROLE: owner");
    expect(workflow).not.toContain("inputs.endpoint");
    expect(workflow).not.toContain("inputs.issuer");
    expect(workflow).not.toContain("inputs.subject");
  });

  test("treats advertised but unverified OAuth as ambiguous", () => {
    const state = section(
      "Classify current public auth state",
      "Stop on ambiguous existing OAuth state",
    );
    expect(state).toContain("retry bun run verify:oauth");
    expect(state).toContain("retry bun run verify:oauth -- --expect disabled");
    expect(state).toContain('.surfaces | index("oauth") != null');
    expect(state).toContain('echo "auth_state=ambiguous_oauth" >> "$GITHUB_OUTPUT"');
    expect(state).toContain('echo "auth_state=needs_hosted_auth" >> "$GITHUB_OUTPUT"');
    expect(state).not.toContain("recover_oauth");
  });

  test("fails closed on ambiguous OAuth without deletion or deployment", () => {
    const hold = section(
      "Stop on ambiguous existing OAuth state",
      "Run exact candidate checks",
    );
    expect(hold).toContain("steps.state.outputs.auth_state == 'ambiguous_oauth'");
    expect(hold).toContain("No binding deletion, deployment, or signing-secret rotation");
    expect(hold).toContain("exit 1");

    expect(workflow).not.toContain("Clear OAuth bindings from an unverified prior enablement");
    expect(workflow).not.toContain("auth_state=recover_oauth");

    const checks = section("Run exact candidate checks", "Deploy current Convex functions");
    expect(checks).toContain("auth_state == 'disabled'");
    expect(checks).toContain("auth_state == 'needs_hosted_auth'");
    expect(checks).not.toContain("ambiguous_oauth");

    const convex = section(
      "Deploy current Convex functions",
      "Configure hosted GitHub auth and prove disabled state",
    );
    expect(convex).toContain("auth_state == 'disabled'");
    expect(convex).toContain("auth_state == 'needs_hosted_auth'");
    expect(convex).not.toContain("ambiguous_oauth");
  });

  test("runs the full gate and deploys Convex before Worker changes", () => {
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "bun run test:convex",
      "bun run worker:check",
    ]) {
      expect(workflow).toContain(command);
    }
    const convexDeploy = workflow.indexOf("bunx convex deploy");
    const firstWorkerDeploy = workflow.indexOf("bunx wrangler deploy --secrets-file");
    expect(convexDeploy).toBeGreaterThan(-1);
    expect(firstWorkerDeploy).toBeGreaterThan(convexDeploy);
    expect(workflow).not.toContain("bun run worker:deploy");
  });

  test("configures hosted auth only when it is missing", () => {
    const phaseOne = section(
      "Configure hosted GitHub auth and prove disabled state",
      "Enable MCP OAuth atomically",
    );
    expect(phaseOne).toContain("if: steps.state.outputs.auth_state == 'needs_hosted_auth'");
    expect(phaseOne).not.toContain("recover_oauth");
    expect(phaseOne).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(phaseOne).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(phaseOne).not.toContain("STENSIBLY_OAUTH_SIGNING_SECRET");
    expect(phaseOne).toContain("retry bun run verify:oauth -- --expect disabled");
  });

  test("enables all four OAuth bindings only from a proved disabled baseline", () => {
    const enable = section(
      "Enable MCP OAuth atomically",
      "Verify bearer compatibility and enabled OAuth",
    );
    expect(enable).toContain("steps.state.outputs.auth_state == 'disabled'");
    expect(enable).toContain("steps.phase1.outcome == 'success'");
    expect(enable).toContain('signing_secret="$(openssl rand -hex 32)"');
    for (const name of oauthBindings) expect(enable).toContain(name);
    expect(enable).toContain('bunx wrangler deploy --secrets-file "$secrets_file"');
    expect(workflow.match(/bunx wrangler deploy --secrets-file/g)).toHaveLength(2);
  });

  test("rolls back only a failed enable from the current dispatch", () => {
    const rollback = section(
      "Roll back OAuth bindings after a failed current enable attempt",
      "Record successful or already-enabled state",
    );
    expect(rollback).toContain("failure()");
    expect(rollback).toContain("steps.state.outputs.auth_state != 'enabled'");
    expect(rollback).toContain("steps.enable.outcome != 'skipped'");
    for (const name of oauthBindings) {
      expect(rollback).toContain(`\"${name}\": null`);
    }
    expect(rollback).toContain('bunx wrangler secret bulk "$rollback_file"');
    expect(workflow.match(/bunx wrangler secret bulk/g)).toHaveLength(1);
  });

  test("does not expose credentials and records the manual generation", () => {
    expect(workflow).not.toContain('echo "$GITHUB_OAUTH_CLIENT_SECRET"');
    expect(workflow).not.toContain('echo "$signing_secret"');
    expect(workflow).not.toContain('cat "$secrets_file"');
    expect(workflow).toContain("if: steps.verify_enabled.outcome == 'success'");
    expect(workflow).toContain("approval: \\`$APPROVAL_REFERENCE\\`");
    expect(workflow).toContain("generation: \\`$ROLLOUT_GENERATION\\`");
  });
});
