import { describe, expect, test } from "bun:test";
import {
  ASSURANCE_OVERLAY_V1,
  compileAssuranceOverlayV1,
  selectAssuranceOverlayV1,
  type AssuranceOverlayInputV1,
  type AssuranceOverlaySelectionContextInputV1,
} from "../src/assurance-overlay.ts";

const manifest = `sha256:${"a".repeat(64)}`;
const otherManifest = `sha256:${"b".repeat(64)}`;
const revision = "c".repeat(40);

function overlay(
  overrides: Partial<AssuranceOverlayInputV1> = {},
): AssuranceOverlayInputV1 {
  return {
    version: ASSURANCE_OVERLAY_V1,
    overlayId: "gemini-antigravity-calibration",
    revision: 1,
    issuedAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-08-07T00:00:00.000Z",
    selector: {
      adapterId: "antigravity",
      executionSurface: "github-connector",
      providerId: "google",
      modelId: "gemini-3.6-flash",
      profileId: "high-reasoning",
      protocolVersion: "stensibly-agent-ops/0.4.0",
      harnessVersion: "antigravity/2026-07-31",
      toolManifestFingerprint: manifest,
      taskClasses: ["canonical-state-review", "evidence-audit"],
      riskClasses: ["tier_1", "tier_2"],
      priority: 100,
    },
    scope: {
      repositories: ["TeamLeaderLeo/Stensibly"],
      projects: ["oauth_dogfood"],
      resources: ["issue:510"],
      writeClasses: ["disposable_candidate", "canonical_state"],
      operations: ["github.issue.update", "github.pull_request.merge"],
      fileFence: ["src/assurance-overlay.ts", "test/assurance-overlay.test.ts"],
      metadataFence: ["issue:510:body", "pull_request:580:state"],
    },
    requirements: {
      checks: ["runtime-parity", "test"],
      stopConditions: [
        "Stop when the exact head moves.",
        "Stop when a requested operation leaves the declared fence.",
      ],
      reviewPolicy: "independent_when_canonical",
      expectedRevision: revision,
      evidenceRefs: ["issue:510", "issue:324:comment:5105105936"],
    },
    instructions: [
      "Classify material claims as observed, inferred, or unobserved.",
      "Perform factual and scope-impact audits before handoff.",
    ],
    ...overrides,
  };
}

