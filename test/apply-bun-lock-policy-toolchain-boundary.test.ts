import { describe, expect, test } from "bun:test";

const writer = await Bun.file(new URL(
  "../.github/workflows/apply-bun-lock-candidate.yml",
  import.meta.url,
)).text();
const ci = await Bun.file(new URL(
  "../.github/workflows/ci.yml",
  import.meta.url,
)).text();

describe("Bun lock writer validator policy and toolchain boundary", () => {
  test("admits one exact canonical CI run instead of trusting a display name", () => {
    expect(writer).toContain(
      '"repos/${GITHUB_REPOSITORY}/actions/runs/${TRIGGERING_RUN_ID}"',
    );
    expect(writer).toContain(
      '"repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml"',
    );
    expect(writer).toContain('"${run_workflow_id}" != "${canonical_workflow_id}"');
    expect(writer).toContain('"${run_path}" != ".github/workflows/ci.yml"');
    expect(writer).toContain('"${run_event}" != "pull_request"');
    expect(writer).toContain('"${run_status}" != "completed"');
    expect(writer).toContain('"${run_conclusion}" != "failure"');
    expect(writer).toContain('"${run_head_sha}" != "${EXPECTED_HEAD}"');
  });

  test("binds the candidate to the validated-base CI and lock-generation policy", () => {
    expect(writer).toContain("candidate_ci_blob=");
    expect(writer).toContain("base_ci_blob=");
    expect(writer).toContain("candidate_lock_script_blob=");
    expect(writer).toContain("base_lock_script_blob=");
    expect(writer).toContain('"${candidate_ci_blob}" != "${base_ci_blob}"');
    expect(writer).toContain(
      '"${candidate_lock_script_blob}" != "${base_lock_script_blob}"',
    );
    expect(writer).toContain(
      '"${candidate_lock_command}" != "bun scripts/prepare-bun-lock-candidate.ts"',
    );
  });

  test("uses one exact Bun runtime identity in CI and independent regeneration", () => {
    expect(ci).toContain('BUN_VERSION: "1.3.14"');
    expect(ci).toContain('BUN_REVISION: "1.3.14+0d9b296af"');
    expect(ci).toContain("binary_sha256=");
    expect(ci).toContain("steps.bun-runtime.outputs.binary_sha256");
    expect(writer).toContain('BUN_VERSION: "1.3.14"');
    expect(writer).toContain('BUN_REVISION: "1.3.14+0d9b296af"');
    expect(writer).toContain("artifact_bun_binary_sha256=");
    expect(writer).toContain("EXPECTED_BUN_BINARY_SHA256:");
    expect(writer).toContain(
      '"${actual_bun_binary_sha256}" != "${EXPECTED_BUN_BINARY_SHA256}"',
    );
  });

  test("runs trusted default-branch CI while checking out the generated SHA", () => {
    expect(writer).toContain('gh workflow run ci.yml');
    expect(writer).toContain('--ref "${DEFAULT_BRANCH}"');
    expect(writer).not.toContain('--ref "${HEAD_BRANCH}"');
    expect(ci).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.expected_sha || github.sha }}",
    );
    expect(ci).toContain('actual_sha="$(git rev-parse HEAD)"');
    expect(ci).toContain('"${actual_sha}" != "${EXPECTED_SHA}"');
  });
});
