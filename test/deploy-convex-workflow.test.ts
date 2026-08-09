import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/deploy-convex.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("production Convex deployment workflow", () => {
  test("deploys relevant main changes through the protected production environment", () => {
    expect(workflow).toContain("name: Deploy Convex Production");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain('"convex/**"');
    expect(workflow).toContain('"src/**"');
    expect(workflow).toContain('"convex.json"');
    expect(workflow).toContain('"scripts/convex-production-deploy-key.ts"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: stensibly-convex-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("secrets.CONVEX_DEPLOY_KEY");
    expect(workflow.indexOf("secrets.CONVEX_DEPLOY_KEY"))
      .toBeGreaterThan(workflow.lastIndexOf("Install locked dependencies"));
    expect(workflow).toContain("bun run scripts/convex-production-deploy-key.ts");
  });

  test("validates the exact current main candidate before deploying", () => {
    expect(workflow).toContain("Require main branch");
    expect(workflow).toContain("refs/heads/main");
    expect(workflow).toContain("git fetch --no-tags origin refs/heads/main");
    expect(workflow).toContain('current_main="$(git rev-parse FETCH_HEAD)"');
    expect(workflow).toContain('checked_out="$(git rev-parse HEAD)"');
    expect(workflow).toContain('"$current_main" != "$GITHUB_SHA"');
    expect(workflow).toContain("git status --porcelain=v1 --untracked-files=all");
    expect(workflow.indexOf("Require unchanged current main immediately before deployment"))
      .toBeLessThan(workflow.indexOf("Deploy exact production Convex functions and schema"));
    expect(workflow.indexOf("Analyze the exact Convex schema and bundle"))
      .toBeLessThan(workflow.indexOf(
        "Require unchanged current main immediately before deployment",
      ));
    expect(workflow).toContain("Record post-deploy current-main evidence");
    expect(workflow).toContain("Require post-deploy current-main convergence");
  });

  test("uses locked checks and the reviewed code-generation boundary", () => {
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run typecheck");
    expect(workflow).toContain("bun run test:convex");
    expect(workflow).toContain("bunx convex codegen --dry-run --typecheck disable");
    expect(workflow).toContain("bunx convex deploy");
    expect(workflow).toContain("--typecheck enable");
    expect(workflow).toContain("--codegen disable");
    expect(workflow).toContain('--message "GitHub Actions ${GITHUB_SHA}"');
  });

  test("uses provider finalization without requiring data-view permission", () => {
    expect(workflow).not.toContain("convex function-spec");
    expect(workflow).toContain("id: deploy");
    expect(workflow).toContain("steps.deploy.conclusion == 'success'");
    expect(workflow).toContain("Convex CLI deployment finalization: passed");
    expect(workflow).not.toContain("echo \"$CONVEX_DEPLOY_KEY\"");
  });
});
