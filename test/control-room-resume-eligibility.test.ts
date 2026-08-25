import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
import {
  assembleControlRoomResumeInspectionV1,
  type ControlRoomResumeCurrentEvidenceV1,
  type ControlRoomResumeEvidenceRequestV1,
  type ControlRoomResumeEvidenceSourceV1,
} from "../src/control-room-resume-inspection.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  buildEffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceClass,
  type ToolSurfaceCapabilityRequirementInput,
  type ToolSurfaceClassInput,
} from "../src/effective-tool-surface.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  bindRunnerCapabilityInspectionToCommandV1,
  buildRunnerCapabilityInspectionV1,
} from "../src/runner-capability-binding.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerResumeCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerResumeCommandV1,
} from "../src/runner-adapter-v1.ts";
import type { RunnerAdapterCommandLookup } from "../src/runner-adapter-command-contracts.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { WorkRun } from "../src/runs.ts";

const supervisor = {
  id: "service:resume-eligibility-supervisor",
  name: "Resume Eligibility Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:resume-eligibility-runner",
  name: "Resume Eligibility Runner",
  kind: "agent" as const,
};
const adapterId = "vercel-ai-sdk";
const adapterVersion = "1.0.0";
const profileId = "default";
const profileVersion = "1.0.0";
const runtimePackageId = "npm:test-runner-runtime";
const runtimePackageVersion = "1.0.0";
const checkpointSchemaVersion = "1";
const requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[] = [
  { class: "native_core", id: "shell" },
  { class: "configured_mcp", id: "stensibly" },
];

