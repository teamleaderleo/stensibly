import { describe, expect, test } from "bun:test";
import {
  executionEnvelopeJson,
  parseExecutionActual,
  parseExecutionEnvelope,
  type ExecutionEnvelope,
} from "../src/execution-envelope.ts";

export function envelope(overrides: Partial<ExecutionEnvelope> = {}): ExecutionEnvelope {
  return {
    schemaVersion: 1,
    objective: "Implement and verify the bounded change",
    scopeClass: "segmented",
    estimate: {
      lowMinutes: 35,
      likelyMinutes: 65,
      highMinutes: 95,
      confidence: 0.58,
    },
    budget: {
      expectedMessages: 3,
      expectedToolCalls: 40,
      expectedReviewMinutes: 12,
    },
    boundaries: {
      softCheckpointMinutes: 75,
      forcedHandoffMinutes: 105,
      hardRecoveryMinutes: 120,
    },
    completion: {
      requiredOutputs: ["working implementation", "tests", "changed-file summary"],
      verificationRequired: true,
      continuationStateRequired: true,
      acceptanceChecks: [
        "targeted tests pass",
        "changed files match the declared scope",
      ],
    },
    durableState: {
      accessClass: "project",
      retentionClass: "standard",
      redactionRequired: true,
      deleteAfter: null,
    },
    ...overrides,
  };
}

describe("execution envelope", () => {
  test("normalizes the canonical versioned contract deterministically", () => {
    const parsed = parseExecutionEnvelope(envelope({
      objective: "  Implement and verify the bounded change  ",
      durableState: {
        accessClass: "project",
        retentionClass: "standard",
        redactionRequired: true,
        deleteAfter: "2026-08-01T12:00:00-07:00",
      },
    }));

    expect(parsed.objective).toBe("Implement and verify the bounded change");
    expect(parsed.durableState.deleteAfter).toBe("2026-08-01T19:00:00.000Z");
    expect(JSON.parse(executionEnvelopeJson(parsed))).toEqual(parsed);
  });

  test("rejects malformed estimate ranges, budgets, and boundaries", () => {
    expect(() => parseExecutionEnvelope(envelope({
      estimate: { lowMinutes: 70, likelyMinutes: 60, highMinutes: 90, confidence: 0.5 },
    }))).toThrow(/lowMinutes <= likelyMinutes <= highMinutes/);
    expect(() => parseExecutionEnvelope(envelope({
      budget: { expectedMessages: -1, expectedToolCalls: 2, expectedReviewMinutes: 3 },
    }))).toThrow(/Expected messages/);
    expect(() => parseExecutionEnvelope(envelope({
      boundaries: {
        softCheckpointMinutes: 100,
        forcedHandoffMinutes: 90,
        hardRecoveryMinutes: 120,
      },
    }))).toThrow(/softCheckpointMinutes <= forcedHandoffMinutes <= hardRecoveryMinutes/);
    expect(() => parseExecutionEnvelope(envelope({
      estimate: { lowMinutes: 1, likelyMinutes: 2, highMinutes: 3, confidence: Number.NaN },
    }))).toThrow(/Estimate confidence/);
  });

  test("rejects unknown scope classes, extra fields, and credential-shaped text", () => {
    expect(() => parseExecutionEnvelope({ ...envelope(), scopeClass: "huge" })).toThrow(
      /scope class is invalid/i,
    );
    expect(() => parseExecutionEnvelope({ ...envelope(), arbitrary: true })).toThrow(
      /unsupported field arbitrary/,
    );
    expect(() => parseExecutionEnvelope(envelope({ objective: "Use stn.tok_deadbeef" }))).toThrow(
      /credential-shaped/,
    );
  });

  test("validates bounded actual-result fields without changing the estimate", () => {
    expect(parseExecutionActual({
      durationMinutes: 84.5,
      filesChanged: 14,
      messagesConsumed: 4,
      toolCalls: 47,
      reviewMinutes: 9.25,
      estimateErrorReasons: ["hidden dependency", "broader test failures"],
    })).toEqual({
      durationMinutes: 84.5,
      filesChanged: 14,
      messagesConsumed: 4,
      toolCalls: 47,
      reviewMinutes: 9.25,
      estimateErrorReasons: ["hidden dependency", "broader test failures"],
    });
    expect(() => parseExecutionActual({ filesChanged: 1.5 })).toThrow(/Files changed/);
    expect(() => parseExecutionActual({ arbitrary: true })).toThrow(/unsupported field arbitrary/);
  });
});
