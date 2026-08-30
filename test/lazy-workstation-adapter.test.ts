import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  LazyWorkstationAdapterV1,
  type LazyOwnerProfileClientV1,
  type PrepareLazyWorkstationCommandInputV1,
} from "../src/lazy-workstation-adapter.ts";
import { SqliteLazyWorkstationCommandLedgerV1 } from "../src/lazy-workstation-adapter-sqlite.ts";
import { RunnerAdapterCommandConflictError } from "../src/runner-adapter-command-contracts.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:lazy-supervisor",
  name: "Lazy supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:lazy-workstation",
  name: "Lazy workstation",
  kind: "agent" as const,
};
const profileSha256 = "a".repeat(64);
const sourceSha256 = "b".repeat(64);
const commandSha256 = "c".repeat(64);
const resultSha256 = "d".repeat(64);
const profileId = "stensibly-workstation-snapshot";
const profileVersion = `sha256:${profileSha256}`;
const initialNow = new Date("2026-08-31T05:00:00.000Z");

class FakeOwnerProfileClient implements LazyOwnerProfileClientV1 {
  checkCalls = 0;
  observeCalls = 0;
  failObservation = false;

  async check(input: { profileId: string }) {
    this.checkCalls += 1;
    return {
      schema: "lazy-owner-observation-check/v1",
      profileId: input.profileId,
      profileSha256,
      sourceSha256,
      commandSha256,
      observationOnly: true,
      rawContentEmitted: false,
    };
  }

  async observe() {
    this.observeCalls += 1;
    if (this.failObservation) throw new Error("simulated crash after ambiguous dispatch");
    return {
      schema: "lazy-owner-observation-receipt/v1",
      profileId,
      profileSha256,
      sourceSha256,
      commandSha256,
      resultSha256,
      resultBytes: 321,
      exitCode: 0,
      rawContentEmitted: false,
    };
  }
}