const descriptor = parseRunnerAdapterDescriptorV1({
  version: RUNNER_ADAPTER_V1,
  adapterId,
  adapterVersion,
  profiles: [{ id: profileId, version: profileVersion }],
  transports: ["in_process"],
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

describe("Control Room authoritative resume eligibility", () => {
  test("renders an eligible compiler result from durable source plus admitted current capabilities", async () => {
    const fixture = await interruptedFixture("resume_full_eligible");
    try {
      const inspection = assembleControlRoomResumeInspectionV1(
        fixture.store,
        fixture.run.id,
        evidenceSource(fixture),
      );

      expect(inspection).toMatchObject({
        decision: "eligible",
        authorizesMutation: false,
        authorizesResume: false,
        eligibility: {
          decision: "eligible",
          resumeEligible: true,
          authorizesMutation: false,
          authorizesResume: false,
          supportedActions: ["resume", "leave_paused"],
          run: {
            id: fixture.run.id,
            generation: fixture.run.generation,
            leaseGeneration: fixture.run.leaseGeneration,
          },
        },
      });
      expect(inspection.eligibility?.sections.map((section) => section.id)).toEqual([
        "checkpoint",
        "capabilities",
        "authority",
        "settlement",
      ]);
      expect(allReasons(inspection)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint.integrity", state: "pass" }),
        expect.objectContaining({ code: "capabilities.current_required", state: "pass" }),
        expect.objectContaining({ code: "capabilities.checkpoint_drift", state: "pass" }),
        expect.objectContaining({ code: "authority.grants", state: "pass" }),
        expect.objectContaining({ code: "authority.approvals", state: "pass" }),
        expect.objectContaining({ code: "settlement.prior_execution", state: "pass" }),
      ]));
      expect(inspection.eligibility?.currentCapability).toMatchObject({
        commandFingerprint: expect.stringMatching(/^sha256:/),
        requiredFingerprint: expect.stringMatching(/^sha256:/),
        snapshotFingerprint: expect.stringMatching(/^sha256:/),
        surfaceFingerprint: expect.stringMatching(/^sha256:/),
      });
      expect(inspection.eligibility?.priorCommand).toMatchObject({
        commandId: "prior-resume-episode",
        settled: true,
        outcomeFingerprint: expect.stringMatching(/^sha256:/),
      });
      expect(Object.isFrozen(inspection.eligibility)).toBe(true);
    } finally {
      fixture.store.close();
    }
  });

  test("keeps missing current capability evidence unknown", async () => {
    const fixture = await interruptedFixture("resume_capability_unknown");
    try {
      const inspection = assembleControlRoomResumeInspectionV1(
        fixture.store,
        fixture.run.id,
        evidenceSource(fixture, { missingCapabilityBinding: true }),
      );
      expect(inspection.decision).toBe("unknown");
      expect(inspection.eligibility?.resumeEligible).toBe(false);
      expect(reason(inspection, "capabilities.current_binding")).toMatchObject({
        state: "unknown",
      });
      expect(inspection.authorizesResume).toBe(false);
    } finally {
      fixture.store.close();
    }
  });

  test("blocks lost required capability while tolerating unrelated additive capability", async () => {
    const additiveFixture = await interruptedFixture("resume_capability_additive");
    try {
      const additive = assembleControlRoomResumeInspectionV1(
        additiveFixture.store,
        additiveFixture.run.id,
        evidenceSource(additiveFixture),
      );
      expect(additive.decision).toBe("eligible");
      expect(reason(additive, "capabilities.checkpoint_drift")).toMatchObject({ state: "pass" });
    } finally {
      additiveFixture.store.close();
    }

    const lostFixture = await interruptedFixture("resume_capability_lost");
    try {
      const lost = assembleControlRoomResumeInspectionV1(
        lostFixture.store,
        lostFixture.run.id,
        evidenceSource(lostFixture, { loseRequiredCapability: true }),
      );
      expect(lost.decision).toBe("blocked");
      expect(reason(lost, "capabilities.current_required")).toMatchObject({
        state: "block",
        observed: expect.stringContaining("configured_mcp:stensibly"),
      });
      expect(lost.authorizesResume).toBe(false);
    } finally {
      lostFixture.store.close();
    }
  });

  test("routes an ambiguous prior reservation to reconciliation with zero resume authority", async () => {
    const fixture = await interruptedFixture("resume_reconcile", { settlePrior: false });
    try {
      const inspection = assembleControlRoomResumeInspectionV1(
        fixture.store,
        fixture.run.id,
        evidenceSource(fixture),
      );
      expect(inspection.decision).toBe("blocked");
      expect(inspection.eligibility?.supportedActions).toEqual(["reconcile", "leave_paused"]);
      expect(reason(inspection, "settlement.prior_execution")).toMatchObject({
        state: "block",
        observed: expect.stringContaining("unsettled"),
      });
      expect(inspection.eligibility?.resumeEligible).toBe(false);
      expect(inspection.authorizesMutation).toBe(false);
      expect(inspection.authorizesResume).toBe(false);
    } finally {
      fixture.store.close();
    }
  });

  test("names stale checkpoint/run/lease/continuation identities and authorization freshness", async () => {
    const fixture = await interruptedFixture("resume_stale_evidence", { checkpointGeneration: 3 });
    try {
      const inspection = assembleControlRoomResumeInspectionV1(
        fixture.store,
        fixture.run.id,
        evidenceSource(fixture, {
          commandCheckpointGeneration: 2,
          commandRunGeneration: fixture.run.generation + 1,
          commandLeaseGeneration: fixture.run.leaseGeneration + 1,
          currentContinuationGeneration: 3,
          staleAuthority: true,
          staleGrant: true,
          revokedApproval: true,
          integrityMismatch: true,
        }),
      );
      expect(inspection.decision).toBe("blocked");
      expect(reason(inspection, "checkpoint.integrity")).toMatchObject({ state: "block" });
      expect(reason(inspection, "checkpoint.reference_binding")).toMatchObject({ state: "block" });
      expect(reason(inspection, "checkpoint.lineage")).toMatchObject({ state: "block" });
      expect(reason(inspection, "checkpoint.latest_generation")).toMatchObject({
        state: "block",
        observed: "3",
      });
      expect(reason(inspection, "continuation.current_generation")).toMatchObject({
        state: "block",
        observed: expect.stringContaining("generation 3"),
      });
      expect(reason(inspection, "authority.current_fence")).toMatchObject({ state: "block" });
      expect(reason(inspection, "authority.expiry")).toMatchObject({ state: "block" });
      expect(reason(inspection, "authority.grants")).toMatchObject({ state: "block" });
      expect(reason(inspection, "authority.approvals")).toMatchObject({ state: "block" });
    } finally {
      fixture.store.close();
    }
  });

  test("HTTP/API put the compiler decision first and exclude private command content and controls", async () => {
    const fixture = await interruptedFixture("resume_http_eligibility");
    try {
      const app = createServerApp(fixture.store, {
        controlRoomResumeEvidenceSource: evidenceSource(fixture),
      });
      const htmlResponse = await app.request(
        `/runs/${encodeURIComponent(fixture.run.id)}/resume-inspection`,
      );
      expect(htmlResponse.status).toBe(200);
      const page = await htmlResponse.text();
      expect(page.indexOf("<strong>eligible</strong>"))
        .toBeLessThan(page.indexOf("Checkpoint integrity"));
      expect(page).toContain("authorizesMutation=false");
      expect(page).toContain("authorizesResume=false");
      expect(page).toContain("capabilities.checkpoint_drift");
      expect(page).toContain("settlement.prior_execution");
      expect(page).not.toContain("PRIVATE_PROMPT_SHOULD_NOT_RENDER");
      expect(page).not.toContain("PRIVATE_TOOL_ARGUMENT_SHOULD_NOT_RENDER");
      expect(page).not.toContain("<form");
      expect(page).not.toContain("<button");

      const apiResponse = await app.request(
        `/api/runs/${encodeURIComponent(fixture.run.id)}/resume-inspection`,
      );
      expect(apiResponse.status).toBe(200);
      const json = await apiResponse.json();
      expect(json).toMatchObject({
        inspection: {
          decision: "eligible",
          authorizesMutation: false,
          authorizesResume: false,
          eligibility: {
            decision: "eligible",
            authorizesMutation: false,
            authorizesResume: false,
          },
        },
      });
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain("PRIVATE_PROMPT_SHOULD_NOT_RENDER");
      expect(serialized).not.toContain("PRIVATE_TOOL_ARGUMENT_SHOULD_NOT_RENDER");
      expect(serialized).not.toContain("executionEnvelope");
      expect(serialized).not.toContain("tool arguments");
    } finally {
      fixture.store.close();
    }
  });

  test("does not consult the current-evidence source for the hosted backend fence", async () => {
    const fixture = await interruptedFixture("resume_hosted_source_fence");
    try {
      let calls = 0;
      const source: ControlRoomResumeEvidenceSourceV1 = () => {
        calls += 1;
        return null;
      };
      const app = createServerApp(fixture.store, {
        backend: "convex",
        controlRoomResumeEvidenceSource: source,
      });
      const response = await app.request(
        `/api/runs/${encodeURIComponent(fixture.run.id)}/resume-inspection`,
      );
      expect(response.status).toBe(404);
      expect(calls).toBe(0);
    } finally {
      fixture.store.close();
    }
  });
});

