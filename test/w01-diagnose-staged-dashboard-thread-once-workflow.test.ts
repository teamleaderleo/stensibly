import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/w01-diagnose-staged-dashboard-thread-once.yml", import.meta.url),
  "utf8",
);

describe("W01 staged dashboard thread diagnosis", () => {
  test("runs only for the exact same-repository diagnostic branch", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("lantern/409-diagnose-staged-dashboard-thread");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain('if [[ "$GITHUB_RUN_ATTEMPT" != "1" ]]');
  });

  test("targets the retained staged origin through authenticated read-only requests", () => {
    expect(workflow).toContain(
      "STAGED_ORIGIN: https://stensibly-11mfzhs6c-leo-lis-projects.vercel.app",
    );
    expect(workflow).toContain("vercel@${VERCEL_CLI_VERSION} curl");
    expect(workflow).toContain('--deployment "$STAGED_ORIGIN"');
    expect(workflow).toContain("secrets.VERCEL_TOKEN");
    expect(workflow).toContain("secrets.VERCEL_ORG_ID");
    expect(workflow).toContain("secrets.VERCEL_PROJECT_ID");
  });

  test("diagnoses HTML and every canonical asset without retaining bodies", () => {
    expect(workflow).toContain("bun run verify:dashboard --");
    expect(workflow).toContain("bun src/dashboard-assets.ts");
    expect(workflow).toContain("fetch_status");
    expect(workflow).toContain("media_type");
    expect(workflow).toContain("marker_found");
    expect(workflow).toContain("token_shape_found");
    expect(workflow).toContain("assets.tsv");
    expect(workflow).toContain("assets.json");
    expect(workflow).toContain("contains_secret_values: false");
  });

  test("has no deployment, promotion, build, or configuration mutation path", () => {
    expect(workflow).not.toContain("vercel@${VERCEL_CLI_VERSION} deploy");
    expect(workflow).not.toContain("vercel@${VERCEL_CLI_VERSION} promote");
    expect(workflow).not.toContain("vercel@${VERCEL_CLI_VERSION} build");
    expect(workflow).not.toContain("wrangler deploy");
    expect(workflow).not.toContain("wrangler secret");
    expect(workflow).not.toContain("vercel env");
  });

  test("publishes bounded evidence before failing a mismatch", () => {
    expect(workflow).toContain("Post bounded diagnosis to issue 403");
    expect(workflow).toContain("Upload bounded staged diagnosis");
    expect(workflow).toContain("Fail when the staged deployment mismatches the contract");
    expect(workflow).toContain("retention-days: 3");
  });
});
