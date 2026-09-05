import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const workflow = readFileSync(
  fileURLToPath(
    new URL(
      "../.github/workflows/provision-owned-workstation-runner.yml",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("Quarry owned-workstation credential boundary", () => {
  test("Quarry is runner-only and repo-query-only", () => {
    expect(workflow).toContain(
      'if [[ "$PROJECT" == quarry && "$CREDENTIAL_CLASS" != runner ]]',
    );
    expect(workflow).toContain(
      'echo "Quarry pilot requires the runner credential class" >&2',
    );
    expect(workflow).toContain('if [[ "$PROJECT" == quarry ]]');
    expect(workflow).toContain('runner_profiles="repo-query/v1"');
  });

  test("generic ephemeral control remains available only outside the Quarry pilot", () => {
    expect(workflow).toContain(
      '[[ "$CREDENTIAL_CLASS" == runner || "$CREDENTIAL_CLASS" == ephemeral_control ]]',
    );
    expect(workflow).toContain('--scopes read,write');
    expect(workflow).toContain('--projects "$PROJECT"');
  });
});
