import { describe, expect, test } from "bun:test";
import type { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { hostedProviderCapacityFromEnv } from "../src/hosted-app.ts";
import type { HostedGitHubMailWebhookConsumer } from "../src/hosted-provider-capacity-api.ts";

const consumer: HostedGitHubMailWebhookConsumer = {
  async consume() {
    return { status: "ignored" } as const;
  },
};

describe("hosted GitHub mail dependency injection", () => {
  test("requires the verified GitHub webhook mount when mail is injected", () => {
    expect(() => hostedProviderCapacityFromEnv(
      fakeConvexLedger(),
      {},
      { githubMailConsumer: consumer },
    )).toThrow("Hosted GitHub mail requires STENSIBLY_GITHUB_WEBHOOK_SECRET");
  });

  test("mounts the exact supplied consumer on the existing provider route", () => {
    const options = hostedProviderCapacityFromEnv(
      fakeConvexLedger(),
      { STENSIBLY_GITHUB_WEBHOOK_SECRET: "shared-webhook-secret" },
      { githubMailConsumer: consumer },
    );
    expect(options).toBeDefined();
    expect(options?.githubMailConsumer).toBe(consumer);
  });
});

function fakeConvexLedger(): ConvexWorkLedger {
  return {
    client: {},
    serviceSecret: "private-service-secret",
    workspace: "default",
  } as unknown as ConvexWorkLedger;
}
