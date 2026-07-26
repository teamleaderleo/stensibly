import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "item-control-authority-secret";
const workspace = "test";
const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted item-control authority boundaries", () => {
  test("rejects public attempts to forge authority lifecycle events", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret,
      workspace,
      project: "scrapbook",
      kind: "task",
      title: "Reject hosted forged lifecycle evidence",
      summary: "Current context.",
      nextAction: "Keep authority internal.",
      priority: 80,
      actor: human,
    }) as any;

    for (const type of ["claim.created", "run.queued"]) {
      await expect(t.mutation(convexApi.events.record, {
        serviceSecret,
        workspace,
        id: item.id,
        actor: supervisor,
        type,
        payload: {
          generation: 1,
          runId: "run_forged",
          source: "supervisor_dispatch",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      })).rejects.toThrow("reserved for internal lifecycle writers");
    }

    const ordinary = await t.mutation(convexApi.events.record, {
      serviceSecret,
      workspace,
      id: item.id,
      actor: supervisor,
      type: "progress.recorded",
      payload: { message: "ordinary hosted evidence" },
    }) as any;
    expect(ordinary.type).toBe("progress.recorded");
  });
});
