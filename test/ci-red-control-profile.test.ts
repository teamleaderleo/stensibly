import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

describe("red-control CI profile", () => {
  test("refreshes classification on description, draft, label, ready, and close events", () => {
    for (const event of [
      "edited",
      "labeled",
      "unlabeled",
      "ready_for_review",
      "converted_to_draft",
      "closed",
    ]) {
      expect(workflow).toContain(`- ${event}`);
    }
  });

  test("skips only heavy jobs for repository-labeled draft controls", () => {
    expect(count(workflow, "github.event.pull_request.draft != true")).toBe(3);
    expect(count(
      workflow,
      "contains(github.event.pull_request.labels.*.name, 'ci:red-control') != true",
    )).toBe(3);
    expect(workflow).toContain("red-control-receipt:");
    expect(workflow).toContain("name: red-control-non-authorizing-receipt");
    expect(workflow).toContain("authorizing: false");
    expect(workflow).toContain("stensibly-ci-red-control-receipt/1");
    expect(workflow).toContain("cannot merge independently");
    expect(workflow).toContain("Absorbing parent: #123");
    expect(workflow).toContain("persist-credentials: false");
  });

  test("keeps the canonical exact-ref context non-authorizing on skipped topology", () => {
    expect(workflow).toContain("name: exact-ref-validation-receipt");
    expect(workflow).toContain("Enforce authorizing exact-ref result");
    expect(workflow).toContain('if [[ "${status}" != "success" ]]');
    expect(workflow).toContain(
      "full canonical CI did not authorize this revision",
    );
  });

  test("uses close events only to cancel obsolete work", () => {
    expect(count(workflow, "github.event.pull_request.state == 'open'")).toBe(5);
    expect(count(workflow, "github.event.action != 'closed'")).toBe(5);
    expect(workflow).toContain(
      "(github.event.pull_request.state == 'open' && github.event.action != 'closed')",
    );
  });
});

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
