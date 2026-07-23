import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  ConvexWorkLedger,
  type ConvexCaller,
} from "../src/convex-ledger.ts";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };

class RecordingCaller implements ConvexCaller {
  calls: Array<{
    type: "query" | "mutation";
    name: string;
    args: Record<string, unknown>;
  }> = [];

  async query(reference: FunctionReference<"query">, args: Record<string, unknown>) {
    this.calls.push({ type: "query", name: getFunctionName(reference), args });
    return fixture(getFunctionName(reference));
  }

  async mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>) {
    this.calls.push({ type: "mutation", name: getFunctionName(reference), args });
    return fixture(getFunctionName(reference));
  }
}

describe("Convex work ledger", () => {
  test("maps the agent work contract to scoped Convex functions", async () => {
    const client = new RecordingCaller();
    const ledger = new ConvexWorkLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });

    await ledger.getBrief("scrapbook", 12);
    await ledger.listWork({ project: "scrapbook", status: "ready" });
    await ledger.getItem("item_1");
    await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Map the gateway",
      priority: 60,
      actor,
      idempotencyKey: "create-1",
    });
    await ledger.claimWork({
      id: "item_1",
      actor,
      leaseSeconds: 900,
      idempotencyKey: "claim-1",
    });
    await ledger.renewClaim({ id: "item_1", actor, leaseSeconds: 1800 });
    await ledger.recordEvent({
      id: "item_1",
      actor,
      type: "progress.recorded",
      payload: { summary: "mapped" },
    });
    await ledger.attachArtifact({
      id: "item_1",
      actor,
      kind: "commit",
      label: "Gateway commit",
      uri: "git:repo@gateway",
      metadata: { sha: "gateway" },
    });
    await ledger.handoffWork({
      id: "item_1",
      actor,
      summary: "Mapped the calls.",
      nextAction: "Review them.",
    });
    await ledger.blockWork({ id: "item_1", actor, reason: "Review pending." });
    await ledger.unblockWork({ id: "item_1", actor });
    await ledger.releaseWork({ id: "item_1", actor });
    await ledger.completeWork({ id: "item_1", actor, summary: "Done." });

    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "query:projects:brief",
      "query:items:list",
      "query:items:get",
      "mutation:items:create",
      "mutation:claims:acquire",
      "mutation:claims:renew",
      "mutation:events:record",
      "mutation:artifacts:attach",
      "mutation:items:handoff",
      "mutation:items:block",
      "mutation:items:unblock",
      "mutation:claims:release",
      "mutation:items:complete",
    ]);

    for (const call of client.calls) {
      expect(call.args).toMatchObject({
        serviceSecret: "private-service-secret",
        workspace: "shared-work",
      });
    }
    expect(client.calls[0]?.args).toMatchObject({ project: "scrapbook", limit: 12 });
    expect(client.calls[4]?.args).toMatchObject({
      id: "item_1",
      leaseSeconds: 900,
      idempotencyKey: "claim-1",
    });
  });

  test("rejects incomplete or unsafe configuration", () => {
    const client = new RecordingCaller();
    expect(() => new ConvexWorkLedger({ client, serviceSecret: "" })).toThrow(
      "Convex service secret is required",
    );
    expect(() => new ConvexWorkLedger({
      client,
      serviceSecret: "secret",
      workspace: "Bad Workspace",
    })).toThrow("Workspace must be a lowercase slug");
  });
});

function fixture(name: string): unknown {
  if (name === "items:list") return [];
  if (name === "items:get") {
    return {
      item: item(),
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
    };
  }
  if (name === "artifacts:list") return [];
  if (name === "projects:brief") return { project: "scrapbook", counts: { total: 0 } };
  if (name === "events:record") {
    return {
      id: "evt_1",
      itemId: "item_1",
      actorId: actor.id,
      type: "progress.recorded",
      payload: {},
      createdAt: new Date().toISOString(),
    };
  }
  if (name === "artifacts:attach") {
    return {
      id: "art_1",
      itemId: "item_1",
      actorId: actor.id,
      kind: "commit",
      label: "Gateway commit",
      uri: "git:repo@gateway",
      mimeType: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
  }
  return item();
}

function item() {
  const now = new Date().toISOString();
  return {
    id: "item_1",
    project: "scrapbook",
    kind: "task",
    title: "Map the gateway",
    summary: null,
    status: "ready",
    priority: 60,
    nextAction: null,
    claimedBy: null,
    claimExpiresAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
