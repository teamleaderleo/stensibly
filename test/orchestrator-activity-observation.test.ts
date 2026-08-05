import { describe, expect, test } from "bun:test";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation.ts";

const sourceFingerprint = `sha256:${"a".repeat(64)}`;

function validInput(): OrchestratorActivityObservationInput {
  return {
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cedar",
    sourceClass: "provider_receipt",
    sourceId: "ghop_create_1149",
    sourceFingerprint,
    observedAt: "2026-08-05T15:50:00.000Z",
    activityClass: "provider_effect",
    activityState: "succeeded",
    workItemId: "issue:1149",
    attemptId: "attempt_1",
    runId: "run_1",
    responsibilityGeneration: 3,
    causalPredecessorId: "claim_1149_3",
    relatedEvidenceIds: ["receipt_2", "receipt_1"],
    provider: "github",
    providerLifecycle: "verified",
    attentionLevel: "none",
  };
}

describe("orchestrator activity observation", () => {
  test("compiles one deterministic content-minimised deeply frozen observation", () => {
    const first = compileOrchestratorActivityObservation(validInput());
    const reordered = compileOrchestratorActivityObservation({
      ...validInput(),
      relatedEvidenceIds: ["receipt_1", "receipt_2"],
    });

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      schemaVersion: 1,
      workspace: "default",
      project: "stensibly",
      actorId: "actor_cedar",
      sourceClass: "provider_receipt",
      sourceId: "ghop_create_1149",
      sourceFingerprint,
      observedAt: "2026-08-05T15:50:00.000Z",
      activityClass: "provider_effect",
      activityState: "succeeded",
      responsibilityGeneration: 3,
      relatedEvidenceIds: ["receipt_1", "receipt_2"],
      provider: "github",
      providerLifecycle: "verified",
      attention: {
        level: "none",
        reasonCode: null,
        nextAction: null,
      },
      disclosure: {
        containsPrivateReasoning: false,
        containsRawPrompt: false,
        containsProviderBody: false,
        containsCredentialMaterial: false,
        containsUnboundedLogText: false,
      },
    });
    expect(first.observationId).toMatch(/^oao_[a-f0-9]{32}$/);
    expect(first.observationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.attention)).toBe(true);
    expect(Object.isFrozen(first.disclosure)).toBe(true);
    expect(Object.isFrozen(first.relatedEvidenceIds)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("prompt");
  });

  test("supports bounded attention without worker narrative", () => {
    const observation = compileOrchestratorActivityObservation({
      ...validInput(),
      activityClass: "reconciliation_required",
      activityState: "ambiguous",
      providerLifecycle: "pending_reconciliation",
      attentionLevel: "review",
      attentionReasonCode: "provider_outcome_ambiguous",
      nextAction: "reconcile_exact_operation",
    });

    expect(observation.attention).toEqual({
      level: "review",
      reasonCode: "provider_outcome_ambiguous",
      nextAction: "reconcile_exact_operation",
    });
  });

  test("rejects caller accessors without invoking them", () => {
    let getterCalls = 0;
    const input = { ...validInput() } as Record<string, unknown>;
    Object.defineProperty(input, "sourceId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "substituted_source";
      },
    });

    expect(() => compileOrchestratorActivityObservation(input))
      .toThrow("field sourceId must be an enumerable data property");
    expect(getterCalls).toBe(0);
  });

  test("rejects unknown fields that could retain raw content", () => {
    for (const [field, value] of [
      ["prompt", "private reasoning"],
      ["providerBody", { title: "raw provider payload" }],
      ["logText", "unbounded log content"],
      ["credential", "must not persist"],
    ] as const) {
      expect(() => compileOrchestratorActivityObservation({
        ...validInput(),
        [field]: value,
      })).toThrow("has an unknown field");
    }
  });

  test("rejects credential-shaped retained identities with fixed diagnostics", () => {
    for (const sourceId of [
      `event_github_pat_${"a".repeat(20)}`,
      `run_stn.tok_${"a".repeat(12)}`,
      `attempt_sk-proj-${"a".repeat(12)}`,
      "authorization:token",
    ]) {
      expect(() => compileOrchestratorActivityObservation({
        ...validInput(),
        sourceId,
      })).toThrow("source ID cannot contain credential material");
    }
  });

  test("requires dense unique undecorated evidence arrays", () => {
    const decorated = ["receipt_1"] as string[] & { note?: string };
    decorated.note = "must not survive";
    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      relatedEvidenceIds: decorated,
    })).toThrow("must be dense and undecorated");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      relatedEvidenceIds: ["receipt_1", "receipt_1"],
    })).toThrow("must be unique");

    const accessor = ["receipt_1"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      relatedEvidenceIds: accessor,
    })).toThrow("entries must be enumerable data properties");
  });

  test("enforces provider, attention, and activity coherence", () => {
    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      providerLifecycle: undefined,
    })).toThrow("must be supplied together");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      attentionLevel: "review",
    })).toThrow("requires a reason code and next action");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      activityClass: "attention_required",
    })).toThrow("requires non-none attention");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      activityClass: "completed",
      activityState: "in_progress",
    })).toThrow("Completed activity must be succeeded");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      activityClass: "blocked",
      activityState: "failed",
    })).toThrow("Blocked activity must use blocked state");
  });

  test("rejects noncanonical time, fingerprints, enums, and generations", () => {
    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      observedAt: "2026-08-05T15:50:00Z",
    })).toThrow("canonical timestamp");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      sourceFingerprint: `sha256:${"A".repeat(64)}`,
    })).toThrow("exact SHA-256 fingerprint");

    expect(() => compileOrchestratorActivityObservation({
      ...validInput(),
      activityState: "complete" as never,
    })).toThrow("activity state is invalid");

    for (const responsibilityGeneration of [0, 2_147_483_648, 1.5]) {
      expect(() => compileOrchestratorActivityObservation({
        ...validInput(),
        responsibilityGeneration,
      })).toThrow("Responsibility generation is invalid");
    }
  });

  test("rejects custom prototypes, symbols, and missing required fields", () => {
    const custom = Object.create({ inherited: true });
    Object.assign(custom, validInput());
    expect(() => compileOrchestratorActivityObservation(custom))
      .toThrow("plain or null prototype");

    const symbolInput = { ...validInput() } as Record<PropertyKey, unknown>;
    symbolInput[Symbol("hidden")] = "value";
    expect(() => compileOrchestratorActivityObservation(symbolInput))
      .toThrow("contains a symbol field");

    const missing = { ...validInput() } as Record<string, unknown>;
    delete missing.sourceId;
    expect(() => compileOrchestratorActivityObservation(missing))
      .toThrow("is missing field sourceId");
  });
});
