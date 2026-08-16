import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/observe-deployment-reconciliation.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("deployment reconciliation shadow workflow", () => {
  test("starts only from a completed canonical main CI run", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("workflows: [CI]");
    expect(workflow).toContain("- completed");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("github.event.workflow_run.repository.id == github.event.repository.id");
    expect(workflow).toContain("github.event.workflow_run.head_repository.id == github.event.repository.id");
    expect(workflow).not.toContain("concurrency:");
  });

  test("uses one runner and gates every post-admission step directly", () => {
    expect(count(workflow, "runs-on: ubuntu-latest")).toBe(1);
    expect(workflow).toContain("\n  observe:\n");
    expect(workflow).not.toContain("\n  precheck:\n");
    expect(workflow).not.toContain("needs: precheck");
    expect(count(workflow, "if: steps.admit.outputs.proceed == 'true'")).toBe(7);
    expect(count(workflow, "if: steps.admit.outputs.proceed == 'false'")).toBe(1);
    expect(workflow).toContain("ref: ${{ steps.admit.outputs.trigger_sha }}");
    expect(workflow).toContain("EXPECTED_HEAD: ${{ steps.admit.outputs.trigger_sha }}");
    expect(workflow).not.toContain("needs.precheck.outputs");
  });

  test("prechecks current main and refetched identity before checkout", () => {
    const precheckIndex = workflow.indexOf("Refetch the triggering run and current main");
    const metadataIndex = workflow.indexOf("actions/runs/${TRIGGER_RUN_ID}/artifacts?name=${artifact_name}&per_page=2");
    const downloadIndex = workflow.indexOf("actions/download-artifact@v5");
    const checkoutIndex = workflow.indexOf("actions/checkout@v6");
    expect(precheckIndex).toBeGreaterThan(-1);
    expect(metadataIndex).toBeGreaterThan(precheckIndex);
    expect(downloadIndex).toBeGreaterThan(metadataIndex);
    expect(checkoutIndex).toBeGreaterThan(precheckIndex);
    expect(workflow).toContain('run_json="$(gh api --method GET');
    expect(workflow).toContain('main_json="$(gh api --method GET');
    expect(workflow).toContain('.path == ".github/workflows/ci.yml"');
    expect(workflow).toContain('actions/workflows/ci.yml")');
    expect(workflow).toContain(".total_count == 1");
    expect(workflow).toContain("(.artifacts | length) == 1");
    expect(workflow).toContain(".artifacts[0].name == $artifact_name");
    expect(workflow).toContain('.artifacts[0].size_in_bytes <= 16384');
    expect(workflow).toContain('test("^sha256:[0-9a-f]{64}$")');
    expect(workflow).toContain('(.artifacts[0].workflow_run.repository_id | tostring) == $repository_id');
    expect(workflow).toContain('if [[ "${current_main}" == "${TRIGGER_SHA}" ]]');
    expect(workflow).toContain("decision: \"waiting_current_main\"");
    expect(workflow).toContain("ref: ${{ steps.admit.outputs.trigger_sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('checked_out="$(git rev-parse HEAD)"');
    expect(workflow).toContain("GITHUB_WORKFLOW_SHA: ${{ github.workflow_sha }}");
    expect(workflow).toContain("OBSERVER_SOURCE_REVISION: ${{ steps.admit.outputs.trigger_sha }}");
  });

  test("keeps the CI artifact and output outside the workspace", () => {
    expect(workflow).toContain("actions/download-artifact@v5");
    expect(workflow).toContain("github-token: ${{ github.token }}");
    expect(workflow).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(workflow).toContain("path: ${{ runner.temp }}/exact-ci-receipt");
    expect(workflow).toContain("CI_RECEIPT_DIRECTORY: ${{ runner.temp }}/exact-ci-receipt");
    expect(workflow).toContain("DEPLOYMENT_RECONCILIATION_OUTPUT: ${{ runner.temp }}/deployment-reconciliation-shadow.json");
    expect(workflow).not.toContain("path: exact-ci-receipt");
  });

  test("is read-only, unprivileged, and never dispatches a deployment", () => {
    expect(workflow).toContain("permissions:\n  actions: read\n  contents: read");
    expect(workflow).not.toContain("actions: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("environment:");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("/dispatches");
    expect(workflow).not.toContain("gh workflow run");
    expect(workflow).not.toContain("curl ");
    expect(workflow).not.toContain("set -x");
    expect(workflow).not.toContain("printenv");
  });

  test("publishes only explicitly non-authorizing shadow evidence", () => {
    expect(workflow).toContain("schemaVersion: \"stensibly-deployment-reconciliation-waiting/1\"");
    expect(workflow).toContain("mode: \"shadow\"");
    expect(count(workflow, "authorizesMutation: false")).toBeGreaterThanOrEqual(1);
    expect(count(workflow, "authorizesDeployment: false")).toBeGreaterThanOrEqual(1);
    expect(count(workflow, "authorizesRetry: false")).toBeGreaterThanOrEqual(1);
    expect(workflow).toContain("bun scripts/observe-deployment-reconciliation.ts");
    expect(workflow).toContain("deployment-reconciliation-shadow-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}");
    expect(count(workflow, "retention-days: 30")).toBe(2);
  });
});

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
