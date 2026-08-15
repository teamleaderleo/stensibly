import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
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
  type RunnerResumeCommandV1,
} from "../src/runner-adapter-v1.ts";
import {
  runnerAdapterCommandOutcomeSha256,
  type RunnerAdapterCommandLookup,
} from "../src/runner-adapter-command-contracts.ts";
import {
  compileRunnerResumeInspectionV1,
  renderRunnerResumeInspectionV1,
  type CompileRunnerResumeInspectionInputV1,
} from "../src/runner-resume-inspection.ts";

const adapterId = "openai-agents";
const adapterVersion = "0.14.1";
const profileId = "regular-agent";
const profileVersion = "2026-08-05";
const runId = "run_resume_inspection";
const itemId = "item_resume_inspection";
const project = "scrapbook";
const issuedAt = "2026-08-15T04:00:00.000Z";
const observedAt = "2026-08-15T04:01:00.000Z";
const checkpointCreatedAt = "2026-08-15T03:59:30.000Z";
const checkpointExternalId = "checkpoint:resume-inspection:2";
const checkpointDigest = `sha256:${"d".repeat(64)}`;
const runtimePackageId = "npm:@openai/agents-core";
const runtimePackageVersion = "0.14.1";
const checkpointSchemaVersion = "1.14";

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
    usageReferences: true,
    traceReferences: false,
  },
});

describe("runner resume inspection receipt", () => {
  test("marks one exact healthy checkpoint eligible while authorizing zero mutation", () => {
    const receipt = compileRunnerResumeInspectionV1(healthyInput());

    expect(receipt).toMatchObject({
      version: 1,
      evaluatorVersion: "0.1.0",
      decision: "eligible",
      resumeEligible: true,
      authorizesMutation: false,
      authorizesResume: false,
      run: { id: runId, generation: 3, leaseGeneration: 5 },
      adapter: { id: adapterId, version: adapterVersion, profileId, profileVersion },
      continuation: { id: "continuation-resume-inspection", generation: 2 },
      supportedActions: ["resume", "leave_paused"],
    });
    expect(receipt.checks.every((check) => check.state === "pass")).toBe(true);
    expect(receipt.receiptFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.checks)).toBe(true);

    const rendered = renderRunnerResumeInspectionV1(receipt);
    expect(rendered).toMatchObject({
      decision: "eligible",
      authorizesMutation: false,
      identity: `${runId} / run 3 / lease 5`,
      supportedActions: ["resume", "leave_paused"],
    });
    expect(rendered.sections.map((section) => section.id)).toEqual([
      "checkpoint",
      "capabilities",
      "authority",
      "settlement",
    ]);
    expect(renderRunnerResumeInspectionV1(receipt)).toEqual(rendered);
  });

  test("returns Unknown when source facts are unavailable instead of inventing eligibility", () => {
    const input = healthyInput();
    const receipt = compileRunnerResumeInspectionV1({
      ...input,
      descriptor: null,
      checkpoint: { availability: "unknown", integrity: "unknown", record: null },
      latestCheckpointGeneration: null,
      currentContinuation: null,
      checkpointToolSurface: null,
      currentCapabilityBinding: null,
      currentAuthority: null,
      grantRefs: null,
      priorCommand: null,
    });

    expect(receipt.decision).toBe("unknown");
    expect(receipt.resumeEligible).toBe(false);
    expect(receipt.supportedActions).toEqual(["leave_paused"]);
    expect(receipt.checks.some((check) => check.state === "unknown")).toBe(true);
    expect(receipt.checks.some((check) => check.state === "block")).toBe(false);
  });

  test("blocks stale checkpoint lineage and unsupported checkpoint schema", () => {
    const input = healthyInput();
    const record = input.checkpoint.record!;
    const receipt = compileRunnerResumeInspectionV1({
      ...input,
      checkpoint: {
        availability: "available",
        integrity: "verified",
        record: {
          ...record,
          runGeneration: 2,
          checkpointSchemaVersion: "0.9",
        },
      },
    });

    expect(receipt.decision).toBe("blocked");
    expect(receipt.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkpoint.lineage", state: "block" }),
      expect.objectContaining({ code: "checkpoint.runtime_schema", state: "block" }),
    ]));
  });

  test("tolerates additive capabilities and blocks loss of a checkpoint-required capability", () => {
    expect(compileRunnerResumeInspectionV1(healthyInput()).decision).toBe("eligible");

    const checkpointToolSurface = checkpointSurface([
      { class: "native_core", id: "shell" },
      { class: "configured_mcp", id: "stensibly" },
      { class: "app_connector", id: "legacy-review" },
    ], {
      app_connector: {
        executable: [{ id: "legacy-review", name: "Legacy Review" }],
      },
    });
    const receipt = compileRunnerResumeInspectionV1({
      ...healthyInput(),
      checkpointToolSurface,
    });

    expect(receipt.decision).toBe("blocked");
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      code: "capabilities.checkpoint_drift",
      state: "block",
      observed: expect.stringContaining("app_connector:legacy-review"),
    }));
  });

  test("blocks exact-expiry authority, stale grants, and revoked approvals", () => {
    const command = resumeCommand({
      authority: {
        ...resumeCommand().authority,
        expiresAt: observedAt,
      },
    });
    const receipt = compileRunnerResumeInspectionV1({
      ...healthyInput(command),
      currentAuthority: command.authority,
      grantRefs: [{
        ref: "grant:resume-inspection",
        state: "fresh",
        expiresAt: observedAt,
      }],
      requiredApprovalRefs: ["approval:tool-call-1"],
      approvalRefs: [{
        ref: "approval:tool-call-1",
        state: "revoked",
        expiresAt: null,
      }],
    });

    expect(receipt.decision).toBe("blocked");
    expect(receipt.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "authority.expiry", state: "block" }),
      expect.objectContaining({ code: "authority.grants", state: "block" }),
      expect.objectContaining({ code: "authority.approvals", state: "block" }),
    ]));
  });

  test("routes an unsettled prior command to reconciliation without granting resume", () => {
    const input = healthyInput();
    const receipt = compileRunnerResumeInspectionV1({
      ...input,
      priorCommand: {
        ...(input.priorCommand as RunnerAdapterCommandLookup),
        settlement: null,
      },
    });

    expect(receipt.decision).toBe("blocked");
    expect(receipt.resumeEligible).toBe(false);
    expect(receipt.authorizesResume).toBe(false);
    expect(receipt.supportedActions).toEqual(["reconcile", "leave_paused"]);
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      code: "settlement.prior_execution",
      state: "block",
      observed: expect.stringContaining("unsettled"),
    }));
  });

  test("blocks a second interruption that supersedes the requested checkpoint generation", () => {
    const receipt = compileRunnerResumeInspectionV1({
      ...healthyInput(),
      latestCheckpointGeneration: 3,
    });

    expect(receipt.decision).toBe("blocked");
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      code: "checkpoint.latest_generation",
      state: "block",
      observed: "3",
    }));
  });

  test("fails closed when capability inspection was bound before the resume command changed", () => {
    const original = resumeCommand();
    const input = healthyInput(original);
    const changed = resumeCommand({
      requiredCapabilities: [
        ...original.requiredCapabilities,
        { class: "app_connector", id: "github" },
      ],
    });
    const receipt = compileRunnerResumeInspectionV1({
      ...input,
      command: changed,
      currentAuthority: changed.authority,
    });

    expect(receipt.decision).toBe("blocked");
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      code: "capabilities.current_binding",
      state: "block",
    }));
  });
});

