import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  ConvexWorkLedger,
  type ConvexCaller,
} from "../src/convex-ledger.ts";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};

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
  test("maps the agent work and continuation contracts to scoped Convex functions", async () => {
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
    await ledger.renewClaim({
      id: "item_1",
      actor,
      leaseSeconds: 1800,
      expectedClaimGeneration: 1,
    });
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
    await ledger.releaseWork({
      id: "item_1",
      actor,
      expectedClaimGeneration: 2,
    });
    await ledger.completeWork({ id: "item_1", actor, summary: "Done." });
    await ledger.completeWorkWithContinuations({
      id: "item_1",
      actor,
      summary: "Done with a next move.",
      continuations: [{
        title: "Review the result",
        rationale: "A decision remains.",
        instruction: "Review and continue.",
        action: { kind: "request_decision", decisionType: "review" },
      }],
      idempotencyKey: "complete-continuation-1",
    });
    await ledger.proposeContinuation({
      sourceItemId: "item_1",
      title: "Review the result",
      rationale: "A decision remains.",
      instruction: "Review and continue.",
      action: { kind: "request_decision", decisionType: "review" },
      actor,
      idempotencyKey: "continuation-1",
    });
    await ledger.getContinuation("cont_1");
    await ledger.listContinuations({ sourceItemId: "item_1", status: "proposed" });
    await ledger.editContinuation({
      id: "cont_1",
      actor,
      expectedGeneration: 1,
      instruction: "Review and record the decision.",
      idempotencyKey: "continuation-edit-1",
    });
    await ledger.resolveContinuation({
      id: "cont_1",
      actor,
      command: "approve",
      expectedGeneration: 2,
      idempotencyKey: "continuation-approve-1",
    });
    await ledger.queueContinuationForSupervisor({
      id: "cont_1",
      actor,
      supervisor,
      expectedGeneration: 3,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      leaseSeconds: 900,
      idempotencyKey: "continuation-queue-1",
    });
    await ledger.runContinuationSupervisorPolicy({
      supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "scrapbook",
      limit: 8,
    });

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
      "mutation:completionContinuations:complete",
      "mutation:continuations:propose",
      "mutation:continuations:get",
      "mutation:continuations:list",
      "mutation:continuations:get",
      "mutation:continuationEdits:edit",
      "mutation:continuations:resolve",
      "mutation:continuations:get",
      "mutation:continuationSupervisor:queue",
      "mutation:continuations:list",
      "mutation:continuations:list",
      "mutation:continuationSupervisor:runPolicy",
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
    expect(client.calls[5]?.args).toMatchObject({
      id: "item_1",
      expectedClaimGeneration: 1,
    });
    expect(client.calls[11]?.args).toMatchObject({
      id: "item_1",
      expectedClaimGeneration: 2,
    });
    expect(client.calls[13]?.args).toMatchObject({
      id: "item_1",
      idempotencyKey: "complete-continuation-1",
    });
    expect(client.calls[14]?.args).toMatchObject({
      sourceItemId: "item_1",
      idempotencyKey: "continuation-1",
    });
    expect(client.calls[18]?.args).toMatchObject({
      id: "cont_1",
      instruction: "Review and record the decision.",
      idempotencyKey: "continuation-edit-1",
    });
    expect(client.calls[20]?.args).toMatchObject({ id: "cont_1" });
    expect(client.calls[21]?.args).toMatchObject({
      id: "cont_1",
      expectedGeneration: 3,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      leaseSeconds: 900,
      idempotencyKey: "continuation-queue-1",
    });
    expect(client.calls[22]?.args).toMatchObject({
      status: "proposed",
      deliveryMode: "supervisor",
    });
    expect(client.calls[23]?.args).toMatchObject({
      status: "deferred",
      deliveryMode: "supervisor",
    });
    expect(client.calls[24]?.args).toMatchObject({
      project: "scrapbook",
      limit: 8,
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
  if (name === "items:list" || name === "continuations:list") return [];
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
  if (name === "completionContinuations:complete") {
    return { item: item(), continuations: [continuation()] };
  }
  if (name === "continuationSupervisor:queue") {
    return {
      continuation: continuation(),
      item: item(),
      run: queuedRun(),
      createdItemId: null,
      notificationRecommended: false,
    };
  }
  if (name === "continuationSupervisor:runPolicy") {
    return { considered: 0, dispatched: [], skipped: [] };
  }
  if (name === "continuationEdits:edit" || name.startsWith("continuations:")) {
    return continuation();
  }
  return item();
}

function continuation() {
  const now = new Date().toISOString();
  return {
    id: "cont_1",
    sourceItemId: "item_1",
    sourceEventId: "evt_continuation",
    sourceRunId: null,
    title: "Review the result",
    rationale: "A decision remains.",
    instruction: "Review and continue.",
    action: { kind: "request_decision", decisionType: "review" },
    evidence: [],
    suggestedBy: actor.id,
    approvalMode: "human",
    deliveryMode: "human_inbox",
    status: "proposed",
    generation: 1,
    expiresAt: null,
    resolutionActorId: null,
    resolutionNote: null,
    result: null,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function queuedRun() {
  const now = new Date().toISOString();
  return {
    id: "run_1",
    itemId: "item_1",
    actorId: supervisor.id,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    externalRunId: null,
    status: "queued",
    generation: 1,
    leaseGeneration: 1,
    leaseOwnerId: supervisor.id,
    leaseExpiresAt: now,
    lastHeartbeatAt: null,
    checkpoint: null,
    outcome: null,
    continuationRef: "cont_1",
    usage: {},
    retryAttempt: 0,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
  };
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
    claimGeneration: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
