import { describe, expect, test } from "bun:test";
import {
  ASSURANCE_OVERLAY_V1,
  compileAssuranceOverlayV1,
  selectAssuranceOverlayV1,
  type AssuranceOverlayInputV1,
  type AssuranceOverlaySelectionContextInputV1,
} from "../src/assurance-overlay.ts";

const manifest = `sha256:${"1".repeat(64)}`;
const revision = "2".repeat(40);

function overlay(
  overrides: Partial<AssuranceOverlayInputV1> = {},
): AssuranceOverlayInputV1 {
  return {
    version: ASSURANCE_OVERLAY_V1,
    overlayId: "exact-scope-assurance",
    revision: 1,
    issuedAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    selector: {
      adapterId: "codex",
      executionSurface: "github",
      providerId: "openai",
      modelId: "gpt-5.6",
      profileId: "repository-repair",
      protocolVersion: "runner/v1",
      harnessVersion: "stensibly/2026-07-31",
      toolManifestFingerprint: manifest,
      taskClasses: ["repository-repair"],
      riskClasses: ["tier_1", "tier_2"],
      priority: 50,
    },
    scope: {
      repositories: ["teamleaderleo/stensibly"],
      projects: ["oauth_dogfood"],
      resources: ["issue:510"],
      writeClasses: ["disposable_candidate"],
      operations: ["github.pull_request.update"],
      fileFence: [
        "src/assurance-overlay.ts",
        "test/assurance-overlay-selector-regression.test.ts",
      ],
      metadataFence: ["pull_request:692:body"],
    },
    requirements: {
      checks: ["typecheck", "focused-tests"],
      stopConditions: ["Stop when revision or scope changes."],
      reviewPolicy: "independent_when_canonical",
      expectedRevision: revision,
      evidenceRefs: ["pull_request:692"],
    },
    instructions: ["Apply assurance only to the exact reviewed scope."],
    ...overrides,
  };
}

function context(
  overrides: Partial<AssuranceOverlaySelectionContextInputV1> = {},
): AssuranceOverlaySelectionContextInputV1 {
  return {
    adapterId: "codex",
    executionSurface: "github",
    providerId: "openai",
    modelId: "gpt-5.6",
    profileId: "repository-repair",
    protocolVersion: "runner/v1",
    harnessVersion: "stensibly/2026-07-31",
    toolManifestFingerprint: manifest,
    taskClass: "repository-repair",
    riskClass: "tier_1",
    repository: "teamleaderleo/stensibly",
    project: "oauth_dogfood",
    resource: "issue:510",
    writeClass: "disposable_candidate",
    operation: "github.pull_request.update",
    currentRevision: revision,
    requestedFiles: ["src/assurance-overlay.ts"],
    requestedMetadata: ["pull_request:692:body"],
    observedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

function selectAtContextTime(
  overlays: unknown,
  selectionContext: AssuranceOverlaySelectionContextInputV1,
) {
  return selectAssuranceOverlayV1(
    overlays,
    selectionContext,
    () => new Date(selectionContext.observedAt),
  );
}

describe("assurance overlay selector regressions", () => {
  test("requires exact lowercase project identities", () => {
    expect(() => compileAssuranceOverlayV1(overlay({
      scope: { ...overlay().scope, projects: ["OAuth_Dogfood"] },
    }))).toThrow("Assurance project is invalid");
    expect(() => compileAssuranceOverlayV1(overlay({
      scope: { ...overlay().scope, projects: ["oauth_Dogfood"] },
    }))).toThrow("Assurance project is invalid");
    expect(() => selectAtContextTime(
      [overlay()],
      context({ project: "OAuth_Dogfood" }),
    )).toThrow("Assurance project is invalid");
    expect(selectAtContextTime([overlay()], context())).not.toBeNull();
  });

  test("requires exact current revision when an overlay is revision-bound", () => {
    expect(selectAtContextTime(
      [overlay()],
      context({ currentRevision: "3".repeat(40) }),
    )).toBeNull();
    expect(selectAtContextTime(
      [overlay()],
      context({ currentRevision: null }),
    )).toBeNull();

    const digest = `sha256:${"4".repeat(64)}`;
    const digestOverlay = overlay({
      requirements: { ...overlay().requirements, expectedRevision: digest },
    });
    expect(selectAtContextTime(
      [digestOverlay],
      context({ currentRevision: digest }),
    )).not.toBeNull();
    expect(selectAtContextTime(
      [digestOverlay],
      context({ currentRevision: `sha256:${"5".repeat(64)}` }),
    )).toBeNull();
  });

  test("enforces every requested file and metadata target", () => {
    expect(selectAtContextTime(
      [overlay()],
      context({ requestedFiles: ["src/assurance-overlay.ts"] }),
    )).not.toBeNull();
    expect(selectAtContextTime(
      [overlay()],
      context({ requestedFiles: ["src/other.ts"] }),
    )).toBeNull();
    expect(selectAtContextTime(
      [overlay()],
      context({ requestedMetadata: ["issue:510:body"] }),
    )).toBeNull();

    const emptyFences = overlay({
      scope: { ...overlay().scope, fileFence: [], metadataFence: [] },
    });
    expect(selectAtContextTime(
      [emptyFences],
      context({ requestedFiles: [], requestedMetadata: [] }),
    )).not.toBeNull();
    expect(selectAtContextTime(
      [emptyFences],
      context({ requestedFiles: ["src/assurance-overlay.ts"] }),
    )).toBeNull();
  });

  test("requires exact supplied and null target dimensions", () => {
    for (const changed of [
      context({ repository: "openai/openai" }),
      context({ project: "other_project" }),
      context({ resource: "issue:999" }),
      context({ repository: null }),
      context({ project: null }),
      context({ resource: null }),
    ]) {
      expect(selectAtContextTime([overlay()], changed)).toBeNull();
    }

    const repositoryOnly = overlay({
      scope: {
        ...overlay().scope,
        projects: [],
        resources: [],
      },
    });
    expect(selectAtContextTime(
      [repositoryOnly],
      context({ project: null, resource: null }),
    )).not.toBeNull();
    expect(selectAtContextTime([repositoryOnly], context())).toBeNull();
  });

  test("requires revision-bound independent review for canonical writes", () => {
    expect(() => compileAssuranceOverlayV1(overlay({
      scope: { ...overlay().scope, writeClasses: ["canonical_state"] },
      requirements: {
        ...overlay().requirements,
        expectedRevision: null,
        reviewPolicy: "independent_required",
      },
    }))).toThrow("require an expected revision");

    expect(() => compileAssuranceOverlayV1(overlay({
      scope: { ...overlay().scope, writeClasses: ["canonical_state"] },
      requirements: {
        ...overlay().requirements,
        reviewPolicy: "self_review",
      },
    }))).toThrow("require independent review");
  });

  test("rejects decorated requested-target arrays before selection", () => {
    const requestedFiles = ["src/assurance-overlay.ts"] as string[] & {
      authority?: boolean;
    };
    requestedFiles.authority = true;
    expect(() => selectAtContextTime(
      [overlay()],
      context({ requestedFiles }),
    )).toThrow("Assurance requested files contains unknown field authority");
  });

  test("binds the attested observation time into selection identity", () => {
    const firstContext = context({ observedAt: "2026-07-31T12:00:00.000Z" });
    const secondContext = context({ observedAt: "2026-07-31T12:00:01.000Z" });
    const first = selectAtContextTime([overlay()], firstContext);
    const second = selectAtContextTime([overlay()], secondContext);
    expect(first?.selectionFingerprint).not.toBe(second?.selectionFingerprint);
  });
});
