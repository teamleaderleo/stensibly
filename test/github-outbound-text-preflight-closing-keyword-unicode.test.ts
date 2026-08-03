import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";

function compile(text: string) {
  return compileGitHubOutboundTextPreflightV1({
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "unicode-closing-keyword-boundary",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition: "reject",
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  });
}

describe("GitHub outbound closing-keyword Unicode boundaries", () => {
  test("keeps keywords embedded in Unicode identifiers as ordinary references", () => {
    for (const text of [
      "αFixes example/project#12",
      "变量Resolves example/project#12",
      "9Closes example/project#12",
      "_Fixes example/project#12",
      "\u0301Fixes example/project#12",
    ]) {
      const result = compile(text);
      expect(result).toMatchObject({
        decision: "reject",
        findings: [{
          source: "repository_shorthand",
          externalOwner: "example",
          externalRepository: "project",
          itemNumber: 12,
          rule: "external_reference",
        }],
      });
      expect(result.findings).toHaveLength(1);
    }
  });

  test("preserves standalone closing keywords at line start and after punctuation", () => {
    for (const text of [
      "Fixes example/project#12",
      "See: Fixes example/project#12",
      "（Resolves example/project#12）",
    ]) {
      const result = compile(text);
      expect(result).toMatchObject({
        decision: "reject",
        findings: [{
          source: "repository_shorthand",
          externalOwner: "example",
          externalRepository: "project",
          itemNumber: 12,
          rule: "external_closing_reference",
        }],
      });
      expect(result.findings).toHaveLength(1);
    }
  });
});