function healthyInput(
  command = resumeCommand(),
): CompileRunnerResumeInspectionInputV1 {
  return {
    command,
    descriptor,
    expectedRuntime: {
      packageId: runtimePackageId,
      packageVersion: runtimePackageVersion,
      checkpointSchemaVersion,
    },
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
        runId,
        runGeneration: command.runGeneration,
        leaseGeneration: command.leaseGeneration,
        checkpointGeneration: 2,
        externalId: checkpointExternalId,
        checkpointDigest,
        createdAt: checkpointCreatedAt,
        accessClass: "project",
      },
    },
    latestCheckpointGeneration: 2,
    currentContinuation: command.continuation,
    checkpointToolSurface: checkpointSurface(command.requiredCapabilities),
    currentCapabilityBinding: capabilityBinding(command),
    currentAuthority: command.authority,
    grantRefs: [{
      ref: "grant:resume-inspection",
      state: "fresh",
      expiresAt: "2026-08-15T05:00:00.000Z",
    }],
    requiredApprovalRefs: [],
    approvalRefs: [],
    priorCommand: settledPriorCommand(command),
    interruption: {
      code: "tool_approval_required",
      summary: "Execution paused after publishing checkpoint generation 2.",
    },
    latestEvidenceRefs: [checkpointReference()],
    observedAt,
  };
}

