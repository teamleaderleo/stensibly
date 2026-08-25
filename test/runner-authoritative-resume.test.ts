import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  buildEffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshot,
} from "../src/effective-tool-surface.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import { getContinuation, proposeContinuation, resolveContinuation } from "../src/continuations.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
  parseRunnerResumeCommandV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerCapabilityProbeV1,
  type RunnerCheckpointCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";
import {
  RunnerAuthoritativeResumeConflictError,
  RunnerAuthoritativeResumeServiceV1,
  type RunnerAuthoritativeResumeEvidenceSourceV1,
  type RunnerAuthoritativeResumeEvidenceV1,
} from "../src/runner-authoritative-resume.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { sha256, stableJson } from "../src/canonical-json.ts";

const adapterId = "model-free-resume";
const adapterVersion = "1.0.0";
const profileId = "fixture";
const profileVersion = "fixture@1";
const project = "resume_lane";
const runtimePackageId = "fixture:runner";
const runtimePackageVersion = "1.0.0";
const checkpointSchemaVersion = "1";
const runner = {
  id: "agent:juniper-resume",
  name: "Juniper Resume Fixture",
  kind: "agent" as const,
};
const supervisor = {
  id: "service:resume-supervisor",
  name: "Resume Supervisor Fixture",
  kind: "service" as const,
};

const descriptor = parseRunnerAdapterDescriptorV1({
  version: RUNNER_ADAPTER_V1,
  adapterId,
  adapterVersion,
  profiles: [{ id: profileId, version: profileVersion }],
  transports: ["memory"],
  checkpointMode: "external_reference",
  cancellationMode: "best_effort",
  supports: {
    start: true,
    resume: true,
    capabilityInspection: true,
    streamingObservations: true,
    durableReplay: true,
    usageReferences: false,
    traceReferences: false,
  },
});

