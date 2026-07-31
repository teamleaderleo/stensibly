import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/publish-dashboard-on-main.yml", import.meta.url),
).text();

function position(value: string): number {
  const index = workflow.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("automatic dashboard publication workflow", () => {
  test("runs for merged dashboard changes and remains manually recoverable", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain('"site/**"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: stensibly-dashboard-production");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  test("keeps validation secret-free and production effects environment-gated", () => {
    const validate = workflow.slice(position("  validate:"), position("  publish:"));
    expect(validate).not.toContain("secrets.");
    expect(validate).toContain("bun run typecheck");
    expect(validate).toContain("bun run test");
    expect(validate).toContain("bun run test:convex");
    expect(validate).toContain("bun run worker:check");
    expect(validate).toContain("bun run verify:dashboard");
    expect(workflow).toContain("environment:");
    expect(workflow).toContain("name: production");
  });

  test("pins and validates the exact dashboard project before domain work", () => {
    expect(workflow).toContain("VERCEL_CLI_VERSION: 56.5.0");
    expect(workflow).toContain("EXPECTED_VERCEL_PROJECT: stensibly");
    expect(workflow).toContain("DASHBOARD_APEX: stensibly.com");
    expect(workflow).toContain("DASHBOARD_HOST: www.stensibly.com");
    expect(workflow).toContain("api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}");
    expect(workflow).toContain('.name == $name and .rootDirectory == "site"');
    expect(position("Validate Vercel project and credentials"))
      .toBeLessThan(position("Keep production public and previews protected"));
    expect(position("Keep production public and previews protected"))
      .toBeLessThan(position("Link the canonical domain to this project"));
  });

  test("keeps production public while retaining preview SSO", () => {
    expect(workflow).toContain("--request PATCH");
    expect(workflow).toContain("ssoProtection");
    expect(workflow).toContain('"deploymentType":"preview"');
    expect(workflow).not.toContain('"deploymentType":"all"');
  });

  test("adds or moves the exact canonical project domain through Vercel APIs", () => {
    expect(workflow).not.toContain("domains add");
    expect(workflow).toContain("/v9/projects/${VERCEL_PROJECT_ID}/domains?teamId=${VERCEL_ORG_ID}&limit=100");
    expect(workflow).toContain("/v1/domains/${DASHBOARD_APEX}/project-domains?teamId=${VERCEL_ORG_ID}&limit=100");
    expect(workflow).toContain("/v1/projects/${source_project}/domains/${DASHBOARD_HOST}/move?teamId=${VERCEL_ORG_ID}");
    expect(workflow).toContain("/v10/projects/${VERCEL_PROJECT_ID}/domains?teamId=${VERCEL_ORG_ID}");
    expect(workflow).toContain("{projectId: $projectId, gitBranch: null}");
    expect(workflow).toContain("{name: $name, gitBranch: null}");
    expect(workflow).toContain("Canonical domain ${operation} failed");
  });

  test("requires the provider to confirm target project ownership", () => {
    expect(workflow).toContain("/v9/projects/${VERCEL_PROJECT_ID}/domains/${DASHBOARD_HOST}?teamId=${VERCEL_ORG_ID}");
    expect(workflow).toContain(".name == $domain and .projectId == $project");
    expect(position("Link the canonical domain to this project"))
      .toBeLessThan(position("Pull and build the complete dashboard project"));
  });

  test("deploys the complete linked project, verifies immutable routes, then aliases", () => {
    expect(workflow).not.toContain("--cwd site");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} pull");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} build");
    expect(workflow).toContain("--prebuilt");
    expect(workflow).toContain("--skip-domain");
    expect(workflow).toContain("/labs/quiet-control/");
    expect(workflow).toContain("/labs/soft-companion/");
    expect(workflow).toContain("/labs/field-console/");
    expect(workflow).toContain("alias set");
    expect(position("Create and verify an immutable production deployment"))
      .toBeLessThan(position("Assign the canonical domain to the verified deployment"));
  });

  test("verifies the public root and Labs routes before recording success", () => {
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/');
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/quiet-control/');
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/soft-companion/');
    expect(workflow).toContain('https://${DASHBOARD_HOST}/labs/field-console/');
    expect(position("Verify the public dashboard and Labs routes"))
      .toBeLessThan(position("Record publication receipt"));
    expect(workflow).toContain("source: \\`${GITHUB_SHA}\\`");
    expect(workflow).toContain("immutable deployment:");
  });

  test("uses only the narrow Vercel production secrets", () => {
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("CONVEX_URL");
  });
});
