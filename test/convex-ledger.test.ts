import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  ConvexWorkLedger,
  type ConvexCaller,
} from "../src/convex-ledger.ts";
import { buildWorkerEnrolmentRequest } from "../src/worker-enrolment.ts";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};

type RecordedCall = {
  type: "query" | "mutation";
  name: string;
  args: Record<string, unknown>;
};

class RecordingCaller implements ConvexCaller {
  readonly calls: RecordedCall[] = [];

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "query", name, args });
    return fixture(name);
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "mutation", name, args });
    return fixture(name);
  }
}

class FailedReconciliationCaller extends RecordingCaller {
  override async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ) {
    if (getFunctionName(reference) === "runnerRuns:reconcile") {
      this.calls.push({ type: "mutation", name: "runnerRuns:reconcile", args });
      throw new Error("runner_reconciliation_incomplete");
    }
    return await super.mutation(reference, args);
  }
}

describe("Convex work ledger", () => {
  test("maps work and continuation contracts to scoped Convex functions", async () => {
    const client = new RecordingCaller();
    const ledger = new ConvexWorkLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });

    await ledger.getBrief("scrapbook", 12);
    await ledger.listWork({ project: "scrapbook", status: "ready" });
    const detail = await ledger.getItem("item_1");
    expect(detail.control.authority).toMatchObject({
      state: "unclaimed",
      generation: 0,
      source: "none",
    });
    expect(detail).toMatchObject({
      historyContractVersion: 1,
      eventsTruncated: false,
      reservations: [],
    });
    await ledger.listArtifacts("item_1");
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
      expectedClaimGeneration: 7,
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
      expectedClaimGeneration: 8,
      summary: "Mapped the calls.",
      nextAction: "Review them.",
    });
    await ledger.blockWork({
      id: "item_1",
      actor,
      expectedClaimGeneration: 9,
      reason: "Review pending.",
    });
    await ledger.unblockWork({
      id: "item_1",
      actor,
      expectedClaimGeneration: 10,
    });
    await ledger.releaseWork({
      id: "item_1",
      actor,
      expectedClaimGeneration: 11,
    });
    await ledger.completeWork({
      id: "item_1",
      actor,
      expectedClaimGeneration: 12,
      summary: "Done.",
    });
    await ledger.completeWorkWithContinuations({
      id: "item_1",
      actor,
      expectedClaimGeneration: 13,
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
    await ledger.claimRunnerWork({
      actor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      project: "scrapbook",
      leaseSeconds: 900,
      idempotencyKey: "runner-claim-1",
      concurrency: { globalLimit: 4, projectLimit: 2 },
    });
    await ledger.getRun("run_1");
    await ledger.listRuns({ itemId: "item_1", status: "running" });
    await ledger.heartbeatRun({
      id: "run_1",
      actor,
      expectedGeneration: 2,
      expectedLeaseGeneration: 2,
      leaseSeconds: 900,
      checkpoint: "Still running.",
      idempotencyKey: "runner-heartbeat-1",
    });
    await ledger.transitionRun({
      id: "run_1",
      actor,
      command: "succeed",
      expectedGeneration: 2,
      expectedLeaseGeneration: 2,
      outcome: "Done.",
      idempotencyKey: "runner-succeed-1",
    });

    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "query:projects:brief",
      "mutation:runnerRuns:reconcile",
      "query:items:list",
      "query:historyCapabilities:get",
      "query:itemControl:get",
      "query:itemReservations:list",
      "query:historyCapabilities:get",
      "query:artifacts:list",
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
      "mutation:runnerRuns:claim",
      "mutation:runnerRuns:get",
      "mutation:runnerRuns:list",
      "mutation:runnerRuns:heartbeat",
      "mutation:runnerRuns:transition",
    ]);

    for (const call of client.calls) {
      expect(call.args).toMatchObject({
        serviceSecret: "private-service-secret",
        workspace: "shared-work",
      });
    }
    const capabilityCalls = client.calls.filter((entry) =>
      entry.type === "query" && entry.name === "historyCapabilities:get"
    );
    expect(capabilityCalls).toHaveLength(2);
    for (const capabilityCall of capabilityCalls) {
      expect(capabilityCall.args).toEqual({
        serviceSecret: "private-service-secret",
        workspace: "shared-work",
      });
    }
    expect(call(client, "itemControl:get").args).toMatchObject({
      id: "item_1",
      now: expect.any(Number),
    });
    expect(client.calls.findIndex((entry) => entry.name === "runnerRuns:reconcile"))
      .toBeLessThan(client.calls.findIndex((entry) => entry.name === "items:list"));
    expect(call(client, "itemReservations:list").args).toMatchObject({
      itemId: "item_1",
      now: expect.any(Number),
    });
    expect(call(client, "claims:acquire", "mutation").args).toMatchObject({
      id: "item_1",
      leaseSeconds: 900,
      idempotencyKey: "claim-1",
    });
  });

  test("fails listWork closed before reading items when runner reconciliation fails", async () => {
    const client = new FailedReconciliationCaller();
    const ledger = new ConvexWorkLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });

    await expect(ledger.listWork({ project: "scrapbook" }))
      .rejects.toThrow("runner_reconciliation_incomplete");
    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "mutation:runnerRuns:reconcile",
    ]);
  });

  test("maps runner adapter command reservation and settlement to scoped mutations", async () => {
    const client = new RecordingCaller();
    const ledger = new ConvexWorkLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });
    const input = {
      project: "scrapbook",
      itemId: "item_1",
      runId: "run_1",
      runGeneration: 2,
      leaseGeneration: 3,
      actor,
      adapterId: "vercel-ai-sdk",
      profileId: "default",
      requestFingerprint: `sha256:${"a".repeat(64)}`,
      commandId: "command_1",
      commandFingerprint: `sha256:${"b".repeat(64)}`,
      idempotencyKey: "reserve-command-1",
    };

    await ledger.reserveRunnerAdapterCommand(input);
    const settlement = {
      commandId: input.commandId,
      commandFingerprint: input.commandFingerprint,
      outcome: {
        version: 1 as const,
        kind: "bounded_episode_completed" as const,
        observationCount: 1,
        observationsSha256: `sha256:${"c".repeat(64)}`,
        terminalObservationId: "observation_1",
        terminalObservationType: "interrupted",
        latestCheckpointExternalId: null,
        latestCheckpointSha256: null,
        containsPrivateContent: false as const,
        containsCredentials: false as const,
      },
    };
    await ledger.settleRunnerAdapterCommand(settlement);

    expect(call(client, "runnerAdapterCommands:reserve", "mutation").args).toEqual({
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
      ...input,
    });
    expect(call(client, "runnerAdapterCommands:settle", "mutation").args).toEqual({
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
      ...settlement,
    });
  });

  test("maps server-owned worker enrolment to its scoped mutation", async () => {
    const client = new RecordingCaller();
    const ledger = new ConvexWorkLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });
    const request = buildWorkerEnrolmentRequest({
      adapter: "remote-mcp",
      profile: "authenticated-generalist",
      workerSessionId: "chat.session-42",
      callsign: "Keel",
      capabilities: ["coordination"],
      projectScope: ["scrapbook"],
      startedAt: "2026-08-11T00:00:00.000Z",
      expiresAt: "2026-08-13T00:00:00.000Z",
      heartbeatSeconds: 3_600,
    });

    await ledger.enrolWorker({
      actorId: "api-token:oauth-grant-worker",
      clientId: "mcp:api-token:oauth-grant-worker",
      oauthAccountId: "acct-worker",
      request,
      idempotencyKey: `enrol_worker:v1:${"a".repeat(64)}`,
    });
    await ledger.resolveWorkerEnrolment({
      actorId: "api-token:oauth-grant-worker",
      clientId: "mcp:api-token:oauth-grant-worker",
      project: "scrapbook",
      workerRef: "wrk_worker",
    });

    expect(call(client, "workerEnrolments:enrol", "mutation").args).toEqual({
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
      actorId: "api-token:oauth-grant-worker",
      clientId: "mcp:api-token:oauth-grant-worker",
      oauthAccountId: "acct-worker",
      request,
      idempotencyKey: `enrol_worker:v1:${"a".repeat(64)}`,
    });
    expect(call(client, "workerEnrolments:resolveCurrent", "mutation").args)
      .toEqual({
        serviceSecret: "private-service-secret",
        workspace: "shared-work",
        actorId: "api-token:oauth-grant-worker",
        clientId: "mcp:api-token:oauth-grant-worker",
        project: "scrapbook",
        workerRef: "wrk_worker",
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

function call(
  client: RecordingCaller,
  name: string,
  type: RecordedCall["type"] = "query",
): RecordedCall {
  const matches = client.calls.filter((entry) => entry.type === type && entry.name === name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function fixture(name: string): unknown {
  if (name === "historyCapabilities:get") {
    return {
      version: 1,
      itemDetailVisibleEventLimit: 100,
      directVisibleEventLimit: 1_000,
      physicalEventRowLimit: 5_000,
      physicalEventByteLimit: 8 * 1024 * 1024,
      artifactLimit: 100,
      artifactOverflowCode: "history_window_overflow:artifacts",
      boundedItemControl: true,
      boundedDirectEvents: true,
      boundedArtifacts: true,
    };
  }
  if (
    name === "items:list"
    || name === "itemReservations:list"
    || name === "continuations:list"
    || name === "artifacts:list"
  ) {
    return [];
  }
  if (name === "itemControl:get") {
    return {
      historyContractVersion: 1,
      item: item(),
      control: {
        schemaVersion: 1,
        authority: {
          state: "unclaimed",
          holderActorId: null,
          generation: 0,
          expiresAt: null,
          source: "none",
          allowedOperations: ["claim", "complete", "handoff", "block"],
          approvalRequiredOperations: [],
          unavailableReasons: {},
        },
        responsibility: {
          actorId: null,
          summary: null,
          nextAction: null,
          heartbeatExpectedAt: null,
          evidenceRequired: [],
          escalationState: "none",
        },
      },
      events: [],
      eventsTruncated: false,
      artifacts: [],
      runs: [],
      dependencies: [],
    };
  }
  if (name === "projects:brief") {
    return { project: "scrapbook", counts: { total: 0 } };
  }
  if (name === "continuationSupervisor:runPolicy") {
    return { considered: 0, dispatched: [], skipped: [] };
  }
  if (name === "completionContinuations:complete") {
    return { item: item(), continuations: [continuation()] };
  }
  if (name === "continuationSupervisor:queue") {
    return {
      continuation: continuation(),
      item: item(),
      run: { id: "run_1" },
      createdItemId: null,
      notificationRecommended: false,
    };
  }
  if (name === "continuationEdits:edit" || name.startsWith("continuations:")) {
    return continuation();
  }
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
