import { describe, expect, test } from "bun:test";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  bindRunnerCapabilityInspectionToCommandV1,
  buildRunnerCapabilityInspectionV1,
  requireRunnerCapabilityInspectionForCommandV1,
  type RunnerCapabilityCommandBindingV1,
  type RunnerCapabilityInspectionV1,
} from "../src/runner-capability-binding.ts";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerCapabilityProbeV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";

const adapterId = "capability-binding-adapter";
const adapterVersion = "1.0.0";
const profileId = "regular-agent";
const profileVersion = "2026-07-31";
const runId = "run_capability_binding";
const itemId = "item_capability_binding";
const project = "scrapbook";
const issuedAt = "2026-07-31T00:00:00.000Z";

const descriptor = descriptorWithResume(true);

describe("runner capability inspection binding", () => {
  test("inspects first, then binds exact start and resume commands", () => {
    const start = startCommand(startRequirements());
    const resume = resumeCommand(startRequirements());
    const startInspection = inspectionFor(start);
    const resumeInspection = inspectionFor(resume);
    const startBinding = bindRunnerCapabilityInspectionToCommandV1(
      startInspection,
      start,
    );
    const resumeBinding = bindRunnerCapabilityInspectionToCommandV1(
      resumeInspection,
      resume,
    );

    const startSnapshot = requireRunnerCapabilityInspectionForCommandV1(
      startBinding,
      structuredClone(start),
    );
    const resumeSnapshot = requireRunnerCapabilityInspectionForCommandV1(
      resumeBinding,
      structuredClone(resume),
    );

    expect(startSnapshot).toBe(startInspection.snapshot);
    expect(resumeSnapshot).toBe(resumeInspection.snapshot);
    expect(Object.isFrozen(startInspection)).toBe(true);
    expect(Object.isFrozen(startBinding)).toBe(true);
    expect(Object.isFrozen(startInspection.snapshot.classes.native_core)).toBe(true);
    expect(Object.isFrozen(startInspection.snapshot.requiredCapabilities)).toBe(true);
    expect(() => startInspection.snapshot.requiredCapabilities.push({
      class: "native_core",
      id: "other",
    })).toThrow();
  });

  test("rejects cloned inspections and bindings outside current runtime admission", () => {
    const command = startCommand(startRequirements());
    const inspection = inspectionFor(command);
    const binding = bindRunnerCapabilityInspectionToCommandV1(inspection, command);

    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      structuredClone(inspection) as RunnerCapabilityInspectionV1,
      command,
    )).toThrow("inspection must come from current runtime admission");
    expect(() => requireRunnerCapabilityInspectionForCommandV1(
      structuredClone(binding) as RunnerCapabilityCommandBindingV1,
      command,
    )).toThrow("command binding must come from current runtime admission");
  });

  test("rejects stale or capability-incompatible inspections at command claim", () => {
    const command = startCommand(startRequirements(), {
      issuedAt: "2026-07-31T00:00:00.001Z",
    });
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspectionFor(command, { observedAt: "2026-07-31T00:00:00.000Z" }),
      command,
    )).toThrow("predates command issuance");

    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      buildRunnerCapabilityInspectionV1(
        descriptor,
        probe("resume", command.requiredCapabilities),
        classes(),
      ),
      command,
    )).toThrow("transition does not match command");
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      buildRunnerCapabilityInspectionV1(
        descriptor,
        probe("new", [{ class: "native_core", id: "shell" }]),
        classes(),
      ),
      command,
    )).toThrow("required capabilities do not match command");
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      buildRunnerCapabilityInspectionV1(
        descriptor,
        probe("new", command.requiredCapabilities, { runGeneration: 2 }),
        classes(),
      ),
      command,
    )).toThrow("command run binding is invalid");
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspectionFor(command),
      startCommand(startRequirements(), { profileVersion: "2026-08-01" }),
    )).toThrow("command profile binding is invalid");
  });

  test("allows exact replay and prevents a second command from claiming one inspection", () => {
    const command = startCommand(startRequirements());
    const inspection = inspectionFor(command);
    const first = bindRunnerCapabilityInspectionToCommandV1(inspection, command);
    const replay = bindRunnerCapabilityInspectionToCommandV1(
      inspection,
      structuredClone(command),
    );

    expect(replay.commandFingerprint).toBe(first.commandFingerprint);
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspection,
      startCommand(startRequirements(), {
        commandId: "command-capability-binding-other",
      }),
    )).toThrow("already bound to a different command");
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspection,
      startCommand(startRequirements(), {
        capabilityGrantRefs: ["grant:test-capability-binding-other"],
      }),
    )).toThrow("already bound to a different command");
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspection,
      startCommand(startRequirements(), {
        leaseGeneration: 2,
        authority: {
          resource: `run:${runId}`,
          holderId: "runner-actor",
          generation: 2,
          expiresAt: "2026-07-31T01:00:00.000Z",
        },
      }),
    )).toThrow("already bound to a different command");
  });

  test("rejects changed resume continuation, checkpoint, and reason", () => {
    const command = resumeCommand(startRequirements());
    const inspection = inspectionFor(command);
    const binding = bindRunnerCapabilityInspectionToCommandV1(inspection, command);

    expectCommandDrift(binding, resumeCommand(startRequirements(), {
      continuation: { id: "continuation-capability-1", generation: 2 },
    }));
    expectCommandDrift(binding, resumeCommand(startRequirements(), {
      checkpointRef: checkpointReference(),
    }));
    expectCommandDrift(binding, resumeCommand(startRequirements(), {
      reason: "recovery",
    }));
  });

  test("requires descriptor resume support only for resume inspection", () => {
    const noResume = descriptorWithResume(false);
    const requirements = startRequirements();

    const startInspection = buildRunnerCapabilityInspectionV1(
      noResume,
      probe("new", requirements),
      classes(),
    );
    expect(startInspection.transition).toBe("new");
    expect(() => buildRunnerCapabilityInspectionV1(
      noResume,
      probe("resume", requirements),
      classes(),
    )).toThrow("does not support resume capability inspection");
  });

  test("rejects unsupported adapter, profile, transport, and transition probes", () => {
    const requirements = startRequirements();
    expect(() => buildRunnerCapabilityInspectionV1(
      descriptor,
      probe("new", requirements, { adapterVersion: "2.0.0" }),
      classes(),
    )).toThrow("probe adapter binding is invalid");
    expect(() => buildRunnerCapabilityInspectionV1(
      descriptor,
      probe("new", requirements, { profileId: "other-profile" }),
      classes(),
    )).toThrow("probe profile is unsupported");
    expect(() => buildRunnerCapabilityInspectionV1(
      descriptor,
      probe("new", requirements, { transport: "stdio" }),
      classes(),
    )).toThrow("probe transport is unsupported");
    expect(() => buildRunnerCapabilityInspectionV1(
      descriptor,
      parseRunnerCapabilityProbeV1({
        ...probe("new", requirements),
        transition: "reconnect",
      }),
      classes(),
    )).toThrow("supports only new and resume transitions");
  });

  test("rejects own and inherited kind accessors without invoking them", () => {
    const command = startCommand(startRequirements());
    const inspection = inspectionFor(command);
    let ownReads = 0;
    const ownAccessor = structuredClone(command) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(ownAccessor, "kind", {
      configurable: true,
      enumerable: true,
      get() {
        ownReads += 1;
        return "start";
      },
    });

    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspection,
      ownAccessor as unknown as RunnerStartCommandV1,
    )).toThrow();
    expect(ownReads).toBe(0);

    let inheritedReads = 0;
    const prototype = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(prototype, "kind", {
      configurable: true,
      enumerable: true,
      get() {
        inheritedReads += 1;
        return "start";
      },
    });
    const inheritedAccessor = Object.create(prototype) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(command)) {
      if (key === "kind") continue;
      Object.defineProperty(
        inheritedAccessor,
        key,
        Object.getOwnPropertyDescriptor(command, key)!,
      );
    }

    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspectionFor(command),
      inheritedAccessor as unknown as RunnerStartCommandV1,
    )).toThrow();
    expect(inheritedReads).toBe(0);
  });

  test("rejects symbol and hidden command decoration during re-admission", () => {
    const command = startCommand(startRequirements());
    const symbolDecorated = structuredClone(command) as unknown as Record<PropertyKey, unknown>;
    symbolDecorated[Symbol("decoration")] = "unexpected";
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspectionFor(command),
      symbolDecorated as unknown as RunnerStartCommandV1,
    )).toThrow();

    const hiddenDecorated = structuredClone(command) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hiddenDecorated, "hiddenDecoration", {
      configurable: true,
      enumerable: false,
      value: "unexpected",
      writable: true,
    });
    expect(() => bindRunnerCapabilityInspectionToCommandV1(
      inspectionFor(command),
      hiddenDecorated as unknown as RunnerStartCommandV1,
    )).toThrow();
  });

  test("preserves exact inspection, command, and snapshot identities", () => {
    const command = startCommand(startRequirements());
    const inspection = inspectionFor(command);
    const binding = bindRunnerCapabilityInspectionToCommandV1(inspection, command);

    expect(inspection).toMatchObject({
      version: 1,
      adapterId,
      adapterVersion,
      profileId,
      profileVersion,
      probeId: "probe-capability-new",
      transport: "memory",
      transition: "new",
      runId,
      runGeneration: 1,
      observedAt: "2026-07-31T00:00:01.000Z",
    });
    expect(binding).toMatchObject({
      version: 1,
      commandId: command.commandId,
      issuedAt: command.issuedAt,
      inspection,
    });
    expect(binding.commandFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(inspection.requiredFingerprint).toBe(
      inspection.snapshot.requiredFingerprint,
    );
    expect(inspection.snapshotFingerprint).toBe(
      inspection.snapshot.snapshotFingerprint,
    );
    expect(inspection.snapshot.snapshotId).toBe(inspection.probeId);
  });
});

