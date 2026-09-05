import { describe, expect, test } from "bun:test";
import {
  GlaedaWorkstationAdapterV1,
  type GlaedaWorkstationClientV1,
  type PreparedGlaedaWorkstationCommandV1,
} from "../src/glaeda-workstation-adapter.ts";
import {
  fingerprintGlaedaVerificationRequestV1,
  GLAEDA_VERIFY_FOCUSED_PROFILE_V1,
  GLAEDA_VERIFY_REQUIRED_PROFILE_V1,
} from "../src/glaeda-verify-focused-workstation-client.js";
import {
  fingerprintGlaedaWorkstationCommandV1,
  type GlaedaWorkstationCommandV1,
} from "../src/glaeda-workstation-contracts.js";
import { compileLocalActionVerifyCommandV1 } from "../src/local-action-verify-admission.ts";
import { RunnerAdapterCommandConflictError } from "../src/runner-adapter-command-contracts.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { StensiblyStore } from "../src/store.ts";
import { SqliteWorkstationCommandLedgerV1 } from "../src/workstation-command-adapter-sqlite.ts";

const NOW = new Date("2026-08-31T18:30:00.000Z");
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const PROFILE_GENERATION = `sha256:${"c".repeat(64)}`;

const supervisor = {
  id: "service:workstation-supervisor",
  name: "Workstation supervisor",
  kind: "service" as const,
};
const runner = {
  id: "service:big-red-glaeda",
  name: "Big Red Glaeda workstation",
  kind: "service" as const,
};

function intentInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: "stensibly",
    itemId: "item_verify_1",
    expectedClaimGeneration: 1,
    actionClass: "verify",
    source: {
      repository: "TeamLeaderLeo/Stensibly",
      baseCommit: COMMIT,
      baseTree: TREE,
      workspaceClass: "task_private",
      workspaceGeneration: "workspace:7",
      overlay: null,
    },
    command: null,
    profileId: "verify-focused/v1",
    latencyClass: "interactive",
    interferenceClass: "coexist",
    resourceProfile: "big-red-focused",
    networkClass: "none",
    deadlineSeconds: 600,
    outputLimitBytes: 64 * 1024,
    createdAt: "2026-08-31T18:00:00.000Z",
    expiresAt: "2026-08-31T19:00:00.000Z",
    ...overrides,
  };
}

function currentFacts(overrides: Record<string, unknown> = {}) {
  return {
    project: "stensibly",
    itemId: "item_verify_1",
    itemClaimGeneration: 1,
    runId: "run_verify_1",
    runGeneration: 2,
    leaseGeneration: 3,
    authority: { holderId: runner.id, expiresAt: "2026-08-31T20:00:00.000Z" },
    node: {
      id: "big-red",
      generation: 7,
      capabilitySnapshotSha256: `sha256:${"b".repeat(64)}`,
      osClass: "linux",
      architectureClass: "x86_64",
      glaedaRuntimeSha256: `sha256:${"d".repeat(64)}`,
    },
    source: {
      repository: "teamleaderleo/stensibly",
      commitOid: COMMIT,
      treeOid: TREE,
      workspaceGeneration: "workspace:7",
    },
    profileGeneration: PROFILE_GENERATION,
    ...overrides,
  };
}

function compile(overrides: { intent?: Record<string, unknown>; current?: Record<string, unknown> } = {}) {
  return compileLocalActionVerifyCommandV1({
    intent: intentInput(overrides.intent),
    current: currentFacts(overrides.current),
    now: new Date(NOW),
  });
}

