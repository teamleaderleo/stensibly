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

describe("automatic W01 OAuth rollout workflow", () => {
  test("is resumable, serialized, production-scoped, and read-only", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('cron: "17 * * * *"');
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain(
      'paths:\n      - ".github/workflows/w01-oauth-auto-rollout.yml"',
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("group: w01-oauth-auto-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment:\n      name: production");
  });

  test("pins every rollout command to the exact approved application revision", () => {
    expect(workflow).toContain(
      "ROLLOUT_SOURCE_SHA: 5ee0852904dad614d46edbd10453e96e04ba409f",
    );
    expect(workflow).toContain("ref: ${{ env.ROLLOUT_SOURCE_SHA }}");
    expect(workflow).toContain("deployed source: \\`$ROLLOUT_SOURCE_SHA\\`");
    expect(workflow).not.toContain("DEPLOY_SHA: ${{ github.sha }}");
  });

  test("uses the exact protected secret mappings before becoming ready", () => {
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
    expect(workflow).toContain("\\\n            GITHUB_OAUTH_CLIENT_ID");
    expect(workflow).toContain("\\\n            GITHUB_OAUTH_CLIENT_SECRET");
    expect(workflow).toContain('"$CONVEX_DEPLOY_KEY" != prod:*');
    expect(workflow).toContain("CONVEX_DEPLOY_KEY_PRODUCTION_SCOPE");
    expect(workflow).toContain("src/verify-oauth-abuse.ts");
    expect(workflow).toContain('grep -q \'"verify:oauth-abuse"\' package.json');
    expect(workflow).toContain("MERGED_GUARDED_ABUSE_HARNESS");
    expect(workflow).toContain('echo "ready=false" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("The hourly workflow will retry automatically");
  });

  test("uses fixed reviewed identities and accepts no free-form rollout targets", () => {
    expect(workflow).toContain("CANONICAL_ORIGIN: https://api.stensibly.com");
    expect(workflow).toContain(
      "WORKER_ORIGIN: https://stensibly-api.leoli-082000.workers.dev",
    );
    expect(workflow).toContain("AUTH_RETURN_ORIGINS: https://www.stensibly.com");
    expect(workflow).toContain('AUTH_ALLOWED_GITHUB_SUBJECTS: "13091533"');
    expect(workflow).toContain("AUTH_BOOTSTRAP_ROLE: owner");
    expect(workflow).toContain("APPROVAL_REFERENCE: issue-220-comment-5093505474");
    expect(workflow).not.toContain("inputs.endpoint");
    expect(workflow).not.toContain("inputs.issuer");
    expect(workflow).not.toContain("inputs.subject");
  });

  test("classifies verified states before inspecting bounded health surfaces", () => {
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
    expect(state).toContain('.surfaces | index("oauth") != null');
    expect(state).toContain('echo "auth_state=recover_oauth" >> "$GITHUB_OUTPUT"');
    expect(state).toContain('echo "auth_state=needs_hosted_auth" >> "$GITHUB_OUTPUT"');
    expect(state).toContain("Could not inspect the canonical Stensibly health surface");
    expect(state).toContain("Could not inspect the Worker Stensibly health surface");
  });

  test("does not mutate before both fixed origins are classifiable", () => {
    const stateCheck = workflow.indexOf("Classify current public auth state");
    const candidateChecks = workflow.indexOf("Run exact candidate checks");
    const convexDeploy = workflow.indexOf("Deploy current Convex functions");
    const recovery = workflow.indexOf(
      "Clear OAuth bindings from an unverified prior enablement",
    );
    expect(stateCheck).toBeGreaterThan(-1);
    expect(candidateChecks).toBeGreaterThan(stateCheck);
    expect(convexDeploy).toBeGreaterThan(candidateChecks);
    expect(recovery).toBeGreaterThan(convexDeploy);

    const candidateSection = section(
      "Run exact candidate checks",
      "Deploy current Convex functions",
    );
    expect(candidateSection).toContain(
      "steps.state.outputs.auth_state != 'enabled'",
    );
  });

  test("runs the repository gate and deploys Convex before Worker changes", () => {
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "bun run test:convex",
      "bun run worker:check",
    ]) {
      expect(workflow).toContain(command);
    }
    const convexDeploy = workflow.indexOf("bunx convex deploy");
    const firstWorkerChange = workflow.indexOf("bunx wrangler secret bulk");
    const firstWorkerDeploy = workflow.indexOf("bunx wrangler deploy --secrets-file");
    expect(convexDeploy).toBeGreaterThan(-1);
    expect(firstWorkerChange).toBeGreaterThan(convexDeploy);
    expect(firstWorkerDeploy).toBeGreaterThan(firstWorkerChange);
    expect(workflow).not.toContain("bun run worker:deploy");
  });

  test("recovers OAuth left by an interrupted earlier run", () => {
    const recovery = section(
      "Clear OAuth bindings from an unverified prior enablement",
      "Configure hosted GitHub auth and prove disabled state",
    );
    expect(recovery).toContain(
      "if: steps.state.outputs.auth_state == 'recover_oauth'",
    );
    for (const name of oauthBindings) {
      expect(recovery).toContain(`\"${name}\": null`);
    }
    expect(recovery).not.toContain('"GITHUB_OAUTH_CLIENT_SECRET": null');
    expect(recovery).not.toContain('"STENSIBLY_SERVICE_SECRET": null');
    expect(recovery).toContain('bunx wrangler secret bulk "$rollback_file"');

    const recoveryIndex = workflow.indexOf(
      "Clear OAuth bindings from an unverified prior enablement",
    );
    const phaseOneIndex = workflow.indexOf(
      "Configure hosted GitHub auth and prove disabled state",
    );
    expect(phaseOneIndex).toBeGreaterThan(recoveryIndex);
  });

  test("rebuilds hosted auth after either a missing or recovered state", () => {
    const phaseOne = section(
      "Configure hosted GitHub auth and prove disabled state",
      "Enable MCP OAuth atomically",
    );
    expect(phaseOne).toContain(
      "steps.state.outputs.auth_state == 'needs_hosted_auth'",
    );
    expect(phaseOne).toContain(
      "steps.state.outputs.auth_state == 'recover_oauth'",
    );
    expect(phaseOne).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(phaseOne).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(phaseOne).toContain("STENSIBLY_AUTH_ORIGIN");
    expect(phaseOne).not.toContain("STENSIBLY_OAUTH_SIGNING_SECRET");
    expect(phaseOne).toContain('bunx wrangler deploy --secrets-file "$secrets_file"');
    expect(phaseOne).toContain("retry bun run verify:hosted");
    expect(phaseOne).toContain("retry bun run verify:oauth -- --expect disabled");
  });

  test("enables all four bounded OAuth bindings only from a proved disabled baseline", () => {
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
    expect(workflow).toContain('OAUTH_ACCESS_TOKEN_SECONDS: "600"');
    expect(workflow).toContain('OAUTH_AUTHORIZATION_CODE_SECONDS: "300"');
    expect(workflow).toContain('OAUTH_REFRESH_TOKEN_SECONDS: "2592000"');
  });

  test("verifies both bearer and OAuth paths for new and existing enablement", () => {
    const verification = section(
      "Verify bearer compatibility and enabled OAuth",
      "Roll back OAuth bindings after a failed enable attempt",
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

  test("rolls back a failed current enable attempt without requiring prior success", () => {
    const rollback = section(
      "Roll back OAuth bindings after a failed enable attempt",
      "Record successful or already-enabled state",
    );
    expect(rollback).toContain("failure()");
    expect(rollback).toContain("steps.state.outputs.auth_state != 'enabled'");
    expect(rollback).toContain("steps.enable.outcome != 'skipped'");
    expect(rollback).not.toContain("steps.enable.outcome == 'success'");
    for (const name of oauthBindings) {
      expect(rollback).toContain(`\"${name}\": null`);
    }
    expect(rollback).toContain('bunx wrangler secret bulk "$rollback_file"');
    expect(rollback).toContain("retry bun run verify:oauth -- --expect disabled");
    expect(workflow.match(/bunx wrangler secret bulk/g)).toHaveLength(2);
  });

  test("does not expose credentials and reports completion only after verification", () => {
    expect(workflow).not.toContain('echo "$GITHUB_OAUTH_CLIENT_SECRET"');
    expect(workflow).not.toContain('echo "$signing_secret"');
    expect(workflow).not.toContain('cat "$secrets_file"');
    expect(workflow).toContain("if: steps.verify_enabled.outcome == 'success'");
    expect(workflow).toContain("bearer compatibility: passed on both origins");
    expect(workflow).toContain("public OAuth enabled verification: passed on both origins");
  });
});