interface Fixture {
  store: StensiblyStore;
  ledger: SqliteWorkLedger;
  itemId: string;
  run: WorkRun;
  checkpoint: RunnerExternalReferenceV1;
  prior: RunnerAdapterCommandLookup;
}

interface EvidenceOptions {
  missingCapabilityBinding?: boolean;
  loseRequiredCapability?: boolean;
  commandCheckpointGeneration?: number;
  commandRunGeneration?: number;
  commandLeaseGeneration?: number;
  currentContinuationGeneration?: number;
  staleAuthority?: boolean;
  staleGrant?: boolean;
  revokedApproval?: boolean;
  integrityMismatch?: boolean;
}

async function interruptedFixture(
  project: string,
  options: { settlePrior?: boolean; checkpointGeneration?: number } = {},
): Promise<Fixture> {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project,
    kind: "task",
    title: "Explain current resume eligibility",
    priority: 80,
    actor: supervisor,
  });
  const dispatched = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId: item.id,
    leaseSeconds: 900,
    idempotencyKey: `dispatch-${project}`,
  });
  if (!dispatched) throw new Error("Resume eligibility fixture did not dispatch");
  const run = await ledger.claimRunnerWork({
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    project,
    runId: dispatched.run.id,
    leaseSeconds: 900,
    idempotencyKey: `claim-${project}`,
  });
  if (!run) throw new Error("Resume eligibility fixture was not claimed");

  const checkpointGeneration = options.checkpointGeneration ?? 2;
  const checkpoint = checkpointReference(run.id, checkpointGeneration, run.updatedAt);
  store.db.query(`
    UPDATE work_runs
    SET checkpoint = ?1, continuation_ref = ?2
    WHERE id = ?3
  `).run(JSON.stringify(checkpoint), "continuation-current", run.id);

  const reservation = await ledger.reserveRunnerAdapterCommand({
    project,
    itemId: item.id,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    actor: runner,
    adapterId,
    profileId,
    profileVersion: null,
    requestFingerprint: `sha256:${"1".repeat(64)}`,
    commandId: "prior-resume-episode",
    commandFingerprint: `sha256:${"2".repeat(64)}`,
    idempotencyKey: `prior-resume-${project}`,
  });
  if (options.settlePrior !== false) {
    await ledger.settleRunnerAdapterCommand({
      commandId: reservation.command.commandId,
      commandFingerprint: reservation.command.commandFingerprint,
      outcome: {
        version: 1,
        kind: "bounded_episode_completed",
        observationCount: 4,
        observationsSha256: `sha256:${"3".repeat(64)}`,
        terminalObservationId: "prior-interruption",
        terminalObservationType: "interrupted",
        latestCheckpointExternalId: checkpoint.externalId,
        latestCheckpointSha256: checkpoint.digest,
        containsPrivateContent: false,
        containsCredentials: false,
      },
    });
  }
  const prior = await ledger.getRunnerAdapterCommand({
    idempotencyKey: `prior-resume-${project}`,
  });
  if (!prior) throw new Error("Resume eligibility prior command is missing");
  return { store, ledger, itemId: item.id, run, checkpoint, prior };
}