function context(
  overrides: Partial<AssuranceOverlaySelectionContextInputV1> = {},
): AssuranceOverlaySelectionContextInputV1 {
  return {
    adapterId: "antigravity",
    executionSurface: "github-connector",
    providerId: "google",
    modelId: "gemini-3.6-flash",
    profileId: "high-reasoning",
    protocolVersion: "stensibly-agent-ops/0.4.0",
    harnessVersion: "antigravity/2026-07-31",
    toolManifestFingerprint: manifest,
    taskClass: "canonical-state-review",
    riskClass: "tier_2",
    repository: "teamleaderleo/stensibly",
    project: "oauth_dogfood",
    resource: "issue:510",
    writeClass: "canonical_state",
    operation: "github.issue.update",
    currentRevision: revision,
    requestedFiles: ["src/assurance-overlay.ts"],
    requestedMetadata: ["issue:510:body"],
    observedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

function selectAtContextTime(
  overlaysValue: unknown,
  contextValue: AssuranceOverlaySelectionContextInputV1,
) {
  return selectAssuranceOverlayV1(
    overlaysValue,
    contextValue,
    () => new Date(contextValue.observedAt),
  );
}

describe("assurance overlay contract", () => {
  test("compiles a deterministic deeply frozen overlay", () => {
    const first = compileAssuranceOverlayV1(overlay());
    const second = compileAssuranceOverlayV1(overlay({
      selector: {
        ...overlay().selector,
        taskClasses: ["evidence-audit", "canonical-state-review"],
        riskClasses: ["tier_2", "tier_1"],
      },
      scope: {
        ...overlay().scope,
        repositories: ["teamleaderleo/stensibly"],
        operations: ["github.pull_request.merge", "github.issue.update"],
      },
      requirements: {
        ...overlay().requirements,
        checks: ["test", "runtime-parity"],
      },
    }));

    expect(first.overlayFingerprint).toBe(second.overlayFingerprint);
    expect(first.overlayFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.scope.repositories).toEqual(["teamleaderleo/stensibly"]);
    expect(first.scope.projects).toEqual(["oauth_dogfood"]);
    expect(first.requirements.selfReviewPasses).toEqual([
      "factual_evidence",
      "scope_impact",
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.scope.projects)).toBe(true);
  });

  test("selects one exact live overlay with one trusted clock read", () => {
    const selectionContext = context();
    let reads = 0;
    const selection = selectAssuranceOverlayV1(
      [overlay()],
      selectionContext,
      () => {
        reads += 1;
        return new Date(selectionContext.observedAt);
      },
    );

    expect(reads).toBe(1);
    expect(selection).toMatchObject({
      version: ASSURANCE_OVERLAY_V1,
      authorizesOperation: false,
      authorizesCanonicalWrite: false,
    });
    expect(selection?.overlay.overlayId).toBe(
      "gemini-antigravity-calibration",
    );
    expect(selection?.selectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection?.context)).toBe(true);
  });

  test("fails closed for missing, throwing, invalid, or mismatched clocks", () => {
    const selectionContext = context();
    expect(selectAssuranceOverlayV1(
      [overlay()],
      selectionContext,
      undefined as never,
    )).toBeNull();
    expect(selectAssuranceOverlayV1(
      [overlay()],
      selectionContext,
      () => { throw new Error("secret-bearing clock failure"); },
    )).toBeNull();
    expect(selectAssuranceOverlayV1(
      [overlay()],
      selectionContext,
      () => new Date(Number.NaN),
    )).toBeNull();
    expect(selectAssuranceOverlayV1(
      [overlay()],
      selectionContext,
      () => new Date("2026-07-31T12:00:01.000Z"),
    )).toBeNull();
  });

  test("cannot revive an expired overlay with caller-controlled time", () => {
    const backdated = context({ observedAt: "2026-07-31T12:00:00.000Z" });
    expect(selectAssuranceOverlayV1(
      [overlay()],
      backdated,
      () => new Date("2026-08-07T00:00:00.000Z"),
    )).toBeNull();

    const expired = context({ observedAt: "2026-08-07T00:00:00.000Z" });
    expect(selectAtContextTime([overlay()], expired)).toBeNull();
    const beforeIssue = context({ observedAt: "2026-07-30T23:59:59.999Z" });
    expect(selectAtContextTime([overlay()], beforeIssue)).toBeNull();
  });

  test("leaves unrelated workers and materially changed harnesses unselected", () => {
    for (const changed of [
      context({ modelId: "gemini-4" }),
      context({ harnessVersion: "antigravity/2026-08-01" }),
      context({ toolManifestFingerprint: otherManifest }),
      context({ adapterId: "codex" }),
    ]) {
      expect(selectAtContextTime([overlay()], changed)).toBeNull();
    }
  });

  test("chooses one unique highest-priority overlay", () => {
    const lower = overlay({
      overlayId: "lower-priority",
      selector: { ...overlay().selector, priority: 10 },
    });
    expect(selectAtContextTime([lower, overlay()], context())?.overlay.overlayId)
      .toBe("gemini-antigravity-calibration");

    const tied = overlay({ overlayId: "tied-priority", revision: 2 });
    expect(() => selectAtContextTime([overlay(), tied], context()))
      .toThrow("Assurance overlay selection is ambiguous at priority 100");
  });

  test("keeps descriptor admission ahead of hostile getters", () => {
    let reads = 0;
    const hostile = overlay() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, "scope", {
      enumerable: true,
      get() {
        reads += 1;
        return overlay().scope;
      },
    });
    expect(() => compileAssuranceOverlayV1(hostile))
      .toThrow("Assurance overlay fields must be enumerable data properties");
    expect(reads).toBe(0);

    const decorated = [overlay()] as AssuranceOverlayInputV1[] & {
      authority?: boolean;
    };
    decorated.authority = true;
    expect(() => selectAtContextTime(decorated, context()))
      .toThrow("Assurance overlay catalogue contains unsupported fields");
  });
});
