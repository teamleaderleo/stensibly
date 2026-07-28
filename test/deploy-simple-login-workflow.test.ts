import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-deploy-simple-login-once.yml", import.meta.url),
  "utf8",
);

describe("W01 simple login deployment", () => {
  test("runs only for the exact same-repository execution branch", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("lantern/456-deploy-simple-login");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("pins the accepted source and complete dashboard site tree", () => {
    expect(workflow).toContain(
      "REQUIRED_SOURCE_SHA: fceb0877a7598ba253979e1e35d4e689c94d86bb",
    );
    expect(workflow).toContain('git rev-parse "$REQUIRED_SOURCE_SHA:site"');
    expect(workflow).toContain('git rev-parse "$GITHUB_SHA:site"');
    expect(workflow).toContain("persist-credentials: false");
  });

  test("uses protected Vercel inputs and existing project boundary", () => {
    expect(workflow).toContain("environment:\n      name: production");
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).toContain("EXPECTED_VERCEL_PROJECT: stensibly");
    expect(workflow).toContain(".rootDirectory // empty");
  });

  test("gates, stages, retries, promotes, and verifies production", () => {
    for (const command of [
      "bun run typecheck",
      "bun run test",
      "bun run test:convex",
      "bun run worker:check",
      "verify:dashboard",
      "dashboard-assets.ts",
      "vercel@${VERCEL_CLI_VERSION} build",
      "vercel@${VERCEL_CLI_VERSION} deploy",
      "--skip-domain",
      "for attempt in 1 2 3 4 5",
      "vercel@${VERCEL_CLI_VERSION} promote",
      "DASHBOARD_URL: https://www.stensibly.com",
    ]) {
      expect(workflow).toContain(command);
    }
  });

  test("keeps evidence bounded and avoids printing protected values", () => {
    expect(workflow).toContain("contains_secret_values: false");
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).toContain("w01-simple-login-deploy");
    expect(workflow).not.toContain("echo $VERCEL_TOKEN");
    expect(workflow).not.toContain("echo ${VERCEL_TOKEN}");
  });
});
