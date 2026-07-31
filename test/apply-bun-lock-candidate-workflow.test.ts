import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/apply-bun-lock-candidate.yml",
  import.meta.url,
);
const ciWorkflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();
const ciWorkflow = await Bun.file(ciWorkflowPath).text();
const ciTestJob = ciWorkflow.match(
  /\n  test:\n([\s\S]*?)\n  runtime-parity:\n/u,
)?.[1];
const ciRuntimeParityJob = ciWorkflow.match(
  /\n  runtime-parity:\n([\s\S]*?)\n  serial-full:\n/u,
)?.[1];
const ciSerialFullJob = ciWorkflow.match(
  /\n  serial-full:\n([\s\S]*)$/u,
)?.[1];

describe("fenced Bun lock writer workflow", () => {
  test("runs only for one exact current same-repository pull request", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("workflows: [CI]");
    expect(workflow).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch != github.event.repository.default_branch",
    );
    expect(workflow).toContain('-f state=open');
    expect(workflow).toContain('-f head="${REPOSITORY_OWNER}:${HEAD_BRANCH}"');
    expect(workflow).toContain('if [[ "${count}" != "1" ]]');
    expect(workflow).toContain(
      'if [[ "${pull_head_repository}" != "${GITHUB_REPOSITORY}" ]]',
    );
    expect(workflow).toContain(
      'if [[ "${pull_head_sha}" != "${EXPECTED_HEAD}" ]]',
    );
    expect(workflow).toContain(
      'if [[ "${checked_out_head}" != "${EXPECTED_HEAD}" ]]',
    );
  });

  test("regenerates independently and permits only bun.lock", () => {
    expect(workflow).toContain("bun install --lockfile-only --ignore-scripts");
    expect(workflow).not.toContain("download-artifact");
    expect(workflow).not.toContain("artifact_id");
    expect(workflow).not.toContain("bun run lockfile:check");
    expect(workflow).not.toMatch(/bun install(?! --lockfile-only)/);
    expect(workflow).toContain(
      'if [[ "${#changed_paths[@]}" != "1" || "${changed_paths[0]}" != "bun.lock" ]]',
    );
    expect(workflow.match(/changed_paths\[0\].*bun\.lock/g)).toHaveLength(2);
    expect(workflow).toContain("git add -- bun.lock");
  });

  test("isolates credentials from dependency resolution", () => {
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

  test("uses bounded write permissions and an exact branch lease", () => {
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

  test("dispatches exact generated commits into the canonical CI topology", () => {
    expect(ciWorkflow).toContain("workflow_dispatch:");
    expect(ciWorkflow).toContain("expected_sha:");
    expect(ciWorkflow).toContain("required: true");
    expect(ciTestJob?.match(/Verify manually dispatched revision/g)).toHaveLength(1);
    expect(ciRuntimeParityJob?.match(/Verify manually dispatched revision/g))
      .toHaveLength(1);
    expect(ciSerialFullJob?.match(/Verify exact serial revision/g))
      .toHaveLength(1);
    expect(ciSerialFullJob).toContain("inputs.expected_sha");
    expect(ciSerialFullJob).toContain("SERIAL_VALIDATION_SHA");
    expect(ciWorkflow).toContain(
      '"${GITHUB_SHA}" != "${EXPECTED_SHA}"',
    );
    expect(workflow).toContain('generated_head="$(git rev-parse HEAD)"');
    expect(workflow).toContain(
      'if [[ "${remote_head}" != "${generated_head}" ]]',
    );
    expect(workflow).toContain("gh workflow run ci.yml");
    expect(workflow).toContain('--ref "${HEAD_BRANCH}"');
    expect(workflow).toContain('-f expected_sha="${generated_head}"');
    expect(workflow).toContain(
      "validation: explicit CI dispatch bound to the generated commit",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
  });

  test("makes stale or already-repaired workflow runs no-ops", () => {
    expect(workflow).toContain('echo "eligible=false" >>"${GITHUB_OUTPUT}"');
    expect(workflow).toContain(
      "steps.eligibility.outputs.eligible == 'true'",
    );
    expect(workflow).toContain('echo "changed=false" >>"${GITHUB_OUTPUT}"');
    expect(workflow).toContain(
      "steps.generate.outputs.changed == 'true'",
    );
    expect(workflow).toContain(
      'if [[ "$(git rev-parse HEAD)" != "${EXPECTED_HEAD}" ]]',
    );
  });
});