function descriptorWithResume(resume: boolean) {
  return parseRunnerAdapterDescriptorV1({
    version: RUNNER_ADAPTER_V1,
    adapterId,
    adapterVersion,
    profiles: [{ id: profileId, version: profileVersion }],
    transports: ["memory"],
    checkpointMode: "external_reference",
    cancellationMode: "best_effort",
    supports: {
      start: true,
      resume,
      capabilityInspection: true,
      streamingObservations: true,
      durableReplay: true,
      usageReferences: true,
      traceReferences: false,
    },
  });
}

function inspectionFor(
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  probeOverrides: Record<string, unknown> = {},
): RunnerCapabilityInspectionV1 {
  return buildRunnerCapabilityInspectionV1(
    descriptor,
    probe(
      command.kind === "start" ? "new" : "resume",
      command.requiredCapabilities,
      probeOverrides,
    ),
    classes(),
  );
}

function expectCommandDrift(
  binding: RunnerCapabilityCommandBindingV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
): void {
  const assertion = () => command.kind === "start"
    ? requireRunnerCapabilityInspectionForCommandV1(binding, command)
    : requireRunnerCapabilityInspectionForCommandV1(binding, command);
  expect(assertion).toThrow("command binding is stale");
}

type CapabilityRequirement =
  RunnerCapabilityProbeV1["requiredCapabilities"][number];

