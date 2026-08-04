import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";
const fixedPathMessage =
  "GitHub outbound direct reference contains percent-encoded path continuation";
const fixedAuthorityMessage =
  "GitHub outbound direct reference URL authority is invalid";
const fixedSpellingMessage =
  "GitHub outbound direct reference URL spelling is invalid";

describe("GitHub outbound encoded invalid direct-route identities", () => {
  test("rejects encoded item and commit bytes before decoded identity admission", () => {
    const cases = [
      "https://github.com./example/project/issues/12%2Ftail",
      "https://github.com:443/example/project/issues/12%3Ftail",
      "https://github.com./example/project/commit/abcdef1%2Ftail",
      "http://github.com:80/example/project/discussions/12%23tail",
    ];

    for (const text of cases) {
      expectFixedRejection(text, fixedPathMessage);
    }
  });

  test("rejects hostile authority before encoded identity short-circuiting", () => {
    const cases = [
      "https://user@github.com/example/project/issues/12%2Ftail",
      "https://github.com:444/example/project/issues/12%2Ftail",
      "http://github.com:81/example/project/commit/abcdef1%2Ftail",
    ];

    for (const text of cases) {
      expectFixedRejection(text, fixedAuthorityMessage);
    }
  });

  test("rejects encoded route identities even when more path segments follow", () => {
    const cases = [
      "https://github.com./example/project/issues/12%2Ftail/more",
      "https://github.com:443/example/project/discussions/12%23tail/comments",
      "https://github.com./example/project/commit/abcdef1%2Ftail/files",
    ];

    for (const text of cases) {
      expectFixedRejection(text, fixedPathMessage);
    }
  });

  test("rejects literal public route continuations after a valid identity", () => {
    const cases = [
      "https://github.com./example/project/issues/12/files",
      "https://github.com:443/example/project/pull/12/commits",
      "https://github.com./example/project/commit/abcdef1/files",
    ];

    for (const text of cases) {
      expectFixedRejection(text, fixedSpellingMessage);
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

function expectFixedRejection(text: string, message: string): void {
  let thrown: unknown;
  try {
    compile(text);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toBe(message);
  expect((thrown as Error).message).not.toContain(text);
  expect(JSON.stringify(thrown)).not.toContain(text);
}

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
