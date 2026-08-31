import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  GlaedaWorkstationAdapterV1,
  type GlaedaWorkstationClientV1,
  type PreparedGlaedaWorkstationCommandV1,
} from "../src/glaeda-workstation-adapter.ts";
import {
  fingerprintGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCommandV1,
} from "../src/glaeda-workstation-contracts.ts";
import { RunnerAdapterCommandConflictError } from "../src/runner-adapter-command-contracts.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { StensiblyStore } from "../src/store.ts";
import { SqliteWorkstationCommandLedgerV1 } from "../src/workstation-command-adapter-sqlite.ts";

const supervisor = {
  id: "service:workstation-supervisor",
  name: "Workstation supervisor",
  kind: "service" as const,
};
const runner = {
  id: "service:glaeda-workstation",
  name: "Glaeda workstation",
  kind: "service" as const,
};
const profileId = "repo-query-v1";
const profileVersion = `sha256:${"a".repeat(64)}`;
const initialNow = new Date("2026-08-31T05:00:00.000Z");

class FakeGlaedaClient implements GlaedaWorkstationClientV1 {
  checkCalls = 0;
  executeCalls = 0;
  failExecution = false;

  async check(command: GlaedaWorkstationCommandV1) {
    this.checkCalls += 1;
    return checkFor(command);
  }

  async execute(input: PreparedGlaedaWorkstationCommandV1) {
    this.executeCalls += 1;
    if (this.failExecution) throw new Error("simulated response loss after reservation");
    return {
      schema: "glaeda-workstation-receipt/v1",
      commandFingerprint: input.check.commandFingerprint,
      node: input.check.node,
      source: input.check.source,
      profile: input.check.profile,
      executionIdentityClass: input.check.executionIdentityClass,
      terminalClass: "succeeded",
      resultSha256: `sha256:${"f".repeat(64)}`,
      resultBytes: 384,
      startedAt: "2026-08-31T05:00:01.000Z",
      settledAt: "2026-08-31T05:00:02.000Z",
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    };
  }
}

