import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const fixedMessage =
  "GitHub outbound direct reference contains percent-encoded path continuation";

describe("GitHub outbound encoded invalid direct-route identities", () => {
  test("rejects encoded item and commit bytes before decoded identity admission", () => {
    const cases = [
      "https://github.com./example/project/issues/12%2Ftail",
      "https://github.com:443/example/project/issues/12%3Ftail",
      "https://github.com./example/project/commit/abcdef1%2Ftail",
      "http://github.com:80/example/project/discussions/12%23tail",
    ];

    for (const text of cases) {
      let thrown: unknown;
      try {
        compile(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as Error).message).toBe(fixedMessage);
      expect((thrown as Error).message).not.toContain(text);
      expect(JSON.stringify(thrown)).not.toContain(text);
    }
  });

  test("filters a controlled repository before encoded-route rejection", () => {
    const result = compile(
      "https://github.com./teamleaderleo/stensibly/issues/12%2Ftail",
    );
    expect(result.decision).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });
});

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "encoded-invalid-identity-control",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}
