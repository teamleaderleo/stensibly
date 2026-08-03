import { describe, expect, test } from "bun:test";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
} from "../src/runner-adapter-v1.ts";

const adapterId = "openai-agents-js";
const adapterVersion = "1.0.0";
const profileId = "regular-agent";
const runId = "run_negative_zero";

function externalReference(generation: number) {
  return {
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint",
    adapterId,
    externalId: "checkpoint_negative_zero",
    digest: null,
    uri: null,
    generation,
    createdAt: "2026-08-02T00:00:00.000Z",
    accessClass: "private",
    containsPrivateContent: false,
    containsCredentials: false,
  };
}

function capabilityProbe(runGeneration: number) {
  return {
    version: RUNNER_ADAPTER_V1,
    probeId: "probe-negative-zero",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration,
    transport: "memory",
    transition: "new",
    clientProduct: "negative-zero-control",
    clientBuild: null,
    modelProfile: null,
    externalSurfaceRef: null,
    requiredCapabilities: [],
    recoveryActions: [],
    observedAt: "2026-08-02T00:00:00.000Z",
    traceId: null,
  };
}

describe("shared runner generation numeric identity", () => {
  test("rejects negative zero in nullable generation parsing", () => {
    expect(() => parseRunnerExternalReferenceV1(externalReference(-0)))
      .toThrow("non-negative safe integer");
  });

  test("rejects negative zero in capability generation parsing", () => {
    expect(() => parseRunnerCapabilityProbeV1(capabilityProbe(-0)))
      .toThrow("non-negative safe integer");
  });

  test("preserves ordinary zero in non-negative generation fields", () => {
    const reference = parseRunnerExternalReferenceV1(externalReference(0));
    const probe = parseRunnerCapabilityProbeV1(capabilityProbe(0));

    expect(reference.generation).toBe(0);
    expect(probe.runGeneration).toBe(0);
    expect(Object.is(reference.generation, -0)).toBe(false);
    expect(Object.is(probe.runGeneration, -0)).toBe(false);
  });
});
