import { afterEach, describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:profile-version-supervisor",
  name: "Profile Version Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:profile-version-runner",
  name: "Profile Version Runner",
  kind: "agent" as const,
};
const human = {
  id: "human:profile-version-reviewer",
  name: "Profile Version Reviewer",
  kind: "human" as const,
};
const proposer = {
  id: "agent:profile-version-proposer",
  name: "Profile Version Proposer",
  kind: "agent" as const,
};
const baseTime = new Date("2026-08-25T12:00:00.000Z");
const exactVersion = "codex-default/2026-08-25";
const stores: StensiblyStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function store() {
  const value = new StensiblyStore(":memory:");
  stores.push(value);
  return value;
}

function createItem(value: StensiblyStore, title: string) {
  return value.createItem({
    project: "profile-version-parity",
    kind: "task",
    title,
    summary: "Exercise exact and legacy-unknown runner profile provenance.",
    nextAction: "Dispatch and claim this run under the requested profile provenance.",
    priority: 80,
    actor: supervisor,
  });
}

function dispatch(
  value: StensiblyStore,
  itemId: string,
  input: { version?: string | null; key: string },
) {
  return dispatchNextWork(value, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    runnerProfileVersion: input.version,
    itemId,
    leaseSeconds: 300,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    idempotencyKey: input.key,
  }, baseTime)!;
}

describe("runner profile version local ledger parity", () => {
  test("dispatch persists exact provenance and changed-version replay conflicts", () => {
    const value = store();
    const item = createItem(value, "Persist exact dispatch provenance");
    const first = dispatch(value, item.id, {
      version: exactVersion,
      key: "dispatch-exact-profile-version",
    });
    const replay = dispatch(value, item.id, {
      version: exactVersion,
      key: "dispatch-exact-profile-version",
    });

    expect(first.run.runnerProfileVersion).toBe(exactVersion);
    expect(replay).toEqual(first);
    expect(value.db
      .query<{ runner_profile_version: string | null }, [string]>(`
        SELECT runner_profile_version
        FROM work_runs
        WHERE id = ?1
      `)
      .get(first.run.id)?.runner_profile_version).toBe(exactVersion);
    expect(value.listEvents(item.id).find((event) => event.type === "run.queued")?.payload)
      .toMatchObject({
        runnerProfile: "codex-default",
        runnerProfileVersion: exactVersion,
      });

    expect(() => dispatchNextWork(value, {
      actor: supervisor,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: "codex-default/2026-08-26",
      itemId: item.id,
      leaseSeconds: 300,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      idempotencyKey: "dispatch-exact-profile-version",
    }, baseTime)).toThrow(ConflictError);
  });

  test("claim selection isolates exact and legacy-unknown provenance in both directions", () => {
    const exactStore = store();
    const exactItem = createItem(exactStore, "Claim exact provenance");
    const exactRun = dispatch(exactStore, exactItem.id, {
      version: exactVersion,
      key: "dispatch-exact-claim",
    }).run;

    expect(claimRunnerWork(exactStore, {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: null,
      runId: exactRun.id,
    }, new Date("2026-08-25T12:00:10.000Z"))).toBeNull();
    expect(claimRunnerWork(exactStore, {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: "codex-default/2026-08-26",
      runId: exactRun.id,
    }, new Date("2026-08-25T12:00:10.000Z"))).toBeNull();
    expect(claimRunnerWork(exactStore, {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      runId: exactRun.id,
    }, new Date("2026-08-25T12:00:10.000Z"))).toMatchObject({
      id: exactRun.id,
      runnerProfileVersion: exactVersion,
      status: "starting",
    });

    const legacyStore = store();
    const legacyItem = createItem(legacyStore, "Claim legacy unknown provenance");
    const legacyRun = dispatch(legacyStore, legacyItem.id, {
      key: "dispatch-legacy-claim",
    }).run;
    expect(legacyRun.runnerProfileVersion).toBeNull();
    expect(claimRunnerWork(legacyStore, {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      runId: legacyRun.id,
    }, new Date("2026-08-25T12:00:10.000Z"))).toBeNull();
    expect(claimRunnerWork(legacyStore, {
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: null,
      runId: legacyRun.id,
    }, new Date("2026-08-25T12:00:10.000Z"))).toMatchObject({
      id: legacyRun.id,
      runnerProfileVersion: null,
      status: "starting",
    });
  });

  test("continuation profile override never inherits a version for another profile", async () => {
    const value = store();
    const ledger = new SqliteWorkLedger(value);
    const source = await ledger.createItem({
      project: "profile-version-parity",
      kind: "task",
      title: "Source continuation",
      nextAction: "Dispatch a follow-up.",
      priority: 80,
      actor: supervisor,
    });
    const inheritedTarget = await ledger.createItem({
      project: "profile-version-parity",
      kind: "task",
      title: "Inherited profile target",
      nextAction: "Use the supervisor profile.",
      priority: 70,
      actor: supervisor,
    });
    const overrideTarget = await ledger.createItem({
      project: "profile-version-parity",
      kind: "task",
      title: "Override profile target",
      nextAction: "Use a different profile.",
      priority: 60,
      actor: supervisor,
    });

    const inherited = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Keep exact profile provenance",
      rationale: "The action keeps the supervisor runner profile.",
      instruction: "Dispatch the inherited target.",
      action: { kind: "dispatch_item", itemId: inheritedTarget.id },
      actor: proposer,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });
    const inheritedResult = await ledger.queueContinuationForSupervisor({
      id: inherited.id,
      actor: human,
      supervisor,
      expectedGeneration: inherited.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      idempotencyKey: "continuation-profile-version-inherit",
    });
    expect(inheritedResult.run).toMatchObject({
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
    });

    const overridden = await ledger.proposeContinuation({
      sourceItemId: source.id,
      title: "Clear stale profile provenance",
      rationale: "The action explicitly changes the runner profile.",
      instruction: "Dispatch the override target.",
      action: {
        kind: "dispatch_item",
        itemId: overrideTarget.id,
        runnerProfile: "special-profile",
      },
      actor: proposer,
      approvalMode: "human",
      deliveryMode: "supervisor",
    });
    const overrideResult = await ledger.queueContinuationForSupervisor({
      id: overridden.id,
      actor: human,
      supervisor,
      expectedGeneration: overridden.generation,
      runnerType: "generic-mcp",
      runnerProfile: "codex-default",
      runnerProfileVersion: exactVersion,
      idempotencyKey: "continuation-profile-version-override",
    });
    expect(overrideResult.run).toMatchObject({
      runnerProfile: "special-profile",
      runnerProfileVersion: null,
    });
  });
});
