import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-deploy-dashboard-thread-once.yml", import.meta.url),
  "utf8",
);
const verifier = readFileSync(
  new URL("../src/verify-dashboard.ts", import.meta.url),
  "utf8",
);

describe("W01 attributable dashboard thread deployment", () => {
  test("runs only for the exact same-repository execution branch", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("lantern/409-deploy-dashboard-thread");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("pins the accepted source and the complete dashboard site tree", () => {
    expect(workflow).toContain(
      "REQUIRED_SOURCE_SHA: 02e19ee886bcb76a39462eb2e21a37b32bead51c",
    );
    expect(workflow).toContain('git rev-parse "$REQUIRED_SOURCE_SHA:site"');
    expect(workflow).toContain('git rev-parse "$GITHUB_SHA:site"');
    expect(workflow).toContain("persist-credentials: false");
  });

  test("uses the repaired current-shell verifier before Vercel", () => {
    expect(verifier).toContain("Stensibly · Shared work");
    expect(verifier).toContain("item-detail-announcer");
    expect(workflow.indexOf("verify:dashboard")).toBeLessThan(
      workflow.indexOf("Validate the existing Vercel project"),
    );
  });

  test("uses protected Vercel inputs and the existing project boundary", () => {
    expect(workflow).toContain("environment:\n      name: production");
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).toContain("EXPECTED_VERCEL_PROJECT: stensibly");
    expect(workflow).toContain('test "$(jq -r \'.rootDirectory // empty\' /tmp/vercel-project.json)" = "site"');
  });

  test("gates, stages, verifies, promotes, and verifies production", () => {
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "bun run test:convex",
      "bun run worker:check",
      "vercel@${VERCEL_CLI_VERSION} build",
      "vercel@${VERCEL_CLI_VERSION} deploy",
      "--skip-domain",
      "verify:dashboard",
      "vercel@${VERCEL_CLI_VERSION} promote",
      "DASHBOARD_URL: https://www.stensibly.com",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("dashboard-assets.ts");
    expect(workflow).toContain("contains_secret_values: false");
  });

  test("keeps evidence bounded and does not print protected values", () => {
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).toContain("w01-dashboard-thread-deploy");
    expect(workflow).not.toContain("echo $VERCEL_TOKEN");
    expect(workflow).not.toContain("echo ${VERCEL_TOKEN}");
  });
});
