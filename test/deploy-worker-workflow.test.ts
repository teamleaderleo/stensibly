import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/deploy-worker.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("production Worker deployment workflow", () => {
  test("is manual, main-only, serialized, and environment-gated", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Require main branch");
    expect(workflow).toContain("refs/heads/main");
    expect(workflow).toContain("group: stensibly-worker-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).not.toMatch(/^\s*push:/m);
  });

  test("runs checks before entering the production environment", () => {
    expect(workflow).toContain("name: Validate production candidate");
    expect(workflow).toContain("needs: test");
    expect(workflow.indexOf("name: Validate production candidate"))
      .toBeLessThan(workflow.indexOf("name: production"));
    expect(workflow.indexOf("bun run worker:check"))
      .toBeLessThan(workflow.indexOf("environment:"));
  });

  test("requires only the deployment and read-verification secrets", () => {
    expect(workflow).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("secrets.STENSIBLY_READ_TOKEN");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("CONVEX_URL");
    expect(workflow).not.toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(workflow).not.toContain("STENSIBLY_OAUTH_SIGNING_SECRET");
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

  test("uses a typed declared OAuth state without accepting network targets", () => {
    expect(workflow).toContain("oauth_expectation:");
    expect(workflow).toContain("type: choice");
    expect(workflow).toContain("- disabled");
    expect(workflow).toContain("- enabled");
    expect(workflow).toContain("OAUTH_EXPECTATION: ${{ inputs.oauth_expectation }}");
    expect(workflow).not.toContain("inputs.endpoint");
    expect(workflow).not.toContain("inputs.issuer");
  });

  test("deploys once and verifies bearer and public OAuth state on both origins", () => {
    expect(workflow.match(/bun run worker:deploy/g)).toHaveLength(1);
    expect(workflow).toContain("https://stensibly-api.leoli-082000.workers.dev");
    expect(workflow).toContain("https://api.stensibly.com");
    expect(workflow.match(/bun run verify:hosted/g)).toHaveLength(2);
    expect(workflow.match(/bun run verify:oauth/g)).toHaveLength(2);
    expect(workflow).toContain('--expect "$OAUTH_EXPECTATION"');
    expect(workflow.match(/for attempt in 1 2 3/g)).toHaveLength(4);

    const finalBearer = workflow.indexOf("Verify official endpoint bearer compatibility");
    const firstOAuth = workflow.indexOf("Verify Worker fallback public OAuth state");
    expect(finalBearer).toBeGreaterThan(-1);
    expect(firstOAuth).toBeGreaterThan(finalBearer);
  });

  test("records the declared state only after every verification gate", () => {
    const officialOAuth = workflow.indexOf("Verify official endpoint public OAuth state");
    const summary = workflow.indexOf("Record deployment summary");
    expect(officialOAuth).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(officialOAuth);
    expect(workflow).toContain("Declared OAuth state");
    expect(workflow).toContain("Legacy bearer verification: passed on both origins");
    expect(workflow).toContain("Public auth/OAuth verification: passed on both origins");
  });
});
