import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/deploy-worker.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("production Worker deployment workflow", () => {
  test("deploys relevant main changes automatically and keeps manual recovery", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain('"src/**"');
    expect(workflow).toContain('"wrangler.jsonc"');
    expect(workflow).toContain('"config/worker-production-bindings.json"');
    expect(workflow).toContain('"scripts/worker-production-release.ts"');
    expect(workflow).toContain('"scripts/worker-production-receipt.ts"');
    expect(workflow).not.toContain('"wrangler.toml"');
    expect(workflow).toContain('"package.json"');
    expect(workflow).toContain('"bun.lock"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Require main branch");
    expect(workflow).toContain("refs/heads/main");
    expect(workflow).toContain("group: stensibly-worker-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("Release exact production Worker candidate");
  });

  test("runs checks before entering the production environment", () => {
    expect(workflow).toContain("name: Validate production candidate");
    expect(workflow).toContain("needs: test");
    expect(workflow.indexOf("name: Validate production candidate"))
      .toBeLessThan(workflow.indexOf("name: production"));
    expect(workflow.indexOf("bun run worker:check"))
      .toBeLessThan(workflow.indexOf("environment:"));
  });

  test("requires deployment credentials and the production Worker secret inventory", () => {
    expect(workflow).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("secrets.STENSIBLY_READ_TOKEN");
    expect(workflow).toContain(
      "wrangler secret list --name stensibly-api --format json --config wrangler.jsonc",
    );
    expect(workflow).toContain("CONVEX_URL");
    expect(workflow).toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).toContain("STENSIBLY_GITHUB_APP_ID");
    expect(workflow).toContain("STENSIBLY_GITHUB_APP_PRIVATE_KEY");
    expect(workflow).toContain("STENSIBLY_GITHUB_INSTALLATION_ID");
    expect(workflow).toContain("STENSIBLY_GITHUB_WEBHOOK_SECRET");
    expect(workflow).not.toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(workflow).not.toContain("STENSIBLY_OAUTH_SIGNING_SECRET");
    expect(workflow.indexOf(
      "wrangler secret list --name stensibly-api --format json --config wrangler.jsonc",
    ))
      .toBeLessThan(workflow.indexOf("bun run worker:deploy"));
  });

  test("runs locked checks before deployment", () => {
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run typecheck");
    expect(workflow).toContain("bun run test");
    expect(workflow).toContain("bun run test:convex");
    expect(workflow).toContain("bun run worker:check");
    expect(workflow.indexOf("bun run worker:check"))
      .toBeLessThan(workflow.indexOf("bun run worker:deploy"));
  });

  test("keeps OAuth enabled for automatic deployments", () => {
    expect(workflow).toContain("oauth_expectation:");
    expect(workflow).toContain("type: choice");
    expect(workflow).toContain("default: enabled");
    expect(workflow).toContain("- disabled");
    expect(workflow).toContain("- enabled");
    expect(workflow).toContain(
      "OAUTH_EXPECTATION: ${{ github.event_name == 'workflow_dispatch' && inputs.oauth_expectation || 'enabled' }}",
    );
    expect(workflow).not.toContain("inputs.endpoint");
    expect(workflow).not.toContain("inputs.issuer");
  });

  test("runs one guarded release instead of an immediate Wrangler deployment", () => {
    expect(workflow.match(/bun run worker:deploy/g)).toHaveLength(1);
    expect(workflow).not.toContain("wrangler deploy");
    expect(workflow).toContain('--expected-sha "$GITHUB_SHA"');
    expect(workflow).toContain('--oauth-expectation "$OAUTH_EXPECTATION"');
    expect(workflow).toContain('--github-output "$GITHUB_OUTPUT"');
  });

  test("records exact candidate proof and automatic recovery state", () => {
    const release = workflow.indexOf("Release exact production Worker candidate");
    const summary = workflow.indexOf("Record deployment summary");
    expect(release).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(release);
    expect(workflow).toContain("Declared OAuth state");
    expect(workflow).toContain("Exact current-main check: passed before upload and promotion");
    expect(workflow).toContain("Uploaded production binding inventory: passed");
    expect(workflow).toContain("Candidate preview verification: passed before promotion");
    expect(workflow).toContain("Hosted API + MCP verification: passed on both origins");
    expect(workflow).not.toContain("Legacy bearer verification: passed on both origins");
    expect(workflow).toContain("Public auth/OAuth verification: passed on both origins");
    expect(workflow).toContain("Record failed release and recovery state");
    expect(workflow).toContain("steps.release.outputs.recovered || 'false'");
    expect(workflow).toContain("captured baseline was restored and health-checked");
    expect(workflow).toContain(
      "active deployment is unknown; manually reconcile Cloudflare before retrying",
    );
    expect(workflow).not.toContain("candidate did not remain at 100% traffic");
  });

  test("publishes a protected provider-current receipt without exposing credentials", () => {
    const release = workflow.indexOf("Release exact production Worker candidate");
    const receipt = workflow.indexOf("Record provider-current Worker receipt");
    const upload = workflow.indexOf("Upload provider-current Worker receipt");
    expect(receipt).toBeGreaterThan(release);
    expect(upload).toBeGreaterThan(receipt);
    expect(workflow).toContain("bun scripts/worker-production-receipt.ts");
    expect(workflow).toContain("${{ runner.temp }}/worker-production-deployment-receipt.json");
    expect(workflow).toContain("worker-production-receipt-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("steps.release.outcome == 'failure'");
    expect(workflow.slice(receipt, upload)).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow.slice(upload, workflow.indexOf("Record deployment summary")))
      .not.toContain("secrets.CLOUDFLARE_API_TOKEN");
  });

  test("budgets enough time for typed routing convergence on both hosted origins", () => {
    const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));
    expect(deployJob).toContain("timeout-minutes: 30");
  });
});
