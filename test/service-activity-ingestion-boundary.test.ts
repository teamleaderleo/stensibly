import { describe, expect, test } from "bun:test";
import {
  aggregateServiceActivity,
  type ServiceRequestObservation,
} from "../src/service-activity-contract.ts";

const observation: ServiceRequestObservation = {
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
};

describe("service activity ingestion boundary", () => {
  test("counts every supplied observation and does not retain a producer delivery identity", () => {
    const delivered = {
      ...observation,
      requestId: "req-private-delivery-identity",
    } as ServiceRequestObservation & { requestId: string };

    const [bucket] = aggregateServiceActivity([delivered, delivered], "minute");
    if (!bucket) throw new Error("Missing service activity bucket");

    expect(bucket.requestCount).toBe(2);
    expect(bucket.duration.count).toBe(2);
    expect(JSON.stringify(bucket)).not.toContain("req-private-delivery-identity");
    expect(Object.prototype.hasOwnProperty.call(bucket, "requestId")).toBe(false);
  });
});
