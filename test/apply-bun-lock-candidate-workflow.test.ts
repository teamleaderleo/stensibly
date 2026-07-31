import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/apply-bun-lock-candidate.yml",
  import.meta.url,
);
const ciWorkflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();
const ciWorkflow = await Bun.file(ciWorkflowPath).text();

describe("fenced Bun lock writer workflow", () => {
  test("recovers the exact failed pull-request candidate from trusted run metadata", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("workflows: [CI]");
    expect(workflow).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain(
      "TRIGGERING_RUN_ID: ${{ github.event.workflow_run.id }}",
    );
    expect(workflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/actions/runs/${TRIGGERING_RUN_ID}/artifacts?per_page=100"',
    );
    expect(workflow).toContain(
      'test("^bun-lock-candidate-[0-9a-f]{40}$")',
    );
    expect(workflow).toContain(
      'sub("^bun-lock-candidate-"; "")',
    );
    expect(workflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/actions/runs/${TRIGGERING_RUN_ID}/pull_requests"',
    );
    expect(workflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/commits/${validation_sha}"',
    );
    expect(workflow).toContain("parent_count=");
  });

  test("binds the canonical merge candidate to exact base and feature parents", () => {
    expect(workflow).toContain("validated_base=");
    expect(workflow).toContain("embedded_head=");
    expect(workflow).toContain("associated_base=");
    expect(workflow).toContain("current_base=");
    expect(workflow).toContain("current_merge=");
    expect(workflow).toContain('"${parent_count}" != "2"');
    expect(workflow).toContain('"${embedded_head}" != "${EXPECTED_HEAD}"');
    expect(workflow).toContain('"${associated_base}" != "${validated_base}"');
    expect(workflow).toContain('"${current_base}" != "${validated_base}"');
    expect(workflow).toContain('"${current_merge}" != "${validation_sha}"');
    expect(workflow).toContain(
      "ref: ${{ steps.eligibility.outputs.validation_sha }}",
    );
    expect(workflow).toContain(".parents[1].sha");
  });

  test("regenerates on the failed candidate and stages only its lock on the feature head", () => {
    expect(workflow).toContain("bun install --lockfile-only --ignore-scripts");
    expect(workflow).toContain('checked_out_validation="$(git rev-parse HEAD)"');
    expect(workflow).toContain(
      'if [[ "${checked_out_validation}" != "${VALIDATION_SHA}" ]]',
    );
    expect(workflow).toContain(
      'candidate_path="${RUNNER_TEMP}/bun-lock-candidate-${TRIGGERING_RUN_ID}"',
    );
    expect(workflow).toContain('install -m 0600 bun.lock "${candidate_path}"');
    expect(workflow).toContain('git reset --hard "${VALIDATION_SHA}"');
    expect(workflow).toContain('git checkout --detach "${EXPECTED_HEAD}"');
    expect(workflow).toContain('install -m 0644 "${candidate_path}" bun.lock');
    expect(workflow).toContain(
      "The failed candidate lock cannot be repaired by a new feature-head lock commit",
    );
    expect(workflow.match(/changed_paths\[0\].*bun\.lock/g)).toHaveLength(3);
    expect(workflow).not.toContain("download-artifact");
    expect(workflow).not.toContain("bun run lockfile:check");
    expect(workflow).not.toMatch(/bun install(?! --lockfile-only)/);
  });

  test("isolates credentials from candidate regeneration", () => {
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(2);
    expect(workflow).toContain("gh auth setup-git");
    expect(workflow.indexOf("gh auth setup-git")).toBeGreaterThan(
      workflow.indexOf("bun install --lockfile-only --ignore-scripts"),
    );
    const jobEnvironment = workflow.slice(
      workflow.indexOf("    env:\n"),
      workflow.indexOf("    steps:\n"),
    );
    expect(jobEnvironment).not.toContain("GH_TOKEN");
  });

  test("revalidates exact base, merge, branch, and head before publication", () => {
    expect(workflow).toContain(
      "PULL_NUMBER: ${{ steps.eligibility.outputs.pull_number }}",
    );
    expect(workflow).toContain(
      "VALIDATION_SHA: ${{ steps.eligibility.outputs.validation_sha }}",
    );
    expect(workflow).toContain(
      "VALIDATED_BASE: ${{ steps.eligibility.outputs.validated_base }}",
    );
    expect(workflow).toContain("publication_state=");
    expect(workflow).toContain("publication_head=");
    expect(workflow).toContain("publication_base=");
    expect(workflow).toContain("publication_merge=");
    expect(workflow).toContain('"${publication_head}" != "${EXPECTED_HEAD}"');
    expect(workflow).toContain('"${publication_base}" != "${VALIDATED_BASE}"');
    expect(workflow).toContain('"${publication_merge}" != "${VALIDATION_SHA}"');
    expect(workflow.indexOf("publication_pull=")).toBeLessThan(
      workflow.indexOf("git commit -m"),
    );
    expect(workflow.indexOf("publication_pull=")).toBeLessThan(
      workflow.indexOf("git push origin"),
    );
  });

  test("uses bounded write permissions and an exact feature-head lease", () => {
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("contents: write");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).not.toContain("deployments: write");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(
      '--force-with-lease="refs/heads/${HEAD_BRANCH}:${EXPECTED_HEAD}"',
    );
    expect(workflow).toContain('"HEAD:refs/heads/${HEAD_BRANCH}"');
    expect(workflow).not.toContain("--force\n");
  });

  test("dispatches canonical CI for the exact generated commit", () => {
    expect(ciWorkflow).toContain("workflow_dispatch:");
    expect(ciWorkflow).toContain("expected_sha:");
    expect(ciWorkflow).toContain("required: true");
    expect(ciWorkflow.match(/Verify manually dispatched revision/g)).toHaveLength(2);
    expect(ciWorkflow).toContain('"${GITHUB_SHA}" != "${EXPECTED_SHA}"');
    expect(workflow).toContain('generated_head="$(git rev-parse HEAD)"');
    expect(workflow).toContain('if [[ "${remote_head}" != "${generated_head}" ]]');
    expect(workflow).toContain("gh workflow run ci.yml");
    expect(workflow).toContain('--ref "${HEAD_BRANCH}"');
    expect(workflow).toContain('-f expected_sha="${generated_head}"');
    expect(workflow).toContain("- failed pull-request candidate:");
    expect(workflow).toContain("- validated base:");
    expect(workflow).toContain("- feature-head lease:");
    expect(workflow).toContain("- generated commit:");
  });

  test("makes unrelated, stale, or already-repaired runs no-ops", () => {
    expect(workflow).toContain('echo "eligible=false" >>"${GITHUB_OUTPUT}"');
    expect(workflow).toContain(
      "steps.eligibility.outputs.eligible == 'true'",
    );
    expect(workflow).toContain('echo "changed=false" >>"${GITHUB_OUTPUT}"');
    expect(workflow).toContain(
      "steps.generate.outputs.changed == 'true'",
    );
  });
});
