import { describe, expect, test } from "bun:test";
import { parseServiceRequestObservation } from "../src/service-activity-contract.ts";

const observation = {
  workspace: "main",
  observedAt: "2026-07-29T15:03:04.567Z",
  routeClass: "rest_v1",
  operationClass: "read",
  clientClass: "dashboard",
  authMode: "bearer_token",
  requestIntent: "background_refresh",
  outcome: "success",
  status: 200,
  durationMs: 42,
} as const;

describe("service activity timestamp identity", () => {
  test("accepts canonical UTC timestamps with seconds or milliseconds", () => {
    expect(parseServiceRequestObservation(observation).observedAt)
      .toBe("2026-07-29T15:03:04.567Z");
    expect(parseServiceRequestObservation({
      ...observation,
      observedAt: "2026-07-29T15:03:04Z",
    }).observedAt).toBe("2026-07-29T15:03:04.000Z");
  });

  test("rejects locale strings, offsets, missing zones, and impossible dates", () => {
    for (const observedAt of [
      "July 29, 2026 15:03 UTC",
      "2026-07-29T17:03:04+02:00",
      "2026-07-29T15:03:04",
      "2026-02-30T15:03:04Z",
    ]) {
      expect(() => parseServiceRequestObservation({ ...observation, observedAt }))
        .toThrow("canonical UTC ISO timestamp");
    }
  });
});
