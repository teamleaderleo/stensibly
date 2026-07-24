import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/deploy-dashboard.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

function position(value: string): number {
  const index = workflow.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("production dashboard deployment workflow", () => {
  test("is manual, main-only, serialized, and environment-gated", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Require main branch");
    expect(workflow).toContain('refs/heads/main');
    expect(workflow).toContain("group: stensibly-dashboard-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).not.toMatch(/^\s*push:/m);
  });

  test("runs secret-free candidate checks before production approval", () => {
    expect(workflow).toContain("name: Validate dashboard production candidate");
    expect(workflow).toContain("needs: test");
    expect(position("name: Validate dashboard production candidate"))
      .toBeLessThan(position("environment:"));
    expect(position("bun run worker:check"))
      .toBeLessThan(position("environment:"));
    const candidate = workflow.slice(position("test:"), position("deploy:"));
    expect(candidate).not.toContain("secrets.");
    expect(candidate).toContain("bun install --frozen-lockfile");
    expect(candidate).toContain("bun run typecheck");
    expect(candidate).toContain("bun run test");
    expect(candidate).toContain("bun run test:convex");
    expect(candidate).toContain("bun run verify:dashboard -- --html-file site/index.html");
  });

  test("uses a pinned Vercel CLI and only dashboard deployment secrets", () => {
    expect(workflow).toContain("VERCEL_CLI_VERSION: 56.5.0");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION}");
    expect(workflow).not.toContain("vercel@latest");
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("STENSIBLY_READ_TOKEN");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("CONVEX_URL");
  });

  test("requires the existing stensibly project and configured site root", () => {
    expect(workflow).toContain("EXPECTED_VERCEL_PROJECT: stensibly");
    expect(workflow).toContain("api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}");
    expect(workflow).toContain("project_name");
    expect(workflow).toContain('!= "${EXPECTED_VERCEL_PROJECT}"');
    expect(workflow).toContain("rootDirectory // empty");
    expect(workflow).toContain('!= "site"');
    expect(position("Require the stensibly Vercel project"))
      .toBeLessThan(position("Pull production project settings"));
    expect(workflow).toContain(".vercel/project.json");
    expect(workflow).toContain(".projectId == $project and .orgId == $org");
    expect(workflow).not.toContain("stensibly-api");
  });

  test("builds from the repository root, stages without domains, verifies, then promotes once", () => {
    expect(workflow).not.toContain("--cwd site");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} build");
    expect(workflow).toContain(".vercel/output/config.json");
    expect(workflow).toContain(".vercel/output/static");
    expect(workflow).toContain("--prebuilt");
    expect(workflow).toContain("--prod");
    expect(workflow).toContain("--skip-domain");
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} curl /");
    expect(workflow).toContain("--deployment \"${DEPLOYMENT_URL}\"");
    expect(workflow.match(/vercel@\$\{VERCEL_CLI_VERSION\} promote/g)).toHaveLength(1);
    expect(position("Create staged production deployment"))
      .toBeLessThan(position("Verify staged deployment"));
    expect(position("Verify staged deployment"))
      .toBeLessThan(position("Promote verified deployment"));
  });

  test("requires staged asset markers and rejects token-shaped content before promotion", () => {
    expect(workflow).toContain("asset_specs=(");
    expect(workflow).toContain('\"/app.js|DEFAULT_ENDPOINT\"');
    expect(workflow).toContain('\"/item-progress-controller.js|installProgressController\"');
    expect(workflow).toContain('\"/item-block-controller.js|installBlockController\"');
    expect(workflow).toContain('\"/item-complete-controller.js|installCompletionController\"');
    expect(workflow).toContain('\"/project-brief-controller.js|installProjectBriefController\"');
    expect(workflow).toContain('\"/project-brief.css|.project-brief-dialog\"');
    expect(workflow).toContain("grep --fixed-strings --quiet");
    expect(workflow).toContain("stn\\.tok_[A-Za-z0-9._-]+");
    expect(position("asset_specs=("))
      .toBeLessThan(position("Promote verified deployment"));
  });

  test("verifies production with retries and records rollback-safe diagnostics", () => {
    expect(workflow).toContain("https://www.stensibly.com");
    expect(workflow).toContain("for attempt in 1 2 3");
    expect(workflow).toContain("bun run verify:dashboard -- --url");
    expect(workflow).toContain("Use an explicit Vercel rollback decision");
    expect(workflow).toContain("verified staged deployment");
    expect(workflow).toContain("promoted production domain");
    expect(position("Promote verified deployment"))
      .toBeLessThan(position("Verify production dashboard"));
  });
});
