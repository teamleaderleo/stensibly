import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(new URL(
  "../.github/workflows/apply-bun-lock-candidate.yml",
  import.meta.url,
)).text();

describe("Bun lock writer candidate and branch authority", () => {
  test("keeps failed-candidate validation separate from feature-head write authority", () => {
    expect(workflow).toContain(
      "EXPECTED_HEAD: ${{ github.event.workflow_run.head_sha }}",
    );
    expect(workflow).toContain(
      "ref: ${{ steps.eligibility.outputs.validation_sha }}",
    );
    expect(workflow).toContain('git checkout --detach "${EXPECTED_HEAD}"');
    expect(workflow).toContain(
      '--force-with-lease="refs/heads/${HEAD_BRANCH}:${EXPECTED_HEAD}"',
    );
    expect(workflow).toContain("failed pull-request candidate");
    expect(workflow).toContain("validated base");
    expect(workflow).toContain("feature-head lease");
  });

  test("recovers and verifies the canonical failed pull-request candidate", () => {
    expect(workflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/actions/runs/${TRIGGERING_RUN_ID}/artifacts?per_page=100"',
    );
    expect(workflow).toContain(
      'test("^bun-lock-candidate-[0-9a-f]{40}$")',
    );
    expect(workflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/commits/${validation_sha}"',
    );
    expect(workflow).toContain("parent_count=");
    expect(workflow).toContain("validated_base=");
    expect(workflow).toContain("embedded_head=");
    expect(workflow).toContain('"${parent_count}" != "2"');
    expect(workflow).toContain('"${embedded_head}" != "${EXPECTED_HEAD}"');
  });

  test("binds eligibility to the same current default-base PR generation", () => {
    expect(workflow).toContain(
      "DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
    );
    expect(workflow).toContain("associated_base_repository=");
    expect(workflow).toContain("associated_base_branch=");
    expect(workflow).toContain("associated_base=");
    expect(workflow).toContain("current_base_repository=");
    expect(workflow).toContain("current_base_branch=");
    expect(workflow).toContain("current_base=");
    expect(workflow).toContain("current_merge=");
    expect(workflow).toContain(
      '"${associated_base_repository}" != "${GITHUB_REPOSITORY}"',
    );
    expect(workflow).toContain(
      '"${current_base_repository}" != "${GITHUB_REPOSITORY}"',
    );
    expect(workflow).toContain(
      '"${associated_base_branch}" != "${DEFAULT_BRANCH}"',
    );
    expect(workflow).toContain(
      '"${current_base_branch}" != "${DEFAULT_BRANCH}"',
    );
    expect(workflow).toContain('"${associated_base}" != "${validated_base}"');
    expect(workflow).toContain('"${current_base}" != "${validated_base}"');
    expect(workflow).toContain('"${current_merge}" != "${validation_sha}"');
  });

  test("regenerates on the failed candidate before applying only bun.lock to the feature head", () => {
    expect(workflow).toContain(
      'checked_out_validation="$(git rev-parse HEAD)"',
    );
    expect(workflow).toContain("bun install --lockfile-only --ignore-scripts");
    expect(workflow).toContain(
      'candidate_path="${RUNNER_TEMP}/bun-lock-candidate-${TRIGGERING_RUN_ID}"',
    );
    expect(workflow).toContain('git reset --hard "${VALIDATION_SHA}"');
    expect(workflow).toContain('git checkout --detach "${EXPECTED_HEAD}"');
    expect(workflow).toContain('install -m 0644 "${candidate_path}" bun.lock');
    expect(workflow).toContain("git add -- bun.lock");
    expect(workflow).not.toContain("download-artifact");
  });

  test("revalidates the exact candidate, base, and feature lease immediately before publication", () => {
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
    expect(workflow).toContain("publication_head_repository=");
    expect(workflow).toContain("publication_head_branch=");
    expect(workflow).toContain("publication_head=");
    expect(workflow).toContain("publication_base_repository=");
    expect(workflow).toContain("publication_base_branch=");
    expect(workflow).toContain("publication_base=");
    expect(workflow).toContain("publication_merge=");
    expect(workflow).toContain('"${publication_state}" != "open"');
    expect(workflow).toContain(
      '"${publication_head_repository}" != "${GITHUB_REPOSITORY}"',
    );
    expect(workflow).toContain(
      '"${publication_head_branch}" != "${HEAD_BRANCH}"',
    );
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
});
