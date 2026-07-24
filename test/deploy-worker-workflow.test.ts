import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/deploy-worker.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("production Worker deployment workflow", () => {
  test("is manual, main-only, serialized, and environment-gated", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Require main branch");
    expect(workflow).toContain('refs/heads/main');
    expect(workflow).toContain("group: stensibly-worker-production");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: production");
    expect(workflow).not.toMatch(/^\s*push:/m);
  });

  test("requires only the deployment and read-verification secrets", () => {
    expect(workflow).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("secrets.STENSIBLY_READ_TOKEN");
    expect(workflow).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(workflow).not.toContain("CONVEX_URL");
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

  test("deploys once and verifies both production endpoints", () => {
    expect(workflow.match(/bun run worker:deploy/g)).toHaveLength(1);
    expect(workflow).toContain("https://stensibly-api.leoli-082000.workers.dev");
    expect(workflow).toContain("https://api.stensibly.com");
    expect(workflow.match(/bun run verify:hosted/g)).toHaveLength(2);
    expect(workflow).toContain("for attempt in 1 2 3");
  });
});
