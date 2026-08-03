import { describe, expect, test } from "bun:test";
import {
  compileGitHubOutboundTextPreflightV1,
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
} from "../src/github-outbound-text-preflight.ts";

const repository = "teamleaderleo/stensibly";

function compile(
  text: string,
  controlledRepositories: readonly string[] = [repository],
) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "outbound-policy-w01",
      controlledRepositories,
      externalReferenceDisposition: "require_authority",
    },
    repositoryFullName: repository,
    field: "comment",
    text,
  });
}

describe("GitHub outbound finding identity", () => {
  test("binds distinct full commits behind the same public prefix", () => {
    const left = compile("See example/project@abcd111");
    const right = compile("See example/project@abcd222");

    expect(left.findings[0]).toMatchObject({
      externalOwner: "example",
      externalRepository: "project",
      commitPrefix: "abcd",
    });
    expect(right.findings[0]).toMatchObject({
      externalOwner: "example",
      externalRepository: "project",
      commitPrefix: "abcd",
    });
    expect(left.findings[0]?.findingFingerprint).not.toBe(
      right.findings[0]?.findingFingerprint,
    );
    expect(JSON.stringify(left)).not.toContain("abcd111");
    expect(JSON.stringify(right)).not.toContain("abcd222");
  });

  test("binds distinct out-of-range item tokens after public minimization", () => {
    const left = compile("See example/project#2147483648");
    const right = compile("See example/project#2147483649");

    expect(left.findings[0]?.itemNumber).toBeNull();
    expect(right.findings[0]?.itemNumber).toBeNull();
    expect(left.findings[0]?.findingFingerprint).not.toBe(
      right.findings[0]?.findingFingerprint,
    );
  });

  test("rejects controlled-repository arrays with a replaced prototype", () => {
    const repositories = [repository];
    Object.setPrototypeOf(repositories, Object.create(Array.prototype));

    expect(() => compile("safe", repositories)).toThrow(
      "GitHub outbound controlled repositories must use Array.prototype",
    );
  });
});
