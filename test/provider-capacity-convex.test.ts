import { describe, expect, test } from "bun:test";
import { ConvexProviderCapacityService } from "../src/provider-capacity-convex.ts";

describe("Convex provider capacity service", () => {
  test("uses the shared conservative projection for hosted bot observations", async () => {
    const calls: Array<{ kind: string; args: Record<string, unknown> }> = [];
    const service = new ConvexProviderCapacityService({
      client: {
        async mutation(_reference, args) {
          calls.push({ kind: "mutation", args });
          throw new Error("not used");
        },
        async query(_reference, args) {
          calls.push({ kind: "query", args });
          return {
            id: "capacity_1",
            provider: "coderabbit",
            sourceCommentId: "5104466293",
            repository: "teamleaderleo/stensibly",
            pullRequestNumber: 421,
            subjectLogin: "dependabot[bot]",
            subjectBasis: "pull_request_author_proxy",
            state: "available",
            remaining: null,
            limit: null,
            refillAt: null,
            observedAt: Date.parse("2026-07-28T13:00:00.000Z"),
            receivedAt: Date.parse("2026-07-28T13:00:01.000Z"),
          };
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
      availableFreshnessMs: 60_000,
    });

    const snapshot = await service.snapshot(
      "teamleaderleo/stensibly",
      "dependabot[bot]",
      Date.parse("2026-07-28T13:00:30.000Z"),
    );
    expect(snapshot).toMatchObject({
      state: "available",
      remaining: null,
      subjectLogin: "dependabot[bot]",
      subjectBasis: "pull_request_author_proxy",
      staleAt: "2026-07-28T13:01:00.000Z",
    });
    expect(calls[0]?.args).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      subjectLogin: "dependabot[bot]",
    });
  });
});