describe("Stensibly-to-Lazy exact workstation adapter", () => {
  test("executes once, returns a content-free receipt, and reuses settled replay after expiry", async () => {
    const fixture = createFixture();
    try {
      const prepared = await fixture.adapter.prepare(fixture.input);
      const executed = await fixture.adapter.dispatch(prepared);
      expect(executed).toMatchObject({
        disposition: "executed",
        itemClaimGeneration: fixture.itemClaimGeneration,
        runGeneration: fixture.runGeneration,
        leaseGeneration: fixture.leaseGeneration,
        profileVersion,
        ownerObservationReceiptSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        ownerObservationResultSha256: `sha256:${resultSha256}`,
        rawContentEmitted: false,
        containsPrivateContent: false,
        containsCredentials: false,
        authorizesWork: false,
        authorizesEffects: false,
        authorizesRedispatch: false,
      });
      fixture.clock.now = new Date("2026-08-31T06:00:00.000Z");
      const replay = await fixture.adapter.dispatch(prepared);
      expect(replay).toEqual({ ...executed, disposition: "settled_replay" });
      expect(fixture.client.checkCalls).toBe(1);
      expect(fixture.client.observeCalls).toBe(1);
      expect(fixture.store.db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM runner_adapter_commands
      `).get()?.count).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("changed stable input conflicts instead of replaying or observing again", async () => {
    const fixture = createFixture();
    try {
      const prepared = await fixture.adapter.prepare(fixture.input);
      await fixture.adapter.dispatch(prepared);
      const changed = {
        ...prepared,
        profile: {
          ...prepared.profile,
          parameters: { ...prepared.profile.parameters, project: "changed-project" },
        },
      };
      await expect(fixture.adapter.dispatch(changed)).rejects.toBeInstanceOf(
        RunnerAdapterCommandConflictError,
      );
      expect(fixture.client.observeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("stale item claim, stale run generation, and expired authority refuse before observation", async () => {
    for (const mutation of ["claim", "run", "expired"] as const) {
      const fixture = createFixture();
      try {
        const prepared = await fixture.adapter.prepare(fixture.input);
        const candidate = mutation === "claim"
          ? {
              ...prepared,
              itemClaimGeneration: prepared.itemClaimGeneration + 1,
              profile: {
                ...prepared.profile,
                parameters: {
                  ...prepared.profile.parameters,
                  "claim-generation": String(prepared.itemClaimGeneration + 1),
                },
              },
            }
          : mutation === "run"
            ? {
                ...prepared,
                runGeneration: prepared.runGeneration + 1,
                profile: {
                  ...prepared.profile,
                  parameters: {
                    ...prepared.profile.parameters,
                    "run-generation": String(prepared.runGeneration + 1),
                  },
                },
              }
            : prepared;
        if (mutation === "expired") {
          fixture.clock.now = new Date("2026-08-31T06:00:00.000Z");
        }
        await expect(fixture.adapter.dispatch(candidate)).rejects.toBeInstanceOf(
          RunnerAdapterCommandConflictError,
        );
        expect(fixture.client.observeCalls).toBe(0);
        expect(commandCount(fixture.store)).toBe(0);
      } finally {
        fixture.store.close();
      }
    }
  });

  test("an ambiguous crash strands one reservation and retry cannot redispatch", async () => {
    const fixture = createFixture();
    try {
      fixture.client.failObservation = true;
      const prepared = await fixture.adapter.prepare(fixture.input);
      await expect(fixture.adapter.dispatch(prepared)).rejects.toThrow(
        "simulated crash after ambiguous dispatch",
      );
      fixture.client.failObservation = false;
      const retry = await fixture.adapter.dispatch(prepared);
      expect(retry).toMatchObject({
        disposition: "ambiguous_reserved",
        ownerObservationReceiptSha256: null,
        ownerObservationResultSha256: null,
        settlementSha256: null,
        settledAt: null,
        authorizesRedispatch: false,
      });
      expect(fixture.client.observeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("profile-check drift is rejected before command reservation", async () => {
    const fixture = createFixture();
    try {
      await expect(fixture.adapter.prepare({
        ...fixture.input,
        profile: {
          ...fixture.input.profile,
          profileVersion: `sha256:${"e".repeat(64)}`,
          parameters: {
            ...fixture.input.profile.parameters,
            "profile-version": `sha256:${"e".repeat(64)}`,
          },
        },
      })).rejects.toBeInstanceOf(RunnerAdapterCommandConflictError);
      expect(fixture.client.observeCalls).toBe(0);
      expect(commandCount(fixture.store)).toBe(0);
    } finally {
      fixture.store.close();
    }
  });
});

function createFixture() {
  const store = new StensiblyStore(":memory:");
  const item = store.createItem({
    project: "workstation",
    kind: "task",
    title: "Observe one exact Stensibly command",
    nextAction: "Run one checked Lazy owner-profile observation.",
    priority: 90,
    actor: supervisor,
  });
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "lazy-commander",
    runnerProfile: profileId,
    runnerProfileVersion: profileVersion,
    itemId: item.id,
    leaseSeconds: 900,
    idempotencyKey: "dispatch-lazy-workstation-test",
  }, initialNow);
  if (!dispatched) throw new Error("Lazy workstation fixture did not dispatch");
  const run = claimRunnerWork(store, {
    actor: runner,
    runnerType: "lazy-commander",
    runnerProfile: profileId,
    runnerProfileVersion: profileVersion,
    project: "workstation",
    runId: dispatched.run.id,
    leaseSeconds: 900,
    idempotencyKey: "claim-lazy-workstation-test",
  }, initialNow);
  if (!run) throw new Error("Lazy workstation fixture did not claim its run");
  const claimedItem = store.getItem(item.id);
  const clock = { now: new Date(initialNow) };
  const client = new FakeOwnerProfileClient();
  const adapter = new LazyWorkstationAdapterV1({
    ledger: new SqliteLazyWorkstationCommandLedgerV1(store, () => clock.now),
    client,
    actor: runner,
  });
  const input: PrepareLazyWorkstationCommandInputV1 = {
    version: 1,
    project: "workstation",
    itemId: item.id,
    itemClaimGeneration: claimedItem.claimGeneration,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    authority: {
      holderId: runner.id,
      expiresAt: run.leaseExpiresAt!,
    },
    commandId: "lazy-command-test-1",
    idempotencyKey: "lazy-workstation-command-test-1",
    profile: {
      profileId,
      profileVersion,
      parameters: {
        database: "/tmp/stensibly-lazy-workstation-test.sqlite",
        project: "workstation",
        "item-id": item.id,
        "claim-generation": String(claimedItem.claimGeneration),
        "run-id": run.id,
        "run-generation": String(run.generation),
        "lease-generation": String(run.leaseGeneration),
        "authority-holder": runner.id,
        "authority-expires-at": run.leaseExpiresAt!,
        "command-id": "lazy-command-test-1",
        "profile-id": profileId,
        "profile-version": profileVersion,
      },
    },
  };
  return {
    store,
    client,
    adapter,
    clock,
    input,
    itemClaimGeneration: claimedItem.claimGeneration,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
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
