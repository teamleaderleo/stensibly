import { describe, expect, test } from "bun:test";
import {
  addServiceRequestObservation,
  aggregateServiceActivity,
  mergeServiceActivityBuckets,
  parseServiceRequestObservation,
  serviceActivityDimensionKey,
  serviceActivityWindow,
  summarizeServiceActivity,
  type ServiceRequestObservation,
} from "../src/service-activity-contract.ts";

const manifestDigest = `sha256:${"a".repeat(64)}`;

function observation(
  overrides: Partial<ServiceRequestObservation> = {},
): ServiceRequestObservation {
  return {
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
    workerVersionId: "worker-123",
    releaseId: "release-1",
    manifestDigest,
    ...overrides,
  };
}

describe("service activity contract", () => {
  test("accepts only bounded closed dimensions and explicit unknown classes", () => {
    expect(parseServiceRequestObservation(observation())).toEqual(observation());
    expect(parseServiceRequestObservation(observation({
      clientClass: "unknown",
      authMode: "unknown",
      operationClass: "unknown",
      requestIntent: "unknown",
    }))).toMatchObject({
      clientClass: "unknown",
      authMode: "unknown",
      operationClass: "unknown",
      requestIntent: "unknown",
    });

    expect(() => parseServiceRequestObservation({
      ...observation(),
      clientClass: "Mozilla/5.0 arbitrary browser fingerprint",
    })).toThrow("closed server vocabulary");
    expect(() => parseServiceRequestObservation({
      ...observation(),
      requestIntent: "whatever-the-client-says",
    })).toThrow("closed server vocabulary");
    expect(() => parseServiceRequestObservation({
      ...observation(),
      workspace: "Main Workspace",
    })).toThrow("bounded lowercase slug");
    expect(() => parseServiceRequestObservation({
      ...observation(),
      workerVersionId: "worker id with spaces",
    })).toThrow("bounded diagnostic identifier");
    expect(() => parseServiceRequestObservation({
      ...observation(),
      manifestDigest: `sha256:${"A".repeat(64)}`,
    })).toThrow("64 lowercase hex");
  });

  test("enforces outcome, status, latency, and failure-category consistency", () => {
    expect(() => parseServiceRequestObservation(observation({
      outcome: "failure",
      status: 200,
    }))).toThrow("does not match HTTP status");
    expect(() => parseServiceRequestObservation(observation({
      outcome: "success",
      status: 500,
    }))).toThrow("does not match HTTP status");
    expect(() => parseServiceRequestObservation({
      ...observation(),
      failureCategory: "mcp_failure",
    })).toThrow("Successful observations cannot carry");
    expect(() => parseServiceRequestObservation(observation({ durationMs: -1 })))
      .toThrow("durationMs must be a finite number");
    expect(() => parseServiceRequestObservation(observation({ status: 99 })))
      .toThrow("status must be an integer");

    expect(parseServiceRequestObservation({
      ...observation({ outcome: "failure", status: 502 }),
      failureCategory: undefined,
    })).toMatchObject({
      outcome: "failure",
      failureCategory: "unknown",
    });
  });

  test("aligns minute, hour, and day windows in UTC", () => {
    expect(serviceActivityWindow(observation().observedAt, "minute")).toEqual({
      startAt: "2026-07-29T15:03:00.000Z",
      endAt: "2026-07-29T15:04:00.000Z",
    });
    expect(serviceActivityWindow(observation().observedAt, "hour")).toEqual({
      startAt: "2026-07-29T15:00:00.000Z",
      endAt: "2026-07-29T16:00:00.000Z",
    });
    expect(serviceActivityWindow(observation().observedAt, "day")).toEqual({
      startAt: "2026-07-29T00:00:00.000Z",
      endAt: "2026-07-30T00:00:00.000Z",
    });
  });

  test("aggregates counts, status, intent, failures, duration, and release dimensions", () => {
    const buckets = aggregateServiceActivity([
      observation({ durationMs: 9 }),
      observation({
        observedAt: "2026-07-29T15:03:40.000Z",
        requestIntent: "interactive",
        durationMs: 240,
      }),
      observation({
        observedAt: "2026-07-29T15:03:50.000Z",
        requestIntent: "verification",
        outcome: "failure",
        status: 502,
        durationMs: 2_200,
        failureCategory: "convex_failure",
      }),
    ], "minute");

    expect(buckets).toHaveLength(1);
    const [bucket] = buckets;
    expect(bucket).toMatchObject({
      schemaVersion: 1,
      interval: "minute",
      startAt: "2026-07-29T15:03:00.000Z",
      endAt: "2026-07-29T15:04:00.000Z",
      dimensions: {
        workspace: "main",
        routeClass: "rest_v1",
        operationClass: "read",
        clientClass: "dashboard",
        authMode: "bearer_token",
        workerVersionId: "worker-123",
        releaseId: "release-1",
        manifestDigest,
      },
      requestCount: 3,
      successCount: 2,
      failureCount: 1,
      lastObservedAt: "2026-07-29T15:03:50.000Z",
      duration: {
        count: 3,
        sumMs: 2_449,
        minMs: 9,
        maxMs: 2_200,
      },
    });
    expect(bucket?.statusBands).toMatchObject({ "2xx": 2, "5xx": 1 });
    expect(bucket?.requestIntents).toMatchObject({
      background_refresh: 1,
      interactive: 1,
      verification: 1,
    });
    expect(bucket?.failureCategories.convex_failure).toBe(1);
    expect(bucket?.duration.histogram).toMatchObject({
      le_10: 1,
      le_250: 1,
      le_2500: 1,
    });
  });

  test("separates time windows and safe dimensions deterministically", () => {
    const buckets = aggregateServiceActivity([
      observation(),
      observation({ observedAt: "2026-07-29T15:04:00.000Z" }),
      observation({ clientClass: "chatgpt", routeClass: "mcp" }),
      observation({ releaseId: "release-2" }),
    ], "minute");

    expect(buckets).toHaveLength(4);
    expect(new Set(buckets.map((bucket) => serviceActivityDimensionKey(bucket.dimensions))).size)
      .toBe(3);
  });

  test("rejects observations from another window or dimension", () => {
    const [bucket] = aggregateServiceActivity([observation()], "minute");
    if (!bucket) throw new Error("Missing fixture bucket");

    expect(() => addServiceRequestObservation(bucket, observation({
      observedAt: "2026-07-29T15:04:00.000Z",
    }))).toThrow("outside");
    expect(() => addServiceRequestObservation(bucket, observation({
      clientClass: "chatgpt",
    }))).toThrow("dimensions do not match");
  });

  test("merges equivalent partial aggregates and rejects unrelated buckets", () => {
    const [left] = aggregateServiceActivity([observation({ durationMs: 25 })], "hour");
    const [right] = aggregateServiceActivity([
      observation({
        observedAt: "2026-07-29T15:30:00.000Z",
        outcome: "failure",
        status: 401,
        durationMs: 75,
        failureCategory: "auth_failure",
      }),
    ], "hour");
    if (!left || !right) throw new Error("Missing fixture buckets");

    expect(mergeServiceActivityBuckets(left, right)).toMatchObject({
      requestCount: 2,
      successCount: 1,
      failureCount: 1,
      duration: { count: 2, sumMs: 100, minMs: 25, maxMs: 75 },
    });

    const [different] = aggregateServiceActivity([
      observation({ clientClass: "operator_cli" }),
    ], "hour");
    if (!different) throw new Error("Missing different bucket");
    expect(() => mergeServiceActivityBuckets(left, different)).toThrow("equivalent");
  });

  test("summarizes success, background share, and bounded latency percentiles", () => {
    const durations = [5, 12, 30, 75, 120, 300, 700, 1_500, 4_000, 12_000];
    const buckets = aggregateServiceActivity(durations.map((durationMs, index) => observation({
      observedAt: `2026-07-29T15:03:${String(index).padStart(2, "0")}.000Z`,
      durationMs,
      requestIntent: index < 6 ? "background_refresh" : "interactive",
      ...(index === 9
        ? { outcome: "failure" as const, status: 500, failureCategory: "gateway_failure" as const }
        : {}),
    })), "minute");

    expect(summarizeServiceActivity(buckets)).toEqual({
      requestCount: 10,
      successRate: 0.9,
      backgroundRefreshShare: 0.6,
      p50LatencyUpperBoundMs: 250,
      p95LatencyUpperBoundMs: null,
      latencyOverflowAtP50: false,
      latencyOverflowAtP95: true,
    });
    expect(summarizeServiceActivity([])).toEqual({
      requestCount: 0,
      successRate: null,
      backgroundRefreshShare: null,
      p50LatencyUpperBoundMs: null,
      p95LatencyUpperBoundMs: null,
      latencyOverflowAtP50: false,
      latencyOverflowAtP95: false,
    });
  });

  test("the aggregate contains no raw request, identity, payload, or URL fields", () => {
    const [bucket] = aggregateServiceActivity([observation()], "minute");
    if (!bucket) throw new Error("Missing fixture bucket");
    const serialized = JSON.stringify(bucket);

    for (const forbidden of [
      "requestId",
      "authorization",
      "cookie",
      "token",
      "ipAddress",
      "userAgent",
      "requestBody",
      "responseBody",
      "prompt",
      "itemTitle",
      "queryText",
      "url",
      "path",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
