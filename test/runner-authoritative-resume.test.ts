import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  buildEffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshot,
} from "../src/effective-tool-surface.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import { proposeContinuation, resolveContinuation } from "../src/continuations.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
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
  test("healthy interrupted run resumes exactly once and settles through the durable command ledger", async () => {
    const fixture = await createFixture();
    try {
      const preview = await fixture.service.preview(fixture.intent("resume:healthy"));
      expect(preview).toMatchObject({
        decision: "eligible",
        authorizesMutation: false,
        authorizesResume: false,
      });

      const first = await fixture.service.resume({
        ...fixture.intent("resume:healthy"),
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const replay = await fixture.service.resume({
        ...fixture.intent("resume:healthy"),
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });

      expect(first.disposition).toBe("executed");
      expect(first.settlement).toMatchObject({
        commandId: first.commandId,
        outcome: {
          kind: "bounded_episode_completed",
          terminalObservationType: "completion_proposed",
          containsPrivateContent: false,
          containsCredentials: false,
        },
      });
      expect(replay).toMatchObject({
        disposition: "settled_replay",
        commandId: first.commandId,
        settlement: first.settlement,
        observations: [],
      });
      expect(fixture.adapter.resumeCalls).toBe(1);
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
      })).rejects.toMatchObject({
        code: "runner_authoritative_resume_conflict",
        reason: "settlement.prior_execution",
      });
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
      })).rejects.toThrow("simulated evidence process loss");
      expect(fixture.adapter.resumeCalls).toBe(0);

      const restarted = fixture.makeService();
      const replay = await restarted.resume({
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

  test("second interruption publishes a newer checkpoint without rewriting prior continuation evidence", async () => {
    const fixture = await createFixture({ interruptWithNewCheckpoint: true });
    try {
      const input = fixture.intent("resume:second-interruption");
      const preview = await fixture.service.preview(input);
      const firstContinuation = fixture.store.db.query<{ generation: number }, [string]>(
        "SELECT generation FROM continuations WHERE id = ?1",
      ).get(fixture.continuationId)!;
      const result = await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const run = await fixture.ledger.getRun(fixture.runId);
      const checkpoint = parseRunnerExternalReferenceV1(JSON.parse(run.checkpoint!));
      const afterContinuation = fixture.store.db.query<{ generation: number }, [string]>(
        "SELECT generation FROM continuations WHERE id = ?1",
      ).get(fixture.continuationId)!;

      expect(result.settlement?.outcome.terminalObservationType).toBe("interrupted");
      expect(checkpoint.generation).toBe(fixture.checkpoint.generation! + 1);
      expect(checkpoint.externalId).not.toBe(fixture.checkpoint.externalId);
      expect(afterContinuation.generation).toBe(firstContinuation.generation);
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

  test("durable command and observation receipts exclude private checkpoint contents and credentials", async () => {
    const privateMarker = "PRIVATE_CHECKPOINT_CONTENT_DO_NOT_RETAIN";
    const credentialMarker = "github_pat_fixture_secret_do_not_retain";
    const fixture = await createFixture({ privateMarker, credentialMarker });
    try {
      const input = fixture.intent("resume:privacy");
      const preview = await fixture.service.preview(input);
      await fixture.service.resume({
        ...input,
        expectedResumeFenceFingerprint: preview.resumeFenceFingerprint,
      });
      const rows = fixture.store.db.query<{
        request_json: string;
        settlement_json: string | null;
      }, []>("SELECT request_json, settlement_json FROM runner_adapter_commands").all();
      const detail = await fixture.ledger.getItem(fixture.itemId);
      const retained = JSON.stringify({ rows, events: detail.events });
      expect(retained).not.toContain(privateMarker);
      expect(retained).not.toContain(credentialMarker);
      expect(retained).not.toContain("prompt");
      expect(retained).not.toContain("toolArguments");
    } finally {
      fixture.store.close();
    }
  });
});

class MutableEvidenceSource implements RunnerAuthoritativeResumeEvidenceSourceV1 {
  readCount = 0;
  throwOnRead: number | null = null;
  grantState: "fresh" | "expired" | "revoked" | "unknown" = "fresh";
  approvalState: "fresh" | "expired" | "revoked" | "unknown" = "fresh";
  checkpointRunId: string | null = null;
  readonly requiredApproval: boolean;

  constructor(requiredApproval: boolean) {
    this.requiredApproval = requiredApproval;
  }

  read(input: Parameters<RunnerAuthoritativeResumeEvidenceSourceV1["read"]>[0]): RunnerAuthoritativeResumeEvidenceV1 {
    this.readCount += 1;
    if (this.throwOnRead === this.readCount) {
      throw new Error("simulated evidence process loss");
    }
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
      grantRefs: input.command.capabilityGrantRefs.map((ref) => ({
        ref,
        state: this.grantState,
        expiresAt: null,
      })),
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
  privateMarker: string | null = null;
  credentialMarker: string | null = null;
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
    yield observation(command, "execution_started", sequence++);
    yield observation(command, "tool_surface_observed", sequence++, { snapshot });
    if (this.privateMarker || this.credentialMarker) {
      yield observation(command, "work_step", sequence++, {
        phase: "private_fixture",
        summary: `${this.privateMarker ?? ""} ${this.credentialMarker ?? ""}`.trim(),
      });
    }
    if (this.interruptWithNewCheckpoint) {
      const current = command.checkpointRef!;
      const next = parseRunnerExternalReferenceV1({
        ...current,
        externalId: `${current.externalId}:next`,
        digest: `sha256:${"e".repeat(64)}`,
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
      usage: {},
      checkpointRef: command.checkpointRef,
    });
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
  interruptWithNewCheckpoint?: boolean;
  privateMarker?: string;
  credentialMarker?: string;
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
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: adapterId,
    runnerProfile: profileId,
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
  const priorFingerprint = `sha256:${"1".repeat(64)}`;
  const prior = await ledger.reserveRunnerAdapterCommand({
    project,
    itemId: item.id,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    actor: runner,
    adapterId,
    profileId,
    requestFingerprint: `sha256:${"2".repeat(64)}`,
    commandId: `prior-${run.id}`,
    commandFingerprint: priorFingerprint,
    idempotencyKey: `prior:${run.id}`,
  });
  if (prior.dispatchAuthorized && options.settlePrior !== false) {
    await ledger.settleRunnerAdapterCommand({
      commandId: prior.command.commandId,
      commandFingerprint: priorFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: 1,
        observationsSha256: `sha256:${"3".repeat(64)}`,
        terminalObservationId: `prior-interrupted-${run.id}`,
        terminalObservationType: "interrupted",
        latestCheckpointExternalId: checkpoint.externalId,
        latestCheckpointSha256: sha256(stableJson(checkpoint)),
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
  }
  const evidence = new MutableEvidenceSource(options.requiredApproval ?? false);
  const adapter = new ModelFreeResumeAdapter();
  adapter.missingRequiredCapability = options.missingRequiredCapability ?? false;
  adapter.interruptWithNewCheckpoint = options.interruptWithNewCheckpoint ?? false;
  adapter.privateMarker = options.privateMarker ?? null;
  adapter.credentialMarker = options.credentialMarker ?? null;

  const makeService = (overrides: {
    requiredCapabilities?: readonly { class: "native_core" | "app_connector"; id: string }[];
  } = {}) => new RunnerAuthoritativeResumeServiceV1({
    store,
    ledger,
    adapter,
    actor: runner,
    profileId,
    expectedRuntime: { runtimePackageId, runtimePackageVersion, checkpointSchemaVersion } as any,
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
    intent,
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