describe("Stensibly-to-Glaeda exact workstation adapter", () => {
  test("reserves, executes, settles, and replays one Big Red query exactly once", async () => {
    const fixture = createFixture("big-red");
    try {
      const prepared = await fixture.adapter.prepare(fixture.command);
      const executed = await fixture.adapter.dispatch(prepared);
      expect(executed).toMatchObject({
        disposition: "executed",
        command: { node: { id: "big-red", osClass: "linux", architectureClass: "x86_64" } },
        receipt: { terminalClass: "succeeded", resultBytes: 384 },
        containsPrivateContent: false,
        containsCredentials: false,
        authorizesWork: false,
        authorizesEffects: false,
        authorizesRedispatch: false,
      });
      expect(executed.settlement?.outcome).toMatchObject({
        terminalObservationType: "glaeda_workstation_succeeded",
        latestCheckpointSha256: `sha256:${"f".repeat(64)}`,
      });

      fixture.clock.now = new Date("2026-09-01T05:00:00.000Z");
      const replay = await fixture.adapter.dispatch(prepared);
      expect(replay.disposition).toBe("settled_replay");
      expect(replay.receipt).toBeNull();
      expect(replay.settlement).toEqual(executed.settlement);
      expect(fixture.client.executeCalls).toBe(1);
      expect(commandCount(fixture.store)).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("does not blindly redispatch an ambiguously reserved command", async () => {
    const fixture = createFixture("big-red");
    try {
      const prepared = await fixture.adapter.prepare(fixture.command);
      fixture.client.failExecution = true;
      await expect(fixture.adapter.dispatch(prepared)).rejects.toThrow(/response loss/);
      fixture.client.failExecution = false;
      const replay = await fixture.adapter.dispatch(prepared);
      expect(replay.disposition).toBe("ambiguous_reserved");
      expect(replay.receipt).toBeNull();
      expect(replay.settlement).toBeNull();
      expect(fixture.client.executeCalls).toBe(1);
      expect(commandCount(fixture.store)).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("refuses a fresh reservation after exact authority expiry", async () => {
    const fixture = createFixture("big-red");
    try {
      const prepared = await fixture.adapter.prepare(fixture.command);
      fixture.clock.now = new Date("2026-09-01T05:00:00.000Z");
      await expect(fixture.adapter.dispatch(prepared)).rejects.toBeInstanceOf(
        RunnerAdapterCommandConflictError,
      );
      expect(fixture.client.executeCalls).toBe(0);
      expect(commandCount(fixture.store)).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("refuses an adapter principal that does not hold command authority", async () => {
    const fixture = createFixture("big-red");
    try {
      const other = new GlaedaWorkstationAdapterV1({
        ledger: new SqliteWorkstationCommandLedgerV1(fixture.store, () => fixture.clock.now),
        client: fixture.client,
        actor: { id: "service:other-node", name: "Other node", kind: "service" },
      });
      await expect(other.prepare(fixture.command)).rejects.toBeInstanceOf(
        RunnerAdapterCommandConflictError,
      );
      expect(fixture.client.checkCalls).toBe(0);
      expect(commandCount(fixture.store)).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("uses identical project semantics for Big Red and the opportunistic M5 Air", async () => {
    const bigRed = createFixture("big-red");
    const air = createFixture("m5-air");
    try {
      const bigResult = await bigRed.adapter.dispatch(
        await bigRed.adapter.prepare(bigRed.command),
      );
      const airResult = await air.adapter.dispatch(await air.adapter.prepare(air.command));
      expect(bigResult.command.profile).toEqual(airResult.command.profile);
      expect(bigResult.command.source).toEqual(airResult.command.source);
      expect(bigResult.command.node).toMatchObject({
        id: "big-red",
        osClass: "linux",
        architectureClass: "x86_64",
      });
      expect(airResult.command.node).toMatchObject({
        id: "m5-air",
        osClass: "macos",
        architectureClass: "arm64",
      });
      expect(bigResult.disposition).toBe("executed");
      expect(airResult.disposition).toBe("executed");
    } finally {
      bigRed.store.close();
      air.store.close();
    }
  });
});

function createFixture(nodeId: "big-red" | "m5-air") {
  const store = new StensiblyStore(":memory:");
  const item = store.createItem({
    project: "workstation",
    kind: "task",
    title: "Run one exact resident repository query",
    nextAction: "Execute repo-query/v1 on one eligible owned workstation.",
    priority: 90,
    actor: supervisor,
  });
  const dispatchId = `dispatch-glaeda-${nodeId}`;
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "glaeda-workstation",
    runnerProfile: profileId,
    runnerProfileVersion: profileVersion,
    itemId: item.id,
    leaseSeconds: 900,
    idempotencyKey: dispatchId,
  }, initialNow);
  if (!dispatched) throw new Error("Glaeda workstation fixture did not dispatch");
  const run = claimRunnerWork(store, {
    actor: runner,
    runnerType: "glaeda-workstation",
    runnerProfile: profileId,
    runnerProfileVersion: profileVersion,
    project: "workstation",
    runId: dispatched.run.id,
    leaseSeconds: 900,
    idempotencyKey: `claim-glaeda-${nodeId}`,
  }, initialNow);
  if (!run) throw new Error("Glaeda workstation fixture did not claim its run");
  const claimedItem = store.getItem(item.id);
  const clock = { now: new Date(initialNow) };
  const client = new FakeGlaedaClient();
  const adapter = new GlaedaWorkstationAdapterV1({
    ledger: new SqliteWorkstationCommandLedgerV1(store, () => clock.now),
    client,
    actor: runner,
  });
  const isBigRed = nodeId === "big-red";
  const command: GlaedaWorkstationCommandV1 = {
    version: 1,
    project: "workstation",
    itemId: item.id,
    itemClaimGeneration: claimedItem.claimGeneration,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    authority: { holderId: runner.id, expiresAt: run.leaseExpiresAt! },
    commandId: `glaeda-command-${nodeId}`,
    idempotencyKey: `glaeda-command-idempotency-${nodeId}`,
    node: {
      id: nodeId,
      generation: isBigRed ? 7 : 3,
      capabilitySnapshotSha256: `sha256:${(isBigRed ? "b" : "c").repeat(64)}`,
      osClass: isBigRed ? "linux" : "macos",
      architectureClass: isBigRed ? "x86_64" : "arm64",
      glaedaRuntimeSha256: `sha256:${"d".repeat(64)}`,
    },
    source: {
      repository: "teamleaderleo/glaeda",
      commitOid: "e".repeat(40),
      treeOid: "1".repeat(40),
      logicalChangeRef: "stensibly:change:owned-workstation",
    },
    profile: {
      id: profileId,
      versionSha256: profileVersion,
      class: "repo_query",
      resourceClass: "interactive-small",
      deadlineSeconds: 60,
    },
  };
  return { store, client, adapter, clock, command };
}

function checkFor(command: GlaedaWorkstationCommandV1) {
  return {
    schema: "glaeda-workstation-check/v1",
    commandFingerprint: fingerprintGlaedaWorkstationCommandV1(command),
    node: command.node,
    source: {
      repository: command.source.repository,
      commitOid: command.source.commitOid,
      treeOid: command.source.treeOid,
    },
    profile: {
      id: command.profile.id,
      versionSha256: command.profile.versionSha256,
      class: command.profile.class,
    },
    executionIdentityClass: "read_only_repository",
    supported: true,
    rawContentEmitted: false,
    authorizesWork: false,
    authorizesEffects: false,
  };
}

function commandCount(store: StensiblyStore): number {
  const exists = store.db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'runner_adapter_commands'
  `).get()?.count ?? 0;
  if (exists === 0) return 0;
  return store.db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM runner_adapter_commands
  `).get()?.count ?? 0;
}