function resumeCommand(
  overrides: Record<string, unknown> = {},
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    version: RUNNER_ADAPTER_V1,
    kind: "resume",
    commandId: "command-resume-inspection",
    correlationId: "workflow-resume-inspection",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 3,
    leaseGeneration: 5,
    authority: {
      resource: `run:${runId}`,
      holderId: "agent:resume-inspection",
      generation: 5,
      expiresAt: "2026-08-15T05:00:00.000Z",
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Inspect one checkpoint before resume.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Inspect one checkpoint before resume.",
        summary: null,
        nextAction: "Explain exact resume eligibility.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 512,
    },
    requiredCapabilities: [
      { class: "native_core", id: "shell" },
      { class: "configured_mcp", id: "stensibly" },
    ],
    capabilityGrantRefs: ["grant:resume-inspection"],
    issuedAt,
    continuation: { id: "continuation-resume-inspection", generation: 2 },
    adapterResumeRef: null,
    checkpointRef: checkpointReference(),
    reason: "recovery",
    ...overrides,
  });
}

function checkpointReference() {
  return {
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint" as const,
    adapterId,
    externalId: checkpointExternalId,
    digest: checkpointDigest,
    uri: null,
    generation: 2,
    createdAt: checkpointCreatedAt,
    accessClass: "project" as const,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}

function capabilityBinding(command: RunnerResumeCommandV1) {
  const probe = parseRunnerCapabilityProbeV1({
    version: RUNNER_ADAPTER_V1,
    probeId: "probe-resume-inspection-current",
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: command.runGeneration,
    transport: "memory",
    transition: "resume",
    clientProduct: "resume-inspection-test",
    clientBuild: "1.0.0",
    modelProfile: "scripted-model",
    externalSurfaceRef: "surface:resume-inspection-current",
    requiredCapabilities: command.requiredCapabilities,
    recoveryActions: ["resume_with_current_tools"],
    observedAt,
    traceId: "trace-resume-inspection",
  });
  const inspection = buildRunnerCapabilityInspectionV1(
    descriptor,
    probe,
    currentClasses(),
  );
  return bindRunnerCapabilityInspectionToCommandV1(inspection, command);
}

function checkpointSurface(
  requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[],
  classOverrides: Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>> = {},
) {
  return buildEffectiveToolSurfaceSnapshot({
    snapshotId: "snapshot-resume-inspection-checkpoint",
    runnerAdapter: adapterId,
    runnerVersion: adapterVersion,
    clientProduct: "resume-inspection-test",
    clientBuild: "1.0.0",
    modelProfile: "scripted-model",
    externalSurfaceRef: checkpointExternalId,
    runId,
    runGeneration: 3,
    transport: "memory",
    transition: "resume",
    classes: {
      native_core: {
        executable: [{ id: "shell", name: "Shell" }],
      },
      configured_mcp: {
        executable: [{ id: "stensibly", name: "Stensibly" }],
      },
      app_connector: {
        executable: [],
      },
      ...classOverrides,
    },
    requiredCapabilities,
    recoveryActions: ["resume_with_current_tools"],
    observedAt: checkpointCreatedAt,
    traceId: "trace-resume-inspection-checkpoint",
  });
}

function currentClasses() {
  return {
    native_core: {
      executable: [{ id: "shell", name: "Shell" }],
    },
    configured_mcp: {
      executable: [{ id: "stensibly", name: "Stensibly" }],
    },
    app_connector: {
      executable: [{ id: "github", name: "GitHub" }],
    },
  };
}

function settledPriorCommand(command: RunnerResumeCommandV1): RunnerAdapterCommandLookup {
  const outcome = {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 6,
    observationsSha256: `sha256:${"a".repeat(64)}`,
    terminalObservationId: "observation-prior-interruption",
    terminalObservationType: "interrupted",
    latestCheckpointExternalId: checkpointExternalId,
    latestCheckpointSha256: `sha256:${"b".repeat(64)}`,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
  const commandFingerprint = sha256(stableJson({
    previous: command.commandId,
    runId: command.runId,
    checkpointExternalId,
  }));
  return {
    command: {
      project,
      itemId,
      runId: command.runId,
      runGeneration: command.runGeneration,
      leaseGeneration: command.leaseGeneration,
      actor: {
        id: "agent:resume-inspection",
        name: "Resume Inspection Agent",
        kind: "agent",
      },
      adapterId,
      profileId,
      requestFingerprint: `sha256:${"c".repeat(64)}`,
      commandId: "command-prior-interruption",
      commandFingerprint,
      idempotencyKey: "runner-host:resume-inspection-prior",
      reservedAt: "2026-08-15T03:58:00.000Z",
    },
    settlement: {
      commandId: "command-prior-interruption",
      commandFingerprint,
      outcome,
      outcomeSha256: runnerAdapterCommandOutcomeSha256(outcome),
      settledAt: "2026-08-15T04:00:30.000Z",
    },
  };
}
