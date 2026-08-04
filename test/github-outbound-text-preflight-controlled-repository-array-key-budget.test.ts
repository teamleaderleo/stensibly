import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";

describe("GitHub outbound controlled-repository array key budget", () => {
  test("projects declared repositories without enumerating caller decorations", () => {
    const hostile = decoratedArray([controlledRepository]);

    const result = compileGitHubOutboundTextPreflightV1({
      schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policy: {
        version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
        policyId: "controlled-repository-key-budget",
        controlledRepositories: hostile.value,
        externalReferenceDisposition: "reject",
      },
      repositoryFullName: controlledRepository,
      field: "comment",
      text: "https://github.com/teamleaderleo/stensibly/issues/12",
    });

    expect(result.decision).toBe("pass");
    expect(result.findings).toHaveLength(0);
    expect(hostile.ownKeysCalls()).toBe(0);
  });
});

function decoratedArray<T>(entries: readonly T[]): {
  value: T[];
  ownKeysCalls: () => number;
} {
  let calls = 0;
  const target = [...entries];
  Object.defineProperty(target, "callerDecoration", {
    value: "must be discarded during detachment",
    enumerable: true,
    configurable: true,
  });
  const value = new Proxy(target, {
    ownKeys() {
      calls += 1;
      throw new Error("Controlled-repository array ownKeys must not run");
    },
  });
  return {
    value,
    ownKeysCalls: () => calls,
  };
}