describe("authoritative runner resume", () => {
  test("a real durable terminal observation settles exactly once", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:healthy");
      const preview = await fixture.service.preview(input);
      expect(preview).toMatchObject({
        decision: "eligible",
        authorizesMutation: false,
        authorizesResume: false,
      });

      const first = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const replay = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });

      expect(first.disposition).toBe("executed");
      expect(first.terminalObservation?.type).toBe("completion_proposed");
      expect(first.observationCount).toBeGreaterThan(0);
      expect(first.settlement).toMatchObject({
        commandId: first.commandId,
        outcome: {
          kind: "bounded_episode_completed",
          terminalObservationType: "completion_proposed",
          containsPrivateContent: false,
          containsCredentials: false,
        },
      });
      const detail = await fixture.ledger.getItem(fixture.itemId);
      expect(detail.events.some((event) =>
        event.type === "run.adapter.observation"
        && event.payload.commandId === first.commandId
        && event.payload.observationId === first.terminalObservation?.observationId
        && event.payload.observationType === "completion_proposed"
      )).toBe(true);
      expect(replay).toMatchObject({
        disposition: "settled_replay",
        commandId: first.commandId,
        settlement: first.settlement,
        observationCount: first.observationCount,
        observationsSha256: first.observationsSha256,
      });
      expect(fixture.adapter.resumeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("resume refuses a drifted durable profile version before adapter or reservation work", async () => {
    const fixture = await createFixture({ runnerProfileVersion: "fixture@0" });
    try {
      const input = fixture.intent("resume:version-drift");
      const staleFence = `sha256:${"0".repeat(64)}`;
      await expect(fixture.service.preview(input)).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "profile_version_mismatch",
      });
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: staleFence,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "profile_version_mismatch",
      });
      expect(fixture.adapter.inspectCalls).toBe(0);
      expect(fixture.adapter.resumeCalls).toBe(0);
      await expect(fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey }))
        .resolves.toBeNull();
    } finally {
      fixture.store.close();
    }
  });

  test("resume refuses historical unknown durable versions instead of inferring them", async () => {
    const fixture = await createFixture({ runnerProfileVersion: null });
    try {
      const input = fixture.intent("resume:version-unknown");
      const staleFence = `sha256:${"0".repeat(64)}`;
      await expect(fixture.service.preview(input)).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "profile_version_unknown",
      });
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: staleFence,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "profile_version_unknown",
      });
      expect(fixture.adapter.inspectCalls).toBe(0);
      expect(fixture.adapter.resumeCalls).toBe(0);
      const run = await fixture.ledger.getRun(fixture.runId);
      expect(run.runnerProfileVersion).toBeNull();
    } finally {
      fixture.store.close();
    }
  });

  test("missing terminal observation stays unresolved", async () => {
    const fixture = await createFixture({ omitTerminal: true });
    try {
      const input = fixture.intent("resume:no-terminal");
      const preview = await fixture.service.preview(input);
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const stored = await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey });

      expect(outcome.disposition).toBe("waiting_reconciliation");
      expect(outcome.terminalObservation).toBeNull();
      expect(outcome.settlement).toBeNull();
      expect(stored?.settlement).toBeNull();
      expect(fixture.adapter.resumeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("stale terminal-looking durable data cannot mint settlement", async () => {
    const fixture = await createFixture({ omitTerminal: true });
    try {
      await fixture.ledger.recordEvent({
        id: fixture.itemId,
        actor: runner,
        type: "run.adapter.observation",
        payload: {
          version: 1,
          observationId: "stale-terminal-looking-observation",
          observationType: "completion_proposed",
          observationFingerprint: `sha256:${"9".repeat(64)}`,
          commandId: "stale-command",
          runId: fixture.runId,
          runGeneration: 999,
          leaseGeneration: 999,
          adapterId,
          adapterVersion,
          profileId,
          profileVersion,
          observedAt: fixture.clock.toISOString(),
          referenceCount: 0,
          referencesFingerprint: sha256(stableJson([])),
          containsPrivateContent: false,
          containsCredentials: false,
        },
        idempotencyKey: "stale-terminal-looking-event",
      });
      const input = fixture.intent("resume:stale-terminal-looking");
      const preview = await fixture.service.preview(input);
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });

      expect(outcome.disposition).toBe("waiting_reconciliation");
      expect(outcome.settlement).toBeNull();
      expect((await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey }))?.settlement).toBeNull();
    } finally {
      fixture.store.close();
    }
  });

  test("settlement-only metadata cannot mint terminal replay without the durable observation", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:settlement-only");
      const preview = await fixture.service.preview(input);
      const run = await fixture.ledger.getRun(fixture.runId);
      const requestFingerprint = sha256(stableJson({
        version: 1,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
        actorId: runner.id,
        adapterId,
        profileId,
      }));
      const commandFingerprint = sha256("synthetic-settlement-only-command");
      const reservation = await fixture.ledger.reserveRunnerAdapterCommand({
        project,
        itemId: fixture.itemId,
        runId: fixture.runId,
        runGeneration: run.generation,
        leaseGeneration: run.leaseGeneration,
        actor: runner,
        adapterId,
        profileId,
        profileVersion,
        requestFingerprint,
        commandId: preview.commandId,
        commandFingerprint,
        idempotencyKey: input.idempotencyKey,
      });
      expect(reservation.dispatchAuthorized).toBe(true);
      await fixture.ledger.settleRunnerAdapterCommand({
        commandId: preview.commandId,
        commandFingerprint,
        outcome: {
          version: 1,
          kind: "bounded_episode_completed",
          observationCount: 1,
          observationsSha256: sha256("synthetic-result-only-observations"),
          terminalObservationId: `${preview.commandId}:synthetic-terminal`,
          terminalObservationType: "completion_proposed",
          latestCheckpointExternalId: null,
          latestCheckpointSha256: null,
          containsPrivateContent: false,
          containsCredentials: false,
        },
      });

      const replay = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      expect(replay.disposition).toBe("waiting_reconciliation");
      expect(replay.terminalObservation).toBeNull();
      expect(replay.settlement).toBeNull();
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("changed reuse of one resume idempotency key conflicts without redispatch", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:changed-reuse");
      const preview = await fixture.service.preview(input);
      await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: `sha256:${"f".repeat(64)}`,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "idempotency_conflict",
      });
      expect(fixture.adapter.resumeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("stale run generation blocks before adapter resume", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:stale-run");
      const preview = await fixture.service.preview(input);
      const run = await fixture.ledger.getRun(fixture.runId);
      await fixture.ledger.transitionRun({
        id: run.id,
        actor: runner,
        command: "run",
        expectedGeneration: run.generation,
        expectedLeaseGeneration: run.leaseGeneration,
        idempotencyKey: "transition:stale-run",
      });
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("expired authority blocks before adapter resume", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:expired-authority");
      const preview = await fixture.service.preview(input);
      fixture.clock.setTime(Date.parse((await fixture.ledger.getRun(fixture.runId)).leaseExpiresAt!) + 1);
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("checkpoint digest or generation change blocks before adapter resume", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:checkpoint-changed");
      const preview = await fixture.service.preview(input);
      const run = await fixture.ledger.getRun(fixture.runId);
      const changed = {
        ...fixture.checkpoint,
        digest: `sha256:${"b".repeat(64)}`,
        generation: fixture.checkpoint.generation! + 1,
      };
      await fixture.ledger.heartbeatRun({
        id: run.id,
        actor: runner,
        expectedGeneration: run.generation,
        expectedLeaseGeneration: run.leaseGeneration,
        leaseSeconds: 3600,
        checkpoint: stableJson(changed),
        idempotencyKey: "heartbeat:checkpoint-changed",
      });
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("superseded continuation blocks with zero execution", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:superseded-continuation");
      const preview = await fixture.service.preview(input);
      resolveContinuation(fixture.store, {
        id: fixture.continuationId,
        actor: supervisor,
        command: "supersede",
        expectedGeneration: fixture.continuationGeneration,
      });
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "continuation_superseded",
      });
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("missing required capability blocks before command reservation dispatch", async () => {
    const fixture = await createFixture({ missingRequiredCapability: true });
    try {
      const input = fixture.intent("resume:missing-capability");
      const preview = await fixture.service.preview(input);
      expect(preview.decision).toBe("blocked");
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "capabilities.current_required",
      });
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("changed required-capability fingerprint expires the stale client fence", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:changed-required");
      const preview = await fixture.service.preview(input);
      const changedService = fixture.makeService({
        requiredCapabilities: [
          { class: "native_core" as const, id: "shell" },
          { class: "app_connector" as const, id: "github" },
        ],
      });
      fixture.adapter.addGithub = true;
      await expect(changedService.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "stale_resume_fence",
      });
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("stale grant and approval facts fail closed", async () => {
    const fixture = await createFixture({ requiredApproval: true });
    try {
      const input = fixture.intent("resume:stale-authz");
      const preview = await fixture.service.preview(input);
      fixture.evidence.grantState = "revoked";
      fixture.evidence.approvalState = "expired";
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("unsettled prior command requires reconciliation and never resumes", async () => {
    const fixture = await createFixture({ settlePrior: false });
    try {
      const input = fixture.intent("resume:prior-unsettled");
      const preview = await fixture.service.preview(input);
      expect(preview.decision).toBe("blocked");
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("a newer settled command does not hide an older unresolved command", async () => {
    const fixture = await createFixture({ olderUnresolvedBeforeNewerSettled: true });
    try {
      const input = fixture.intent("resume:older-unresolved");
      const preview = await fixture.service.preview(input);
      expect(preview.decision).toBe("blocked");
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "settlement.prior_execution",
      });
      const older = await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: fixture.olderUnresolvedKey! });
      const newer = await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: fixture.newerSettledKey! });
      expect(older?.settlement).toBeNull();
      expect(newer?.settlement?.outcome.terminalObservationType).toBe("interrupted");
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("crash after reservation leaves an explicit reconciliation state and restart does not redispatch", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:crash-after-reserve");
      const preview = await fixture.service.preview(input);
      fixture.evidence.throwOnRead = fixture.evidence.readCount + 2;
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toMatchObject({
        reason: "evidence_unavailable",
      });
      expect(fixture.adapter.resumeCalls).toBe(0);

      const replay = await fixture.makeService().resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      expect(replay.disposition).toBe("waiting_reconciliation");
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("settled resume survives fresh service reconstruction without a second adapter call", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:fresh-host-replay");
      const preview = await fixture.service.preview(input);
      const first = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const calls = fixture.adapter.resumeCalls;
      const replay = await fixture.makeService().resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      expect(first.disposition).toBe("executed");
      expect(replay.disposition).toBe("settled_replay");
      expect(replay.settlement).toEqual(first.settlement);
      expect(fixture.adapter.resumeCalls).toBe(calls);
    } finally {
      fixture.store.close();
    }
  });

  test("successive interruptions advance checkpoint and continuation lineage and stale lineage never regains authority", async () => {
    const fixture = await createFixture({ interruptWithNewCheckpoint: true });
    try {
      const firstInput = fixture.intent("resume:interruption-one");
      const firstPreview = await fixture.service.preview(firstInput);
      const first = await fixture.service.resume({
        ...firstInput,
        expectedResumeFenceFingerprint: firstPreview.resumeFenceFingerprint,
      });
      const afterFirstRun = await fixture.ledger.getRun(fixture.runId);
      const afterFirstCheckpoint = parseRunnerExternalReferenceV1(JSON.parse(afterFirstRun.checkpoint!));
      const afterFirstContinuation = getContinuation(fixture.store, fixture.continuationId);

      expect(first.disposition).toBe("executed");
      expect(first.terminalObservation?.type).toBe("interrupted");
      expect(afterFirstCheckpoint.generation).toBe(fixture.checkpoint.generation! + 1);
      expect(afterFirstContinuation.generation).toBe(fixture.continuationGeneration + 1);

      const firstReplay = await fixture.service.resume({
        ...firstInput,
        expectedResumeFenceFingerprint: firstPreview.resumeFenceFingerprint,
      });
      expect(firstReplay.disposition).toBe("settled_replay");
      expect(getContinuation(fixture.store, fixture.continuationId).generation).toBe(fixture.continuationGeneration + 1);
      expect(fixture.adapter.resumeCalls).toBe(1);

      const secondInput = fixture.intent("resume:interruption-two");
      await expect(fixture.service.resume({
        ...secondInput,
        expectedResumeFenceFingerprint: firstPreview.resumeFenceFingerprint,
      })).rejects.toMatchObject({ reason: "stale_resume_fence" });
      expect(fixture.adapter.resumeCalls).toBe(1);

      const secondPreview = await fixture.service.preview(secondInput);
      const second = await fixture.service.resume({
        ...secondInput,
        expectedResumeFenceFingerprint: secondPreview.resumeFenceFingerprint,
      });
      const afterSecondRun = await fixture.ledger.getRun(fixture.runId);
      const afterSecondCheckpoint = parseRunnerExternalReferenceV1(JSON.parse(afterSecondRun.checkpoint!));
      const afterSecondContinuation = getContinuation(fixture.store, fixture.continuationId);

      expect(second.disposition).toBe("executed");
      expect(second.terminalObservation?.type).toBe("interrupted");
      expect(afterSecondCheckpoint.generation).toBe(afterFirstCheckpoint.generation! + 1);
      expect(afterSecondContinuation.generation).toBe(afterFirstContinuation.generation + 1);
      expect(fixture.adapter.resumeCalls).toBe(2);
    } finally {
      fixture.store.close();
    }
  });

  test("same-generation lease renewal during an admitted resume remains valid", async () => {
    const fixture = await createFixture();
    try {
      const before = await fixture.ledger.getRun(fixture.runId);
      fixture.adapter.afterResumeAccepted = async () => {
        const current = await fixture.ledger.getRun(fixture.runId);
        await fixture.ledger.heartbeatRun({
          id: current.id,
          actor: runner,
          expectedGeneration: current.generation,
          expectedLeaseGeneration: current.leaseGeneration,
          leaseSeconds: 7200,
          idempotencyKey: "renew:same-generation-in-flight",
        });
      };
      const input = fixture.intent("resume:same-generation-renewal");
      const preview = await fixture.service.preview(input);
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const after = await fixture.ledger.getRun(fixture.runId);

      expect(outcome.disposition).toBe("executed");
      expect(after.generation).toBe(before.generation);
      expect(after.leaseGeneration).toBe(before.leaseGeneration);
      expect(Date.parse(after.leaseExpiresAt!)).toBeGreaterThan(Date.parse(before.leaseExpiresAt!));
      expect(fixture.adapter.resumeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("run generation advance during an in-flight resume fences the stale effect", async () => {
    const fixture = await createFixture();
    try {
      const before = await fixture.ledger.getRun(fixture.runId);
      fixture.adapter.afterResumeAccepted = async () => {
        const current = await fixture.ledger.getRun(fixture.runId);
        await fixture.ledger.transitionRun({
          id: current.id,
          actor: runner,
          command: "run",
          expectedGeneration: current.generation,
          expectedLeaseGeneration: current.leaseGeneration,
          idempotencyKey: "advance:generation-in-flight",
        });
      };
      const input = fixture.intent("resume:generation-advance-in-flight");
      const preview = await fixture.service.preview(input);
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const after = await fixture.ledger.getRun(fixture.runId);

      expect(outcome.disposition).toBe("waiting_reconciliation");
      expect(outcome.settlement).toBeNull();
      expect(after.generation).toBe(before.generation + 1);
      expect((await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey }))?.settlement).toBeNull();
      expect(fixture.adapter.resumeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("lease expiry during an in-flight resume fences settlement", async () => {
    const fixture = await createFixture();
    try {
      fixture.adapter.afterResumeAccepted = async () => {
        const current = await fixture.ledger.getRun(fixture.runId);
        fixture.clock.setTime(Date.parse(current.leaseExpiresAt!) + 1);
      };
      const input = fixture.intent("resume:lease-expiry-in-flight");
      const preview = await fixture.service.preview(input);
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });

      expect(outcome.disposition).toBe("waiting_reconciliation");
      expect(outcome.settlement).toBeNull();
      expect((await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey }))?.settlement).toBeNull();
      expect(fixture.adapter.resumeCalls).toBe(1);
    } finally {
      fixture.store.close();
    }
  });

  test("a newer command settlement arriving during resume leaves the older command unresolved", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:newer-settlement-race");
      const preview = await fixture.service.preview(input);
      fixture.adapter.afterResumeAccepted = async () => {
        const current = await fixture.ledger.getRun(fixture.runId);
        const fingerprint = `sha256:${"7".repeat(64)}`;
        const newer = await fixture.ledger.reserveRunnerAdapterCommand({
          project,
          itemId: fixture.itemId,
          runId: fixture.runId,
          runGeneration: current.generation,
          leaseGeneration: current.leaseGeneration,
          actor: runner,
          adapterId,
          profileId,
          profileVersion,
          requestFingerprint: `sha256:${"6".repeat(64)}`,
          commandId: `newer-race-${fixture.runId}`,
          commandFingerprint: fingerprint,
          idempotencyKey: `newer-race:${fixture.runId}`,
        });
        if (newer.dispatchAuthorized) {
          await fixture.ledger.settleRunnerAdapterCommand({
            commandId: newer.command.commandId,
            commandFingerprint: fingerprint,
            outcome: priorOutcome(fixture.checkpoint, "newer-race-terminal"),
          });
        }
      };
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const older = await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: input.idempotencyKey });
      const newer = await fixture.ledger.getRunnerAdapterCommand({ idempotencyKey: `newer-race:${fixture.runId}` });

      expect(outcome.disposition).toBe("waiting_reconciliation");
      expect(older?.settlement).toBeNull();
      expect(newer?.settlement?.outcome.terminalObservationType).toBe("interrupted");
    } finally {
      fixture.store.close();
    }
  });

  test("cross-run checkpoint evidence fails closed", async () => {
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:cross-run");
      fixture.evidence.checkpointRunId = "run_other_project";
      const preview = await fixture.service.preview(input);
      expect(preview.decision).toBe("blocked");
      await expect(fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      })).rejects.toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(fixture.adapter.resumeCalls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  test("public result and durable receipts exclude raw private observations", async () => {
    const privateMarker = "PRIVATE_PROMPT_AND_TOOL_ARGUMENTS_DO_NOT_RETAIN";
    const fixture = await createFixture({ privateMarker });
    try {
      const input = fixture.intent("resume:privacy");
      const preview = await fixture.service.preview(input);
      const outcome = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const rows = fixture.store.db.query<{
        request_json: string;
        settlement_json: string | null;
      }, []>("SELECT request_json, settlement_json FROM runner_adapter_commands").all();
      const detail = await fixture.ledger.getItem(fixture.itemId);
      const publicResult = JSON.stringify(outcome);
      const retained = JSON.stringify({ rows, events: detail.events });

      expect(outcome.disposition).toBe("executed");
      expect(publicResult).not.toContain(privateMarker);
      expect(publicResult).not.toContain("private_fixture");
      expect(publicResult).not.toContain("work_step");
      expect(retained).not.toContain(privateMarker);
      expect(retained).not.toContain("toolArguments");
      expect(outcome).not.toHaveProperty("observations");
    } finally {
      fixture.store.close();
    }
  });

  test("private evidence failures use fixed non-echoing errors", async () => {
    const privateMarker = "PRIVATE_EVIDENCE_FAILURE_DO_NOT_ECHO";
    const fixture = await createFixture();
    try {
      const input = fixture.intent("resume:private-evidence-error");
      const preview = await fixture.service.preview(input);
      fixture.evidence.throwMessage = privateMarker;
      fixture.evidence.throwOnRead = fixture.evidence.readCount + 1;
      let thrown: unknown;
      try {
        await fixture.service.resume({
          ...input,
          expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RunnerAuthoritativeResumeConflictError);
      expect(String((thrown as Error).message)).not.toContain(privateMarker);
      expect(thrown).toMatchObject({ reason: "evidence_unavailable" });
    } finally {
      fixture.store.close();
    }
  });
});

class MutableEvidenceSource implements RunnerAuthoritativeResumeEvidenceSourceV1 {
  readCount = 0;
  throwOnRead: number | null = null;
  throwMessage = "simulated evidence process loss";
  grantState: "fresh" | "expired" | "revoked" | "unknown" = "fresh";
  approvalState: "fresh" | "expired" | "revoked" | "unknown" = "fresh";
  checkpointRunId: string | null = null;

  constructor(readonly requiredApproval: boolean) {}

  read(input: Parameters<RunnerAuthoritativeResumeEvidenceSourceV1["read"]>[0]): RunnerAuthoritativeResumeEvidenceV1 {
    this.readCount += 1;
    if (this.throwOnRead === this.readCount) throw new Error(this.throwMessage);
    const generation = input.checkpoint.generation!;
    return {
      checkpoint: {
        availability: "available",
        integrity: "verified",
        record: {
          version: 1,
          adapterId,
          adapterVersion,
          profileId,
          profileVersion,
          runtimePackageId,
          runtimePackageVersion,
          checkpointSchemaVersion,
          runId: this.checkpointRunId ?? input.run.id,
          runGeneration: input.run.generation,
          leaseGeneration: input.run.leaseGeneration,
          checkpointGeneration: generation,
          externalId: input.checkpoint.externalId!,
          checkpointDigest: input.checkpoint.digest!,
          createdAt: input.checkpoint.createdAt,
          accessClass: input.checkpoint.accessClass,
        },
      },
      latestCheckpointGeneration: generation,
      checkpointToolSurface: checkpointSurface(input.command, input.observedAt),
      grantRefs: input.command.capabilityGrantRefs.map((ref) => ({ ref, state: this.grantState, expiresAt: null })),
      requiredApprovalRefs: this.requiredApproval ? ["approval:resume"] : [],
      approvalRefs: this.requiredApproval
        ? [{ ref: "approval:resume", state: this.approvalState, expiresAt: null }]
        : [],
      interruption: {
        code: "fixture_interrupted",
        summary: "The prior bounded runner episode interrupted after checkpoint publication.",
      },
      latestEvidenceRefs: [input.checkpoint],
    };
  }
}

class ModelFreeResumeAdapter implements RunnerAdapterV1 {
  resumeCalls = 0;
  inspectCalls = 0;
  missingRequiredCapability = false;
  addGithub = false;
  interruptWithNewCheckpoint = false;
  omitTerminal = false;
  privateMarker: string | null = null;
  afterResumeAccepted: (() => Promise<void> | void) | null = null;
  lastSnapshot: EffectiveToolSurfaceSnapshot | null = null;

  describe() {
    return descriptor;
  }

  async inspectCapabilities(value: RunnerCapabilityProbeV1): Promise<EffectiveToolSurfaceSnapshot> {
    const probe = parseRunnerCapabilityProbeV1(value);
    this.inspectCalls += 1;
    const executable = this.missingRequiredCapability ? [] : [{ id: "shell", name: "Shell" }];
    const snapshot = buildEffectiveToolSurfaceSnapshot({
      snapshotId: probe.probeId,
      runnerAdapter: probe.adapterId,
      runnerVersion: probe.adapterVersion,
      clientProduct: probe.clientProduct,
      ...(probe.clientBuild === null ? {} : { clientBuild: probe.clientBuild }),
      ...(probe.modelProfile === null ? {} : { modelProfile: probe.modelProfile }),
      ...(probe.externalSurfaceRef === null ? {} : { externalSurfaceRef: probe.externalSurfaceRef }),
      runId: probe.runId,
      runGeneration: probe.runGeneration,
      transport: probe.transport,
      transition: probe.transition,
      classes: {
        native_core: { executable },
        app_connector: { executable: this.addGithub ? [{ id: "github", name: "GitHub" }] : [] },
      },
      requiredCapabilities: probe.requiredCapabilities,
      recoveryActions: probe.recoveryActions,
      observedAt: probe.observedAt,
      ...(probe.traceId === null ? {} : { traceId: probe.traceId }),
    });
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async *resume(value: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerResumeCommandV1(value);
    this.resumeCalls += 1;
    const snapshot = this.lastSnapshot;
    if (!snapshot) throw new Error("resume fixture requires current capability inspection");
    let sequence = 1;
    yield observation(command, "resume_accepted", sequence++);
    await this.afterResumeAccepted?.();
    yield observation(command, "execution_started", sequence++);
    yield observation(command, "tool_surface_observed", sequence++, { snapshot });
    if (this.privateMarker) {
      yield observation(command, "work_step", sequence++, {
        phase: "private_fixture",
        summary: this.privateMarker,
      });
    }
    if (this.interruptWithNewCheckpoint) {
      const current = command.checkpointRef!;
      const next = parseRunnerExternalReferenceV1({
        ...current,
        externalId: `${current.externalId}:next`,
        digest: sha256(`${current.digest}:${current.generation}:next`),
        generation: current.generation! + 1,
        createdAt: new Date(Date.parse(command.issuedAt) + 5_000).toISOString(),
      });
      yield observation(command, "checkpoint_published", sequence++, { reference: next });
      yield observation(command, "interrupted", sequence++, {
        code: "fixture_second_interruption",
        message: "The model-free resume fixture published a newer checkpoint.",
        checkpointRef: next,
        recoveryAction: "resume",
        remoteSettlementKnown: false,
      });
      return;
    }
    yield observation(command, "heartbeat", sequence++, {
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, childAgents: 0 },
      checkpointRef: command.checkpointRef,
    });
    if (this.omitTerminal) return;
    yield observation(command, "completion_proposed", sequence++, {
      outcome: "The model-free resume fixture completed.",
      executionActual: { toolCalls: 0 },
    });
  }

  async *start(_value: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1> {
    throw new Error("model-free resume fixture does not start runs");
  }

  async requestCheckpoint(_value: RunnerCheckpointCommandV1): Promise<RunnerExternalReferenceV1> {
    throw new Error("model-free resume fixture does not request checkpoints");
  }

  async requestCancellation(_value: RunnerCancellationCommandV1): Promise<RunnerCancellationObservationV1> {
    throw new Error("model-free resume fixture does not cancel runs");
  }
}

async function createFixture(options: {
  missingRequiredCapability?: boolean;
  requiredApproval?: boolean;
  settlePrior?: boolean;
  olderUnresolvedBeforeNewerSettled?: boolean;
  interruptWithNewCheckpoint?: boolean;
  omitTerminal?: boolean;
  privateMarker?: string;
  runnerProfileVersion?: string | null;
} = {}) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const clock = new Date(Date.now() + 5_000);
  const now = () => new Date(clock.getTime());
  const item = store.createItem({
    project,
    kind: "task",
    title: "Resume one interrupted model-free run",
    summary: "Prove the server-owned authoritative resume boundary.",
    nextAction: "Resume only after exact current evidence passes.",
    priority: 90,
    actor: supervisor,
  });
  const continuation = proposeContinuation(store, {
    sourceItemId: item.id,
    title: "Continue interrupted run",
    rationale: "A durable checkpoint exists.",
    instruction: "Continue only under current authority.",
    action: { kind: "resume_item", itemId: item.id },
    actor: supervisor,
    approvalMode: "automatic",
    deliveryMode: "supervisor",
  });
  const fixtureProfileVersion = options.runnerProfileVersion === undefined
    ? profileVersion
    : options.runnerProfileVersion;
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: adapterId,
    runnerProfile: profileId,
    runnerProfileVersion: fixtureProfileVersion,
    itemId: item.id,
    continuationRef: continuation.id,
    leaseSeconds: 3600,
    maxAttempts: 1,
    retryBackoffSeconds: 0,
    idempotencyKey: `dispatch:${item.id}`,
    executionEnvelope: compatibilityExecutionEnvelope("Resume one interrupted model-free run"),
  }, now());
  if (!dispatched) throw new Error("Expected one dispatched fixture run");
  const claimed = await ledger.claimRunnerWork({
    actor: runner,
    runnerType: adapterId,
    runnerProfile: profileId,
    runnerProfileVersion: fixtureProfileVersion,
    runId: dispatched.run.id,
    leaseSeconds: 3600,
    idempotencyKey: `claim:${dispatched.run.id}`,
  });
  if (!claimed) throw new Error("Expected one claimed fixture run");
  const checkpoint = parseRunnerExternalReferenceV1({
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint",
    adapterId,
    externalId: `checkpoint:${claimed.id}:2`,
    digest: `sha256:${"a".repeat(64)}`,
    uri: null,
    generation: 2,
    createdAt: new Date(clock.getTime() - 1_000).toISOString(),
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
  const run = await ledger.heartbeatRun({
    id: claimed.id,
    actor: runner,
    expectedGeneration: claimed.generation,
    expectedLeaseGeneration: claimed.leaseGeneration,
    leaseSeconds: 3600,
    checkpoint: stableJson(checkpoint),
    idempotencyKey: `checkpoint:${claimed.id}`,
  });

  let olderUnresolvedKey: string | null = null;
  let newerSettledKey: string | null = null;
  if (options.olderUnresolvedBeforeNewerSettled) {
    olderUnresolvedKey = `prior-unresolved:${run.id}`;
    await reservePrior(ledger, item.id, run, checkpoint, olderUnresolvedKey, "4", false);
    newerSettledKey = `prior-newer-settled:${run.id}`;
    await reservePrior(ledger, item.id, run, checkpoint, newerSettledKey, "5", true);
  } else {
    await reservePrior(ledger, item.id, run, checkpoint, `prior:${run.id}`, "1", options.settlePrior !== false);
  }

  const evidence = new MutableEvidenceSource(options.requiredApproval ?? false);
  const adapter = new ModelFreeResumeAdapter();
  adapter.missingRequiredCapability = options.missingRequiredCapability ?? false;
  adapter.interruptWithNewCheckpoint = options.interruptWithNewCheckpoint ?? false;
  adapter.omitTerminal = options.omitTerminal ?? false;
  adapter.privateMarker = options.privateMarker ?? null;

  const makeService = (overrides: {
    requiredCapabilities?: readonly { class: "native_core" | "app_connector"; id: string }[];
  } = {}) => new RunnerAuthoritativeResumeServiceV1({
    store,
    ledger,
    adapter,
    actor: runner,
    profileId,
    expectedRuntime: {
      packageId: runtimePackageId,
      packageVersion: runtimePackageVersion,
      checkpointSchemaVersion,
    },
    evidenceSource: evidence,
    requiredCapabilities: overrides.requiredCapabilities ?? [{ class: "native_core", id: "shell" }],
    capabilityGrantRefs: ["grant:resume"],
    transport: "memory",
    clientProduct: "model-free-resume-test",
    clientBuild: "1.0.0",
    modelProfile: "fixture-model",
    leaseSeconds: 3600,
    now,
  });
  const service = makeService();
  const intent = (idempotencyKey: string) => ({ runId: run.id, idempotencyKey });
  return {
    store,
    ledger,
    service,
    makeService,
    adapter,
    evidence,
    clock,
    checkpoint,
    itemId: item.id,
    runId: run.id,
    continuationId: continuation.id,
    continuationGeneration: continuation.generation,
    olderUnresolvedKey,
    newerSettledKey,
    intent,
  };
}

async function reservePrior(
  ledger: SqliteWorkLedger,
  itemId: string,
  run: Awaited<ReturnType<SqliteWorkLedger["getRun"]>>,
  checkpoint: RunnerExternalReferenceV1,
  idempotencyKey: string,
  digit: string,
  settle: boolean,
): Promise<void> {
  const commandFingerprint = `sha256:${digit.repeat(64)}`;
  const reservation = await ledger.reserveRunnerAdapterCommand({
    project,
    itemId,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    actor: runner,
    adapterId,
    profileId,
    profileVersion,
    requestFingerprint: `sha256:${digit === "9" ? "8".repeat(64) : digit.repeat(64)}`,
    commandId: `prior-${digit}-${run.id}`,
    commandFingerprint,
    idempotencyKey,
  });
  if (reservation.dispatchAuthorized && settle) {
    await ledger.settleRunnerAdapterCommand({
      commandId: reservation.command.commandId,
      commandFingerprint,
      outcome: priorOutcome(checkpoint, `prior-interrupted-${digit}-${run.id}`),
    });
  }
}

function priorOutcome(checkpoint: RunnerExternalReferenceV1, terminalObservationId: string) {
  return {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 1,
    observationsSha256: `sha256:${"3".repeat(64)}`,
    terminalObservationId,
    terminalObservationType: "interrupted",
    latestCheckpointExternalId: checkpoint.externalId,
    latestCheckpointSha256: sha256(stableJson(checkpoint)),
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}

function checkpointSurface(command: RunnerResumeCommandV1, observedAt: string) {
  return buildEffectiveToolSurfaceSnapshot({
    snapshotId: `checkpoint-surface-${command.runId}`,
    runnerAdapter: adapterId,
    runnerVersion: adapterVersion,
    clientProduct: "model-free-resume-test",
    clientBuild: "1.0.0",
    modelProfile: "fixture-model",
    externalSurfaceRef: command.checkpointRef?.externalId ?? undefined,
    runId: command.runId,
    runGeneration: command.runGeneration,
    transport: "memory",
    transition: "resume",
    classes: {
      native_core: { executable: [{ id: "shell", name: "Shell" }] },
      app_connector: { executable: [] },
    },
    requiredCapabilities: [{ class: "native_core", id: "shell" }],
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `checkpoint-trace-${command.runId}`,
  });
}

function observation(
  command: RunnerResumeCommandV1,
  type: RunnerObservationV1["type"],
  sequence: number,
  extra: Record<string, unknown> = {},
): RunnerObservationV1 {
  return parseRunnerObservationV1({
    version: RUNNER_ADAPTER_V1,
    type,
    observationId: `${command.commandId}:observation:${sequence}`,
    commandId: command.commandId,
    correlationId: command.correlationId,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    profileVersion: command.profileVersion,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    observedAt: new Date(Date.parse(command.issuedAt) + sequence * 1_000).toISOString(),
    references: [],
    observationAuthority: "adapter_report",
    durableTransitionApplied: false,
    ...extra,
  });
}
