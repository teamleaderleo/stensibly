import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-deploy-dashboard-thread-once.yml", import.meta.url),
  "utf8",
);

describe("W01 attributable dashboard thread promotion", () => {
  test("runs only for exact same-repository execution PR 441", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("github.event.pull_request.number == 441");
    expect(workflow).toContain("lantern/409-deploy-dashboard-thread");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("pins the accepted site tree and retained staged deployment", () => {
    expect(workflow).toContain(
      "REQUIRED_SITE_SOURCE: 02e19ee886bcb76a39462eb2e21a37b32bead51c",
    );
    expect(workflow).toContain(
      "STAGED_ORIGIN: https://stensibly-11mfzhs6c-leo-lis-projects.vercel.app",
    );
    expect(workflow).toContain('git rev-parse "$REQUIRED_SITE_SOURCE:site"');
    expect(workflow).toContain('git rev-parse "$GITHUB_SHA:site"');
    expect(workflow).toContain("persist-credentials: false");
  });

  test("reverifies all staged assets with bounded retries before promotion", () => {
    expect(workflow).toContain("Reverify retained stage with propagation retries");
    expect(workflow).toContain("for attempt in 1 2 3");
    expect(workflow).toContain("bun src/dashboard-assets.ts");
    expect(workflow).toContain("[.[].path] | length == (unique | length)");
    expect(workflow).toContain('--deployment "$STAGED_ORIGIN"');
    expect(workflow).toContain("marker");
    expect(workflow).toContain("stn\\.tok_");
  });

  test("promotes the retained stage and verifies production", () => {
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} promote");
    expect(workflow).toContain('"$STAGED_ORIGIN"');
    expect(workflow).toContain("Verify production dashboard with propagation retries");
    expect(workflow).toContain("for attempt in 1 2 3 4 5");
    expect(workflow).toContain("DASHBOARD_URL: https://www.stensibly.com");
    expect(workflow).toContain("bun run verify:dashboard");
  });

  test("does not create another build or staged deployment", () => {
    expect(workflow).not.toContain("vercel@${VERCEL_CLI_VERSION} build");
    expect(workflow).not.toContain("vercel@${VERCEL_CLI_VERSION} deploy");
    expect(workflow).not.toContain("--skip-domain");
  });

  test("keeps protected values and evidence bounded", () => {
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
    expect(workflow).toContain("contains_secret_values: false");
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).not.toContain("echo $VERCEL_TOKEN");
    expect(workflow).not.toContain("echo ${VERCEL_TOKEN}");
  });
});
