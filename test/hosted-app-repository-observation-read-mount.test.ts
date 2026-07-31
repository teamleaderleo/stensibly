import { describe, expect, test } from "bun:test";
import type { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { hostedProviderCapacityFromEnv } from "../src/hosted-app.ts";

describe("hosted GitHub observation reader mount", () => {
  test("uses one Convex service instance for append and readback", () => {
    const ledger = {
      client: {
        async query() {
          throw new Error("query is outside this composition proof");
        },
        async mutation() {
          throw new Error("mutation is outside this composition proof");
        },
      },
      serviceSecret: "private-service-secret",
      workspace: "chronicle-workspace",
    } as unknown as ConvexWorkLedger;

    const options = hostedProviderCapacityFromEnv(ledger, {
      STENSIBLY_GITHUB_WEBHOOK_SECRET: "shared-webhook-secret",
    });
    expect(options).toBeDefined();
    expect(Object.is(
      options?.repositoryObservationReader as unknown,
      options?.repositoryObservationSink as unknown,
    )).toBe(true);
    expect(options?.repositoryObservationReader).toBeDefined();
  });
});