function evidenceSource(
  fixture: Fixture,
  options: EvidenceOptions = {},
): ControlRoomResumeEvidenceSourceV1 {
  return (request) => buildEvidence(request, fixture, options);
}

function buildEvidence(
  request: ControlRoomResumeEvidenceRequestV1,
  fixture: Fixture,
  options: EvidenceOptions,
): ControlRoomResumeCurrentEvidenceV1 {
  if (request.run.id !== fixture.run.id || request.project !== fixture.store.getItem(fixture.itemId).project) {
    throw new Error("Control Room evidence source received the wrong durable run");
  }
  const durableCheckpoint = request.checkpoint;
  if (!durableCheckpoint) throw new Error("Control Room evidence source requires the durable checkpoint");
  const issuedAt = new Date(Date.parse(fixture.run.updatedAt) + 100).toISOString();
  const observedAt = new Date(Date.parse(issuedAt) + 1_000).toISOString();
  const commandLeaseGeneration = options.commandLeaseGeneration ?? fixture.run.leaseGeneration;
  const authority = options.staleAuthority
    ? {
      resource: `run:${fixture.run.id}` as const,
      holderId: runner.id,
      generation: commandLeaseGeneration,
      expiresAt: new Date(Date.parse(issuedAt) + 500).toISOString(),
    }
    : {
      resource: `run:${fixture.run.id}` as const,
      holderId: fixture.run.leaseOwnerId!,
      generation: commandLeaseGeneration,
      expiresAt: fixture.run.leaseExpiresAt!,
    };
  const checkpointRef = checkpointReference(
    fixture.run.id,
    options.commandCheckpointGeneration ?? durableCheckpoint.generation!,
    durableCheckpoint.createdAt,
  );
  const inspectionCandidate = resumeCommand({
    fixture,
    issuedAt,
    authority,
    checkpoint: checkpointRef,
    runGeneration: options.commandRunGeneration ?? fixture.run.generation,
    leaseGeneration: commandLeaseGeneration,
  });
  const binding = options.missingCapabilityBinding
    ? null
    : capabilityBinding(
      inspectionCandidate,
      observedAt,
      options.loseRequiredCapability,
    );
  return {
    inspectionCandidate,
    descriptor,
    expectedRuntime: {
      packageId: runtimePackageId,
      packageVersion: runtimePackageVersion,
      checkpointSchemaVersion,
    },
    checkpoint: {
      availability: "available",
      integrity: options.integrityMismatch ? "mismatch" : "verified",
      record: {
        version: 1,
        adapterId,
        adapterVersion,
        profileId,
        profileVersion,
        runtimePackageId,
        runtimePackageVersion,
        checkpointSchemaVersion,
        runId: fixture.run.id,
        runGeneration: fixture.run.generation,
        leaseGeneration: fixture.run.leaseGeneration,
        checkpointGeneration: durableCheckpoint.generation!,
        externalId: durableCheckpoint.externalId!,
        checkpointDigest: durableCheckpoint.digest!,
        createdAt: durableCheckpoint.createdAt,
        accessClass: durableCheckpoint.accessClass,
      },
    },
    currentContinuationGeneration: options.currentContinuationGeneration ?? 2,
    checkpointToolSurface: checkpointSurface(inspectionCandidate, durableCheckpoint.createdAt),
    currentCapabilityBinding: binding,
    grantRefs: [{
      ref: "grant:resume-eligibility",
      state: options.staleGrant ? "expired" : "fresh",
      expiresAt: options.staleGrant ? issuedAt : fixture.run.leaseExpiresAt,
    }],
    requiredApprovalRefs: ["approval:resume-eligibility"],
    approvalRefs: [{
      ref: "approval:resume-eligibility",
      state: options.revokedApproval ? "revoked" : "fresh",
      expiresAt: options.revokedApproval ? null : fixture.run.leaseExpiresAt,
    }],
    interruption: {
      code: "runner_interrupted",
      summary: "Prior bounded runner episode ended at the durable checkpoint.",
    },
    latestEvidenceRefs: [durableCheckpoint],
    observedAt,
  };
}

