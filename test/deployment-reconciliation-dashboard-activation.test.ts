import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(
  new URL("../.github/workflows/observe-deployment-reconciliation.yml", import.meta.url),
).text();

function position(value: string): number {
  const index = workflow.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("deployment reconciliation dashboard activation", () => {
  test("keeps the exact-CI observer read-heavy and grants only Actions dispatch permission", () => {
    expect(workflow).toContain("permissions:\n  actions: write\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("deployments: write");
    expect(workflow).not.toContain("packages: write");
  });

  test("records the non-authorizing decision before considering a dashboard queue", () => {
    const compile = position("Compile bounded shadow reconciliation evidence");
    const upload = position("Upload non-authorizing reconciliation receipt");
    const admit = position("Admit dashboard publication from reconciliation");
    const queue = position("Queue reconciled dashboard publication");
    expect(compile).toBeLessThan(upload);
    expect(upload).toBeLessThan(admit);
    expect(admit).toBeLessThan(queue);
  });

  test("admits only the exact current-main dashboard site-tree decision", () => {
    expect(workflow).toContain('.schemaVersion == "stensibly-deployment-reconciliation-decision/3"');
    expect(workflow).toContain('.mode == "shadow"');
    expect(workflow).toContain('.observer.workflowRevision == $expected');
    expect(workflow).toContain('.observer.sourceRevision == $expected');
    expect(workflow).toContain('.ci.workflowRevision == $expected');
    expect(workflow).toContain('.ci.sourceRevision == $expected');
    expect(workflow).toContain('.currentMainRevision == $expected');
    expect(workflow).toContain('.authorizesMutation == false');
    expect(workflow).toContain('.authorizesDeployment == false');
    expect(workflow).toContain('.authorizesRetry == false');
    expect(workflow).toContain('select(.target == "dashboard")');
    expect(workflow).toContain('"${decision}" != "would_dispatch"');
    expect(workflow).toContain('.reason == "site_tree_changed"');
    expect(workflow).toContain('.providerCurrentVerified == true');
    expect(workflow).toContain('.classifier.kind == "site-tree-oid"');
  });

  test("queues through the existing exact-revision release window without force", () => {
    expect(workflow).toContain("if: steps.dashboard_release.outputs.queue == 'true'");
    expect(workflow).toContain("EXPECTED_DASHBOARD_RELEASE_REVISION: ${{ steps.admit.outputs.trigger_sha }}");
    expect(workflow).toContain('FORCE_DASHBOARD_RELEASE: "false"');
    expect(workflow).toContain("run: bun scripts/dashboard-release-window.ts");
    expect(workflow).not.toContain('FORCE_DASHBOARD_RELEASE: "true"');
  });

  test("does not activate Worker or Convex deployment dispatch", () => {
    expect(workflow).not.toContain("deploy-worker.yml/dispatches");
    expect(workflow).not.toContain("deploy-convex.yml/dispatches");
    expect(workflow).not.toContain("bun scripts/worker-production-release.ts");
    expect(workflow).not.toContain("bunx convex deploy");
  });
});