describe("local verify intent admission", () => {
  test("compiles a verify-focused intent into an exact workstation command", () => {
    const command = compile();
    expect(command.project).toBe("stensibly");
    expect(command.itemId).toBe("item_verify_1");
    expect(command.itemClaimGeneration).toBe(1);
    expect(command.runId).toBe("run_verify_1");
    expect(command.profile).toEqual({
      id: "verify-focused/v1",
      versionSha256: PROFILE_GENERATION,
      class: "verify_focused",
      resourceClass: "big-red-focused",
      deadlineSeconds: 600,
    });
    expect(command.source).toEqual({
      repository: "teamleaderleo/stensibly",
      commitOid: COMMIT,
      treeOid: TREE,
      logicalChangeRef: null,
    });
    expect(command.commandId).toMatch(/^verify-[a-f0-9]{48}$/u);
    expect(command.idempotencyKey).toMatch(/^local-action-verify:[a-f0-9]{48}$/u);
    const expectedRequest = {
      version: 1,
      repository: "teamleaderleo/stensibly",
      commitOid: COMMIT,
      treeOid: TREE,
      profileVersionSha256: PROFILE_GENERATION,
      resourceClass: "big-red-focused",
      deadlineSeconds: 600,
      executionIdentityClass: "credentialless_project",
    } as const;
    expect(command.profileRequestSha256).toBe(
      fingerprintGlaedaVerificationRequestV1(expectedRequest, GLAEDA_VERIFY_FOCUSED_PROFILE_V1),
    );
    expect(Object.isFrozen(command)).toBe(true);
  });

  test("maps verify-required to its named profile", () => {
    const command = compile({
      intent: {
        profileId: "verify-required/v1",
        resourceProfile: "big-red-required",
        deadlineSeconds: 1200,
        latencyClass: "background",
        interferenceClass: "yieldable",
      },
    });
    expect(command.profile).toMatchObject({
      id: "verify-required/v1",
      class: "verify_required",
      resourceClass: "big-red-required",
      deadlineSeconds: 1200,
    });
    expect(command.profileRequestSha256).toBe(
      fingerprintGlaedaVerificationRequestV1(
        {
          version: 1,
          repository: "teamleaderleo/stensibly",
          commitOid: COMMIT,
          treeOid: TREE,
          profileVersionSha256: PROFILE_GENERATION,
          resourceClass: "big-red-required",
          deadlineSeconds: 1200,
          executionIdentityClass: "credentialless_project",
        },
        GLAEDA_VERIFY_REQUIRED_PROFILE_V1,
      ),
    );
  });

  test("exact replay compiles the identical command identity", () => {
    const first = compile();
    const second = compile();
    expect(second.commandId).toBe(first.commandId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(fingerprintGlaedaWorkstationCommandV1(second)).toBe(
      fingerprintGlaedaWorkstationCommandV1(first),
    );
    const moved = compile({ current: { runGeneration: 3 } as Record<string, unknown> });
    expect(moved.commandId).not.toBe(first.commandId);
  });

  test("refuses stale, expired, mismatched, and unsupported combinations", () => {
    expect(() => compile({ current: { itemClaimGeneration: 2 } })).toThrow(
      /stale item claim generation/u,
    );
    expect(() =>
      compile({ intent: intentInput({ expiresAt: "2026-08-31T18:29:59.999Z" }) }),
    ).toThrow(/intent is expired/u);
    expect(() =>
      compile({ current: { authority: { holderId: runner.id, expiresAt: "2026-08-31T18:29:00.000Z" } } }),
    ).toThrow(/authority lease is expired/u);
    expect(() => compile({ current: { itemId: "item_other" } })).toThrow(/intent item changed/u);
    expect(() => compile({ current: { source: { repository: "teamleaderleo/other", commitOid: COMMIT, treeOid: TREE, workspaceGeneration: "workspace:7" } } })).toThrow(
      /source repository changed/u,
    );
    expect(() => compile({ current: { source: { repository: "teamleaderleo/stensibly", commitOid: "e".repeat(40), treeOid: TREE, workspaceGeneration: "workspace:7" } } })).toThrow(
      /source commit\/tree changed/u,
    );
    expect(() => compile({ current: { source: { repository: "teamleaderleo/stensibly", commitOid: COMMIT, treeOid: TREE, workspaceGeneration: "workspace:8" } } })).toThrow(
      /workspace generation changed/u,
    );
    expect(() => compile({ intent: { profileId: "custom-verify/v9" } })).toThrow(
      /unsupported-policy profile/u,
    );
    expect(() => compile({ intent: { actionClass: "command", command: { argv: ["python3"], cwd: { kind: "workspace_root", relativePath: null }, environmentProfile: "minimal" }, profileId: null } })).toThrow(
      /only verify intents/u,
    );
    expect(() => compile({ intent: { interferenceClass: "quiet_required" } })).toThrow(
      /unsupported-policy interference/u,
    );
    expect(() => compile({ intent: { latencyClass: "measurement" } })).toThrow(
      /unsupported-policy latency/u,
    );
    expect(() => compile({ intent: { resourceProfile: "big-red-required" } })).toThrow(
      /unsupported-policy resource/u,
    );
    expect(() => compile({ intent: { deadlineSeconds: 300 } })).toThrow(
      /deadline cannot be narrower/u,
    );
    expect(() => compile({ intent: { source: { repository: "teamleaderleo/stensibly", baseCommit: COMMIT, baseTree: TREE, workspaceClass: "task_private", workspaceGeneration: "workspace:7", overlay: { format: "unified_diff_utf8", artifactRef: "artifact:x", sha256: `sha256:${"e".repeat(64)}`, bytes: 10 } } } })).toThrow(
      /cannot carry an overlay/u,
    );
  });

  test("runs the compiled command through the existing reservation path exactly once", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = store.createItem({
        project: "stensibly",
        kind: "task",
        title: "Verify one exact source tree",
        nextAction: "Run verify-focused/v1 on the admitted tree.",
        priority: 90,
        actor: supervisor,
      });
      const dispatched = dispatchNextWork(
        store,
        {
          actor: supervisor,
          runnerType: "glaeda-workstation",
          runnerProfile: "verify-focused/v1",
          runnerProfileVersion: PROFILE_GENERATION,
          itemId: item.id,
          leaseSeconds: 3600,
          idempotencyKey: "dispatch-verify-admission",
        },
        new Date("2026-08-31T18:00:00.000Z"),
      );
      if (!dispatched) throw new Error("Verify admission fixture did not dispatch");
      const claimed = claimRunnerWork(
        store,
        {
          actor: runner,
          runnerType: "glaeda-workstation",
          runnerProfile: "verify-focused/v1",
          runnerProfileVersion: PROFILE_GENERATION,
          project: "stensibly",
          runId: dispatched.run.id,
          leaseSeconds: 3600,
          idempotencyKey: "claim-verify-admission",
        },
        new Date("2026-08-31T18:00:00.000Z"),
      );
      if (!claimed) throw new Error("Verify admission fixture did not claim its run");
      const claimedItem = store.getItem(item.id);
      const clock = { now: new Date(NOW) };
      const client = new FakeVerifyClient();
      const adapter = new GlaedaWorkstationAdapterV1({
        ledger: new SqliteWorkstationCommandLedgerV1(store, () => clock.now),
        client,
        actor: runner,
      });
      const command = compileLocalActionVerifyCommandV1({
        intent: intentInput({ itemId: item.id, expectedClaimGeneration: claimedItem.claimGeneration }),
        current: currentFacts({
          itemId: item.id,
          itemClaimGeneration: claimedItem.claimGeneration,
          runId: claimed.id,
          runGeneration: claimed.generation,
          leaseGeneration: claimed.leaseGeneration,
          authority: { holderId: runner.id, expiresAt: claimed.leaseExpiresAt },
        }),
        now: new Date(NOW),
      });
      const prepared = await adapter.prepare(command);
      const executed = await adapter.dispatch(prepared);
      expect(executed.disposition).toBe("executed");
      expect(executed.receipt?.terminalClass).toBe("succeeded");
      expect(executed.authorizesWork).toBe(false);
      const replay = await adapter.dispatch(prepared);
      expect(replay.disposition).toBe("settled_replay");
      expect(client.executeCalls).toBe(1);

      const stale = () =>
        compileLocalActionVerifyCommandV1({
          intent: intentInput({ itemId: item.id, expectedClaimGeneration: claimedItem.claimGeneration }),
          current: currentFacts({
            itemId: item.id,
            itemClaimGeneration: claimedItem.claimGeneration + 1,
            runId: claimed.id,
            runGeneration: claimed.generation,
            leaseGeneration: claimed.leaseGeneration,
            authority: { holderId: runner.id, expiresAt: claimed.leaseExpiresAt },
          }),
          now: new Date(NOW),
        });
      expect(stale).toThrow(/stale item claim generation/u);

      const movedRun = compileLocalActionVerifyCommandV1({
        intent: intentInput({ itemId: item.id, expectedClaimGeneration: claimedItem.claimGeneration }),
        current: currentFacts({
          itemId: item.id,
          itemClaimGeneration: claimedItem.claimGeneration,
          runId: claimed.id,
          runGeneration: claimed.generation + 1,
          leaseGeneration: claimed.leaseGeneration,
          authority: { holderId: runner.id, expiresAt: claimed.leaseExpiresAt },
        }),
        now: new Date(NOW),
      });
      await expect(adapter.dispatch(await adapter.prepare(movedRun))).rejects.toBeInstanceOf(
        RunnerAdapterCommandConflictError,
      );
      expect(client.executeCalls).toBe(1);
    } finally {
      store.close();
    }
  });
});

class FakeVerifyClient implements GlaedaWorkstationClientV1 {
  executeCalls = 0;

  async check(command: GlaedaWorkstationCommandV1) {
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
      executionIdentityClass: "credentialless_project",
      supported: true,
      rawContentEmitted: false,
      authorizesWork: false,
      authorizesEffects: false,
    } as const;
  }

  async execute(input: PreparedGlaedaWorkstationCommandV1) {
    this.executeCalls += 1;
    return {
      schema: "glaeda-workstation-receipt/v1",
      commandFingerprint: input.check.commandFingerprint,
      node: input.check.node,
      source: input.check.source,
      profile: input.check.profile,
      executionIdentityClass: input.check.executionIdentityClass,
      terminalClass: "succeeded",
      resultSha256: `sha256:${"f".repeat(64)}`,
      resultBytes: 512,
      startedAt: "2026-08-31T18:30:01.000Z",
      settledAt: "2026-08-31T18:30:02.000Z",
      rawContentEmitted: false,
      containsPrivateContent: false,
      containsCredentials: false,
      authorizesWork: false,
      authorizesEffects: false,
      authorizesRedispatch: false,
    } as const;
  }
}