function resumeCommand(input: {
  fixture: Fixture;
  issuedAt: string;
  authority: {
    resource: `run:${string}`;
    holderId: string;
    generation: number;
    expiresAt: string;
  };
  checkpoint: RunnerExternalReferenceV1;
  runGeneration: number;
  leaseGeneration: number;
}): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    version: RUNNER_ADAPTER_V1,
    kind: "resume",
    commandId: `inspect-resume-${input.fixture.run.id}`,
    correlationId: `control-room:${input.fixture.run.id}`,
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId: input.fixture.run.id,
    runGeneration: input.runGeneration,
    leaseGeneration: input.leaseGeneration,
    authority: input.authority,
    itemId: input.fixture.itemId,
    project: input.fixture.store.getItem(input.fixture.itemId).project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "PRIVATE_PROMPT_SHOULD_NOT_RENDER",
    ),
    context: {
      version: 1,
      generatedAt: input.issuedAt,
      item: {
        id: input.fixture.itemId,
        project: input.fixture.store.getItem(input.fixture.itemId).project,
      },
      intent: {
        objective: "PRIVATE_PROMPT_SHOULD_NOT_RENDER",
        summary: null,
        nextAction: "PRIVATE_TOOL_ARGUMENT_SHOULD_NOT_RENDER",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${input.fixture.itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 256,
    },
    requiredCapabilities,
    capabilityGrantRefs: ["grant:resume-eligibility"],
    issuedAt: input.issuedAt,
    continuation: { id: "continuation-current", generation: 2 },
    adapterResumeRef: null,
    checkpointRef: input.checkpoint,
    reason: "recovery",
  });
}

function capabilityBinding(
  command: RunnerResumeCommandV1,
  observedAt: string,
  loseRequiredCapability = false,
) {
  const probe = parseRunnerCapabilityProbeV1({
    version: RUNNER_ADAPTER_V1,
    probeId: `probe-${command.runId}`,
    adapterId,
    adapterVersion,
    profileId,
    runId: command.runId,
    runGeneration: command.runGeneration,
    transport: "in_process",
    transition: "resume",
    clientProduct: "control-room-resume-test",
    clientBuild: "1.0.0",
    modelProfile: "model-free",
    externalSurfaceRef: `surface:${command.runId}`,
    requiredCapabilities: command.requiredCapabilities,
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `trace-${command.runId}`,
  });
  const inspection = buildRunnerCapabilityInspectionV1(
    descriptor,
    probe,
    currentClasses(loseRequiredCapability),
  );
  return bindRunnerCapabilityInspectionToCommandV1(inspection, command);
}

function checkpointSurface(command: RunnerResumeCommandV1, observedAt: string) {
  return buildEffectiveToolSurfaceSnapshot({
    snapshotId: `checkpoint-surface-${command.runId}`,
    runnerAdapter: adapterId,
    runnerVersion: adapterVersion,
    clientProduct: "control-room-resume-test",
    clientBuild: "1.0.0",
    modelProfile: "model-free",
    externalSurfaceRef: command.checkpointRef?.externalId ?? undefined,
    runId: command.runId,
    runGeneration: command.runGeneration,
    transport: "in_process",
    transition: "resume",
    classes: {
      native_core: { executable: [{ id: "shell", name: "Shell" }] },
      configured_mcp: { executable: [{ id: "stensibly", name: "Stensibly" }] },
      app_connector: { executable: [] },
    },
    requiredCapabilities,
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: `checkpoint-trace-${command.runId}`,
  });
}

function currentClasses(
  loseRequiredCapability: boolean,
): Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>> {
  return {
    native_core: { executable: [{ id: "shell", name: "Shell" }] },
    configured_mcp: {
      executable: loseRequiredCapability ? [] : [{ id: "stensibly", name: "Stensibly" }],
    },
    app_connector: { executable: [{ id: "github", name: "GitHub" }] },
  };
}

function checkpointReference(
  runId: string,
  generation: number,
  createdAt: string,
): RunnerExternalReferenceV1 {
  return {
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint",
    adapterId,
    externalId: `checkpoint:${runId}:${generation}`,
    digest: sha256(stableJson({ runId, generation })),
    uri: null,
    generation,
    createdAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  };
}

function allReasons(
  inspection: ReturnType<typeof assembleControlRoomResumeInspectionV1>,
) {
  return inspection.eligibility?.sections.flatMap((section) => section.reasons) ?? [];
}

function reason(
  inspection: ReturnType<typeof assembleControlRoomResumeInspectionV1>,
  code: string,
) {
  return allReasons(inspection).find((entry) => entry.code === code);
}
