import { describe, expect, test } from "bun:test";
import {
  CI_PULL_REQUEST_PROFILE_V1,
  CI_RED_CONTROL_DECLARATION,
  CI_RED_CONTROL_LABEL,
  compileCiPullRequestProfileV1,
  type CiPullRequestProfileInputV1,
} from "../src/ci-pull-request-profile.ts";

const candidateRevision = "a".repeat(40);

function input(
  overrides: Partial<CiPullRequestProfileInputV1> = {},
): CiPullRequestProfileInputV1 {
  return {
    version: CI_PULL_REQUEST_PROFILE_V1,
    repository: "teamleaderleo/stensibly",
    pullRequestNumber: 1_082,
    candidateRevision,
    draft: false,
    labels: [],
    body: null,
    ...overrides,
  };
}

function declaration(parent: number): string {
  return [
    "## CI classification",
    CI_RED_CONTROL_DECLARATION.schema,
    CI_RED_CONTROL_DECLARATION.independentIntegration,
    `absorbing-parent: #${parent}`,
  ].join("\n");
}

function redControl(
  overrides: Partial<CiPullRequestProfileInputV1> = {},
): CiPullRequestProfileInputV1 {
  return input({
    draft: true,
    labels: [CI_RED_CONTROL_LABEL],
    body: declaration(1_100),
    ...overrides,
  });
}

describe("CI pull request profile classification", () => {
  test("keeps ordinary pull requests on the complete canonical profile", () => {
    const decision = compileCiPullRequestProfileV1(input({
      draft: true,
      labels: ["ci:stacked-prerequisite", "needs-review"],
      body: declaration(1_100),
    }));

    expect(decision).toMatchObject({
      validationProfile: "full_parallel",
      reason: "ordinary_pull_request",
      redControlLabelPresent: false,
      absorbingParentPullRequestNumber: null,
      requiresAbsorbingParentFullValidation: false,
      authorizesIntegration: false,
      authorizesMutation: false,
    });
  });

  test("admits one exact draft red-control declaration without granting integration authority", () => {
    const first = compileCiPullRequestProfileV1(redControl());
    const second = compileCiPullRequestProfileV1(redControl());

    expect(first).toMatchObject({
      version: CI_PULL_REQUEST_PROFILE_V1,
      repository: "teamleaderleo/stensibly",
      pullRequestNumber: 1_082,
      candidateRevision,
      validationProfile: "red_control_focused",
      reason: "red_control_focused",
      draft: true,
      redControlLabelPresent: true,
      absorbingParentPullRequestNumber: 1_100,
      requiresAbsorbingParentFullValidation: true,
      authorizesIntegration: false,
      authorizesMutation: false,
    });
    expect(first.decisionFingerprint).toBe(second.decisionFingerprint);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("requires draft state before reading a red-control declaration", () => {
    let reads = 0;
    const source = input({
      draft: false,
      labels: [CI_RED_CONTROL_LABEL],
      body: declaration(1_100),
    }) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(source, "body", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return declaration(1_100);
      },
    });

    expect(() => compileCiPullRequestProfileV1(source)).toThrow(
      "CI pull request profile input requires data properties",
    );
    expect(reads).toBe(0);

    const decision = compileCiPullRequestProfileV1(redControl({ draft: false }));
    expect(decision).toMatchObject({
      validationProfile: "full_parallel",
      reason: "red_control_requires_draft",
      absorbingParentPullRequestNumber: null,
    });
  });

  test("falls back to full validation for missing or contradictory declarations", () => {
    const fixtures: Array<[
      Partial<CiPullRequestProfileInputV1>,
      string,
    ]> = [
      [{ body: null }, "red_control_declaration_missing"],
      [{ body: `${CI_RED_CONTROL_DECLARATION.schema}\nabsorbing-parent: #1100` }, "red_control_declaration_missing"],
      [{
        body: `${declaration(1_100)}\n${CI_RED_CONTROL_DECLARATION.schema}`,
      }, "red_control_declaration_ambiguous"],
      [{
        body: `${CI_RED_CONTROL_DECLARATION.schema}\n${CI_RED_CONTROL_DECLARATION.independentIntegration}`,
      }, "red_control_parent_missing"],
      [{ body: declaration(1_100).replace("#1100", "PR-1100") }, "red_control_parent_invalid"],
      [{ body: `${declaration(1_100)}\nabsorbing-parent: #1101` }, "red_control_parent_ambiguous"],
      [{ body: declaration(1_082) }, "red_control_parent_self_reference"],
    ];

    for (const [overrides, reason] of fixtures) {
      expect(compileCiPullRequestProfileV1(redControl(overrides))).toMatchObject({
        validationProfile: "full_parallel",
        reason,
        absorbingParentPullRequestNumber: null,
        requiresAbsorbingParentFullValidation: false,
      });
    }
  });

  test("treats the repository label as an exact case-sensitive classification", () => {
    const decision = compileCiPullRequestProfileV1(input({
      draft: true,
      labels: ["CI:Red-Control"],
      body: declaration(1_100),
    }));
    expect(decision.validationProfile).toBe("full_parallel");
    expect(decision.redControlLabelPresent).toBe(false);
  });

  test("detaches the decision from mutable producer input", () => {
    const source = redControl();
    const decision = compileCiPullRequestProfileV1(source);
    source.labels[0] = "ordinary";
    source.body = null;
    source.draft = false;

    expect(decision).toMatchObject({
      validationProfile: "red_control_focused",
      reason: "red_control_focused",
      draft: true,
      redControlLabelPresent: true,
      absorbingParentPullRequestNumber: 1_100,
    });
  });

  test("rejects hostile label accessors without invoking them", () => {
    let reads = 0;
    const labels = new Array<string>(1);
    Object.defineProperty(labels, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return CI_RED_CONTROL_LABEL;
      },
    });

    expect(() => compileCiPullRequestProfileV1(input({ labels }))).toThrow(
      "CI pull request labels requires dense data properties",
    );
    expect(reads).toBe(0);
  });

  test("rejects malformed identities, unbounded bodies, and duplicate labels", () => {
    expect(() => compileCiPullRequestProfileV1(input({
      repository: "TeamLeaderLeo/Stensibly",
    }))).toThrow("exact lowercase owner/name identity");
    expect(() => compileCiPullRequestProfileV1(input({
      repository: "owner_with_underscore/repository",
    }))).toThrow("CI repository is invalid");
    expect(() => compileCiPullRequestProfileV1(input({
      repository: "owner--name/repository",
    }))).toThrow("CI repository is invalid");
    expect(() => compileCiPullRequestProfileV1(input({
      candidateRevision: "A".repeat(40),
    }))).toThrow("lowercase commit SHA");
    expect(() => compileCiPullRequestProfileV1(input({
      body: "x".repeat(65_537),
    }))).toThrow("body exceeds its byte limit");
    expect(() => compileCiPullRequestProfileV1(input({
      labels: [CI_RED_CONTROL_LABEL, CI_RED_CONTROL_LABEL],
    }))).toThrow("duplicate labels");
  });

  test("rejects unknown fields before reading their values", () => {
    let reads = 0;
    const source = input() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(source, "credential:github_pat_private", {
      enumerable: true,
      get() {
        reads += 1;
        return "secret";
      },
    });

    expect(() => compileCiPullRequestProfileV1(source)).toThrow(
      "CI pull request profile input contains unknown or missing fields",
    );
    expect(reads).toBe(0);
  });
});
