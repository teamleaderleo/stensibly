import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const guidePath = fileURLToPath(
  new URL("../docs/red-control-ci.md", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");
const guide = readFileSync(guidePath, "utf8");

const redControlJob = section("  red-control:", "  browser-evidence:");
const browserJob = section("  browser-evidence:", "  test:");
const testJob = section("  test:", "  runtime-parity:");
const runtimeJob = section("  runtime-parity:", "  serial-full:");
const receiptJob = workflow.slice(workflow.indexOf("  validation-receipt:"));

describe("red-control CI profile", () => {
  test("reacts to repository label, draft, readiness, and close transitions", () => {
    for (const activity of [
      "opened",
      "synchronize",
      "reopened",
      "labeled",
      "unlabeled",
      "converted_to_draft",
      "ready_for_review",
      "closed",
    ]) {
      expect(workflow).toContain(`      - ${activity}`);
    }
    expect(workflow).toContain("format('pr-{0}', github.event.pull_request.number)");
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  test("admits only a draft repository-labeled exact-head child", () => {
    expect(redControlJob).toContain("name: red-control-non-authorizing");
    expect(redControlJob).toContain("github.event.pull_request.draft");
    expect(redControlJob).toContain(
      "contains(github.event.pull_request.labels.*.name, 'ci:red-control')",
    );
    expect(redControlJob).toContain("github.event.action != 'closed'");
    expect(redControlJob).toContain("ref: ${{ env.PR_HEAD_SHA }}");
    expect(redControlJob).toContain("fetch-depth: 0");
    expect(redControlJob).toContain("persist-credentials: false");
    expect(redControlJob).toContain('actual_sha="$(git rev-parse HEAD)"');
    expect(redControlJob).toContain(
      'git fetch --no-tags origin "${PR_BASE_SHA}"',
    );
    expect(redControlJob).toContain(
      'merge_base="$(git merge-base "${PR_BASE_SHA}" "${PR_HEAD_SHA}")"',
    );
    expect(redControlJob).toContain(
      'git diff --name-only --diff-filter=ACDMR "${merge_base}" "${PR_HEAD_SHA}"',
    );
  });

  test("requires an absorbing parent and exact changed-path fence", () => {
    expect(redControlJob).toContain("Merge independently:");
    expect(redControlJob).toContain("Red-control parent:");
    expect(redControlJob).toContain("Red-control fence SHA-256:");
    expect(redControlJob).toContain("red-control-fence.txt");
    expect(redControlJob).toContain("sha256sum red-control-fence.txt");
    expect(redControlJob).toContain("grep -Eq '^\\.github/workflows/'");
    expect(redControlJob).toContain(
      "A red-control child cannot modify GitHub workflow files",
    );
  });

  test("publishes a distinct immutable non-authorizing receipt", () => {
    expect(redControlJob).toContain("stensibly-ci-red-control-receipt/1");
    expect(redControlJob).toContain('classification: "red_control"');
    expect(redControlJob).toContain('expectedOutcome: "red"');
    expect(redControlJob).toContain("mergeBaseRevision: $mergeBaseRevision");
    expect(redControlJob).toContain("authorizesMerge: false");
    expect(redControlJob).toContain("authorizesMutation: false");
    expect(redControlJob).toContain("red-control-receipt.json");
    expect(redControlJob).toContain("red-control-receipt.sha256");
    expect(redControlJob).toContain("red-control-merge-base.txt");
    expect(redControlJob).toContain(
      "name: red-control-receipt-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(redControlJob).not.toContain("exact-ref-validation-receipt");
  });

  test("keeps full canonical jobs and receipt unavailable to classified children", () => {
    for (const job of [browserJob, testJob, runtimeJob]) {
      expect(job).toContain("!(github.event.pull_request.draft &&");
      expect(job).toContain(
        "contains(github.event.pull_request.labels.*.name, 'ci:red-control')",
      );
    }
    expect(receiptJob).toContain("name: exact-ref-validation-receipt");
    expect(receiptJob).toContain("!(github.event.pull_request.draft &&");
    expect(receiptJob).toContain(
      "contains(github.event.pull_request.labels.*.name, 'ci:red-control')",
    );
    expect(receiptJob).toContain("stensibly-ci-exact-ref-receipt/1");
  });

  test("preserves ordinary full validation commands and read-only permissions", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(browserJob).toContain("bun run test:browser");
    expect(testJob).toContain("bun run typecheck");
    expect(testJob).toContain("bun run test");
    expect(testJob).toContain("bun run test:convex");
    expect(testJob).toContain("bun run worker:check");
    expect(runtimeJob).toContain("bun run test:runtime-parity");
  });

  test("documents evidence meaning, operator declarations, and parent recovery", () => {
    expect(guide).toContain("A red-control receipt proves");
    expect(guide).toContain("authorizesMerge: false");
    expect(guide).toContain("authorizesMutation: false");
    expect(guide).toContain("never proves integration eligibility");
    expect(guide).toContain("Merge independently: no");
    expect(guide).toContain("Red-control parent: #<number>");
    expect(guide).toContain("Red-control fence SHA-256: <digest>");
    expect(guide).toContain("changes no file below `.github/workflows/`");
    expect(guide).toContain("Run the complete canonical topology");
    expect(guide).toContain("Close the child without merging it independently");
  });
});

function section(start: string, end: string): string {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing workflow section ${start} -> ${end}`);
  }
  return workflow.slice(startIndex, endIndex);
}
