import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexWorkLedger } from "../src/convex-ledger.ts";

const actorId = "service:supervisor";
const item = {
  id: "item_legacy",
  project: "scrapbook",
  kind: "task" as const,
  title: "Read an older hosted detail payload",
  summary: "The old deployment still owns the durable state.",
  status: "active" as const,
  priority: 70,
  nextAction: "Project control in the adapter.",
  claimedBy: actorId,
  claimExpiresAt: "2099-01-01T00:15:00.000Z",
  claimGeneration: 4,
  version: 5,
  createdAt: "2099-01-01T00:00:00.000Z",
  updatedAt: "2099-01-01T00:00:00.000Z",
};

describe("legacy hosted item control compatibility", () => {
  test("fails closed when an older hosted run cannot prove a trusted live lease", async () => {
    const calls: string[] = [];
    const ledger = new ConvexWorkLedger({
      client: {
        query: async (reference: FunctionReference<"query">) => {
          const name = getFunctionName(reference);
          calls.push(name);
          if (name === "itemControl:get") {
            throw new Error(
              "[CONVEX Q(itemControl:get)] [Request ID: legacy] Server Error Could not find public function for 'itemControl:get'.",
            );
          }
          if (name === "itemReservations:list") return [];
          if (name === "items:get") {
            return {
              item,
              events: [
                {
                  id: "evt_old_claim",
                  itemId: item.id,
                  actorId,
                  type: "claim.created",
                  payload: {
                    generation: 4,
                    source: "supervisor_dispatch",
                  },
                  createdAt: "2099-01-01T00:00:00.000Z",
                },
                {
                  id: "evt_progress",
                  itemId: item.id,
                  actorId,
                  type: "progress.recorded",
                  payload: { summary: "Still working." },
                  createdAt: "2099-01-01T00:01:00.000Z",
                },
              ],
              artifacts: [],
              runs: [{
                id: "run_legacy",
                itemId: item.id,
                actorId,
                leaseOwnerId: actorId,
                status: "running",
                leaseExpiresAt: null,
                lastHeartbeatAt: "2099-01-01T00:01:00.000Z",
              }],
              dependencies: [],
            };
          }
          throw new Error(`Unexpected query ${name}`);
        },
        mutation: async () => {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
    });

    const detail = await ledger.getItem(item.id);

    expect(calls).toEqual([
      "itemControl:get",
      "itemReservations:list",
      "items:get",
    ]);
    expect(detail.control).toMatchObject({
      schemaVersion: 1,
      authority: {
        state: "superseded",
        holderActorId: null,
        generation: 4,
        source: "none",
        allowedOperations: [],
      },
      responsibility: {
        actorId: null,
        summary: "The old deployment still owns the durable state.",
        nextAction: "Project control in the adapter.",
        heartbeatExpectedAt: null,
      },
    });
  });

  test("does not hide authentication, transport, or generic server failures", async () => {
    const calls: string[] = [];
    const ledger = new ConvexWorkLedger({
      client: {
        query: async (reference: FunctionReference<"query">) => {
          const name = getFunctionName(reference);
          calls.push(name);
          if (name === "itemReservations:list") return [];
          if (name === "itemControl:get") {
            throw new Error("Hosted backend request failed");
          }
          if (name === "items:get") {
            throw new Error("Legacy fallback must not run");
          }
          throw new Error(`Unexpected query ${name}`);
        },
        mutation: async () => {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "default",
    });

    await expect(ledger.getItem(item.id)).rejects.toThrow("Hosted backend request failed");
    expect(calls).toEqual([
      "itemControl:get",
      "itemReservations:list",
    ]);
  });
});
