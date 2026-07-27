import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-oauth-auto-rollout.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("W01 OAuth credential mapping", () => {
  test("uses GitHub-safe environment secret names and preserves Worker binding names", () => {
    expect(workflow).toContain(
      "GITHUB_OAUTH_CLIENT_ID: ${{ secrets.STENSIBLY_GITHUB_OAUTH_CLIENT_ID }}",
    );
    expect(workflow).toContain(
      "GITHUB_OAUTH_CLIENT_SECRET: ${{ secrets.STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET }}",
    );
    expect(workflow).not.toContain(
      "GITHUB_OAUTH_CLIENT_ID: ${{ secrets.GITHUB_OAUTH_CLIENT_ID }}",
    );
    expect(workflow).not.toContain(
      "GITHUB_OAUTH_CLIENT_SECRET: ${{ secrets.GITHUB_OAUTH_CLIENT_SECRET }}",
    );
    expect(workflow).toContain("GITHUB_OAUTH_CLIENT_ID: $clientId");
    expect(workflow).toContain("GITHUB_OAUTH_CLIENT_SECRET: $clientSecret");
  });
});