function startRequirements(): CapabilityRequirement[] {
  return [
    { class: "native_core", id: "shell" },
    { class: "configured_mcp", id: "stensibly" },
  ];
}

function classes() {
  return {
    native_core: {
      executable: [{ id: "shell", name: "Shell" }],
      provenance: ["test:core"],
    },
    configured_mcp: {
      executable: [{ id: "stensibly", name: "Stensibly" }],
      provenance: ["test:mcp"],
    },
    app_connector: {
      executable: [{ id: "github", name: "GitHub" }],
      provenance: ["test:connector"],
    },
  };
}

function probe(
  transition: "new" | "resume",
  requiredCapabilities: readonly CapabilityRequirement[],
  overrides: Record<string, unknown> = {},
): RunnerCapabilityProbeV1 {
  return parseRunnerCapabilityProbeV1({
    version: RUNNER_ADAPTER_V1,
    probeId: `probe-capability-${transition}`,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration: 1,
    transport: "memory",
    transition,
    clientProduct: "capability-binding-test",
    clientBuild: "1.0.0",
    modelProfile: "scripted-model",
    externalSurfaceRef: "surface:capability-binding",
    requiredCapabilities,
    recoveryActions: ["resume_with_current_tools"],
    observedAt: "2026-07-31T00:00:01.000Z",
    traceId: "trace-capability-binding",
    ...overrides,
  });
}

function startCommand(
  requiredCapabilities: readonly CapabilityRequirement[],
  overrides: Record<string, unknown> = {},
): RunnerStartCommandV1 {
  return parseRunnerStartCommandV1({
    ...commandBase(requiredCapabilities),
    kind: "start",
    ...overrides,
  });
}

function resumeCommand(
  requiredCapabilities: readonly CapabilityRequirement[],
  overrides: Record<string, unknown> = {},
): RunnerResumeCommandV1 {
  return parseRunnerResumeCommandV1({
    ...commandBase(requiredCapabilities),
    kind: "resume",
    continuation: { id: "continuation-capability-1", generation: 1 },
    adapterResumeRef: null,
    checkpointRef: null,
    reason: "continuation",
    ...overrides,
  });
}

function checkpointReference() {
  return {
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint",
    adapterId,
    externalId: "checkpoint:capability-binding:2",
    digest: null,
    uri: null,
    generation: 2,
    createdAt: "2026-07-31T00:00:02.000Z",
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  };
}

function commandBase(requiredCapabilities: readonly CapabilityRequirement[]) {
  return {
    version: RUNNER_ADAPTER_V1,
    commandId: "command-capability-binding",
    correlationId: "workflow-capability-binding",
    adapterId,
    adapterVersion,
    profileId,
    profileVersion,
    runId,
    runGeneration: 1,
    leaseGeneration: 1,
    authority: {
      resource: `run:${runId}`,
      holderId: "runner-actor",
      generation: 1,
      expiresAt: "2026-07-31T01:00:00.000Z",
    },
    itemId,
    project,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Prove exact runner capability inspection binding.",
    ),
    context: {
      version: 1,
      generatedAt: issuedAt,
      item: { id: itemId, project },
      intent: {
        objective: "Prove exact runner capability inspection binding.",
        summary: null,
        nextAction: "Match one exact command to one capability inspection.",
      },
      events: [],
      artifacts: [],
      runs: [],
      dependencies: [],
      sourceReferences: [`item:${itemId}`],
      omitted: { events: 0, artifacts: 0, runs: 0, dependencies: 0 },
      characterCount: 512,
    },
    requiredCapabilities,
    capabilityGrantRefs: ["grant:test-capability-binding"],
    issuedAt,
  };
}
