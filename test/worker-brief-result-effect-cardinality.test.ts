import { describe, expect, test } from "bun:test";
import { compileWorkerEffectEvidenceV1 } from "../src/worker-brief-result-admission.js";

describe("worker result effect instance cardinality", () => {
  test("one declared effect ID cannot absorb two provider instances", () => {
    expect(() => compileWorkerEffectEvidenceV1({
      version: 1,
      requirementsFingerprint: `sha256:${"a".repeat(64)}`,
      observedAt: "2026-08-26T17:01:00.000Z",
      providerTaskId: "task-e-cloud-1616-effects",
      coverage: [{
        provider: "github",
        disposition: "complete",
        evidenceRefs: ["github:effect-query:complete"],
      }],
      observedEffects: [
        {
          effectId: "declared-ci-receipt",
          provider: "github",
          instanceId: "actions-run:42424242",
          evidenceRefs: ["github:actions-run:42424242"],
        },
        {
          effectId: "declared-ci-receipt",
          provider: "github",
          instanceId: "actions-run:43434343",
          evidenceRefs: ["github:actions-run:43434343"],
        },
      ],
    })).toThrow("Observed worker effect IDs must be unique");
  });
});
