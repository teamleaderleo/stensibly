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

describe("guarded W01 OAuth rollout workflow", () => {
  test("requires manual dispatch and the protected production environment", () => {
    expect(workflow).toContain("name: W01 guarded OAuth rollout");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("push:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("group: w01-oauth-guarded-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment:\n      name: production");
  });

  test("pins the approved application and records both durable decisions", () => {
    expect(workflow).toContain(
      "ROLLOUT_SOURCE_SHA: 5ee0852904dad614d46edbd10453e96e04ba409f",
    );
    expect(workflow).toContain("ref: ${{ env.ROLLOUT_SOURCE_SHA }}");
    expect(workflow).toContain(
      "ROLLOUT_APPROVAL_REFERENCE: issue-220-comment-5093505474",
    );
    expect(workflow).toContain(
      "ROLLOUT_DECISION_REFERENCE: issue-220-comment-5094418635",
    );
    expect(workflow).toContain("rollout approval: \\`$ROLLOUT_APPROVAL_REFERENCE\\`");
    expect(workflow).toContain("corrected decision: \\`$ROLLOUT_DECISION_REFERENCE\\`");
  });

  test("fails closed when protected prerequisites are missing", () => {
    for (const name of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "STENSIBLY_READ_TOKEN",
      "CONVEX_DEPLOY_KEY",
    ]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
      expect(workflow).toContain(`\\\n            ${name}`);
    }
    expect(workflow).toContain(
      "GITHUB_OAUTH_CLIENT_ID: ${{ secrets.STENSIBLY_GITHUB_OAUTH_CLIENT_ID }}",
    );
    expect(workflow).toContain(
      "GITHUB_OAUTH_CLIENT_SECRET: ${{ secrets.STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET }}",
    );
    expect(workflow).toContain('"$CONVEX_DEPLOY_KEY" != prod:*');
    expect(workflow).toContain("CONVEX_DEPLOY_KEY_PRODUCTION_SCOPE");
    expect(workflow).toContain("MERGED_GUARDED_ABUSE_HARNESS");
    expect(workflow).toContain("W01 guarded OAuth rollout blocked");
    expect(workflow).toContain("dispatch again");
    expect(workflow).not.toContain("hourly workflow");
  });

  test("uses fixed reviewed identities and accepts no free-form rollout targets", () => {
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

  test("classifies verified enabled and disabled states before health inspection", () => {
    const state = section(
      "Classify current public auth state",
      "Run exact candidate checks",
    );
    expect(state).toContain("for attempt in 1 2 3");
    expect(state).toContain("retry bun run verify:oauth");
    expect(state).toContain("retry bun run verify:oauth -- --expect disabled");
    expect(state).toContain('echo "auth_state=enabled" >> "$GITHUB_OUTPUT"');
    expect(state).toContain('echo "auth_state=disabled" >> "$GITHUB_OUTPUT"');
    expect(state).toContain('curl --fail --silent --show-error --max-time 10 "$origin/health"');
    expect(state).toContain('.service == "stensibly"');
  });

  test("fails closed when OAuth is advertised but enabled verification fails", () => {
    const state = section(
      "Classify current public auth state",
      "Run exact candidate checks",
    );
    expect(state).toContain('.surfaces | index("oauth") != null');
    expect(state).toContain('echo "auth_state=ambiguous_oauth" >> "$GITHUB_OUTPUT"');
    expect(state).toContain("No OAuth binding is removed or rotated");
    expect(state).toContain("fresh Tier 3 recovery decision");
    expect(state).toContain("exit 1");
    expect(state).not.toContain("recover_oauth");
    expect(workflow).not.toContain("Clear OAuth bindings from an unverified prior enablement");
  });

  test("runs the repository gate and deploys Convex before a Worker mutation", () => {
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

  test("configures hosted auth only from an observed missing-auth state", () => {
    const phaseOne = section(
      "Configure hosted GitHub auth and prove disabled state",
      "Enable MCP OAuth atomically",
    );
    expect(phaseOne).toContain("steps.state.outputs.auth_state == 'needs_hosted_auth'");
    expect(phaseOne).not.toContain("ambiguous_oauth");
    expect(phaseOne).not.toContain("recover_oauth");
    expect(phaseOne).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(phaseOne).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(phaseOne).toContain("STENSIBLY_AUTH_ORIGIN");
    expect(phaseOne).not.toContain("STENSIBLY_OAUTH_SIGNING_SECRET");
    expect(phaseOne).toContain('bunx wrangler deploy --secrets-file "$secrets_file"');
    expect(phaseOne).toContain("retry bun run verify:hosted");
    expect(phaseOne).toContain("retry bun run verify:oauth -- --expect disabled");
  });

  test("enables the four bounded OAuth bindings only from a proved disabled baseline", () => {
    const enable = section(
      "Enable MCP OAuth atomically",
      "Verify bearer compatibility and enabled OAuth",
    );
    expect(enable).toContain("steps.state.outputs.auth_state == 'disabled'");
    expect(enable).toContain("steps.phase1.outcome == 'success'");
    expect(enable).toContain('signing_secret="$(openssl rand -hex 32)"');
    for (const name of oauthBindings) {
      expect(enable).toContain(name);
    }
    expect(enable).toContain('bunx wrangler deploy --secrets-file "$secrets_file"');
    expect(workflow.match(/bunx wrangler deploy --secrets-file/g)).toHaveLength(2);
  });

  test("verifies bearer compatibility and OAuth on both fixed origins", () => {
    const verification = section(
      "Verify bearer compatibility and enabled OAuth",
      "Roll back OAuth bindings after a failed current enable attempt",
    );
    expect(verification).toContain("steps.state.outputs.auth_state == 'enabled'");
    expect(verification).toContain("steps.enable.outcome == 'success'");
    expect(verification).toContain("retry bun run verify:hosted");
    expect(verification).toContain(
      'retry bun run verify:hosted -- --endpoint "$WORKER_ORIGIN"',
    );
    expect(verification).toContain("retry bun run verify:oauth");
    expect(verification).toContain('--issuer "$CANONICAL_ORIGIN"');
  });

  test("retains rollback only for the current failed enable attempt", () => {
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
    expect(rollback).toContain("retry bun run verify:oauth -- --expect disabled");
    expect(workflow.match(/bunx wrangler secret bulk/g)).toHaveLength(1);
  });

  test("keeps credentials out of logs and records completion after verification", () => {
    expect(workflow).not.toContain('echo "$GITHUB_OAUTH_CLIENT_SECRET"');
    expect(workflow).not.toContain('echo "$signing_secret"');
    expect(workflow).not.toContain('cat "$secrets_file"');
    expect(workflow).toContain("if: steps.verify_enabled.outcome == 'success'");
    expect(workflow).toContain("bearer compatibility: passed on both origins");
    expect(workflow).toContain("public OAuth enabled verification: passed on both origins");
  });
});
