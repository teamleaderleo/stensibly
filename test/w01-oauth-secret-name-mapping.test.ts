import { describe, expect, test } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/w01-oauth-auto-rollout.yml",
  import.meta.url,
);
const workflow = await Bun.file(workflowPath).text();

describe("contained W01 OAuth credential mapping", () => {
  test("references no GitHub or Worker OAuth credential binding", () => {
    for (const name of [
      "STENSIBLY_GITHUB_OAUTH_CLIENT_ID",
      "STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET",
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "STENSIBLY_OAUTH_SIGNING_SECRET",
      "STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS",
      "STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS",
      "STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS",
    ]) {
      expect(workflow).not.toContain(name);
    }
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("$clientId");
    expect(workflow).not.toContain("$clientSecret");
  });
});
