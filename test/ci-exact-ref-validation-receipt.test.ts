import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

describe("reusable exact-ref CI receipt", () => {
  test("exposes exact SHA and profile inputs for dispatch and workflow calls", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("workflow_call:");
    expect(count(workflow, "expected_sha:")).toBe(2);
    expect(count(workflow, "validation_profile:")).toBe(2);
    expect(workflow).toContain("default: full_parallel");
    expect(workflow).toContain("- full_parallel");
    expect(workflow).toContain("- serial_full");
    expect(workflow).toContain("github.event_name == 'workflow_call'");
  });

  test("keeps reusable validation read-only and exact-revision fenced", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("actions: write");
    expect(workflow).toContain("[[ ! \"${EXPECTED_SHA}\" =~ ^[0-9a-f]{40}$");
    expect(workflow).toContain("\"${GITHUB_SHA}\" != \"${EXPECTED_SHA}\"");
    expect(workflow).toContain("ref: ${{ env.SERIAL_VALIDATION_SHA }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("actual_sha=\"$(git rev-parse HEAD)\"");
    expect(workflow).toContain("bun install --frozen-lockfile");
  });

  test("records terminal topology outcomes and exact revision identity", () => {
    expect(workflow).toContain("validation-receipt:");
    expect(workflow).toContain("name: exact-ref-validation-receipt");
    expect(workflow).toContain("needs: [browser-evidence, test, runtime-parity, serial-full]");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("SOURCE_REVISION:");
    expect(workflow).toContain("EVENT_REVISION: ${{ github.sha }}");
    expect(workflow).toContain("WORKFLOW_REVISION: ${{ github.workflow_sha }}");
    expect(workflow).toContain("BROWSER_RESULT: ${{ needs.browser-evidence.result }}");
    expect(workflow).toContain("TEST_RESULT: ${{ needs.test.result }}");
    expect(workflow).toContain("RUNTIME_RESULT: ${{ needs.runtime-parity.result }}");
    expect(workflow).toContain("SERIAL_RESULT: ${{ needs.serial-full.result }}");
    expect(workflow).toContain("stensibly-ci-exact-ref-receipt/1");
    expect(workflow).toContain("exact-ref-validation-receipt.json");
    expect(workflow).toContain("sha256sum exact-ref-validation-receipt.json");
    expect(workflow).toContain("exact-ref-validation-receipt.sha256");
    expect(workflow).toContain("retention-days: 30");
  });
});

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
