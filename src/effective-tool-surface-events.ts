import { createHash } from "node:crypto";
import {
  effectiveToolSurfaceClasses,
  reconcileEffectiveToolSurface,
  type EffectiveToolSurfaceClass,
  type EffectiveToolSurfaceSnapshot,
  type ToolSurfaceCapabilityRef,
} from "./effective-tool-surface.js";
import type { WorkLedger } from "./ledger.js";
import type { ActorInput } from "./schemas.js";
import type { WorkRun } from "./runs-core.js";
import type { ItemEvent } from "./store.js";

export const EFFECTIVE_TOOL_SURFACE_EVENT_TYPE = "run.tool_surface_observed";

export interface RecordEffectiveToolSurfaceEventInput {
  ledger: Pick<WorkLedger, "recordEvent">;
  run: Pick<
    WorkRun,
    "id" | "itemId" | "actorId" | "generation" | "runnerType" | "runnerProfile"
  >;
  snapshot: EffectiveToolSurfaceSnapshot;
  previousSnapshot?: EffectiveToolSurfaceSnapshot;
  actor: ActorInput;
}

/**
 * Persists one bounded, actor-attributed runner observation through the
 * existing cross-backend item event contract. This is evidence reported by the
 * runner, not server verification that a host actually bound every capability.
 */
export async function recordEffectiveToolSurfaceEvent(
  input: RecordEffectiveToolSurfaceEventInput,
): Promise<ItemEvent> {
  validateRunBinding(input.run, input.snapshot, input.previousSnapshot, input.actor);
  const reconciliation = reconcileEffectiveToolSurface(
    input.snapshot,
    input.previousSnapshot,
  );
  const payload = buildPayload(input.run, input.snapshot, reconciliation);
  return input.ledger.recordEvent({
    id: input.run.itemId,
    actor: input.actor,
    type: EFFECTIVE_TOOL_SURFACE_EVENT_TYPE,
    payload,
    idempotencyKey: eventIdempotencyKey(input.run.itemId, input.snapshot),
  });
}

function buildPayload(
  run: RecordEffectiveToolSurfaceEventInput["run"],
  snapshot: EffectiveToolSurfaceSnapshot,
  reconciliation: ReturnType<typeof reconcileEffectiveToolSurface>,
): Record<string, unknown> {
  const classes = Object.fromEntries(
    effectiveToolSurfaceClasses.map((className) => {
      const value = snapshot.classes[className];
      return [className, {
        catalogueCount: value.catalogueCount,
        catalogueDigest: value.catalogueDigest,
        executableCount: value.executableCount,
        executableDigest: value.executableDigest,
        catalogueOnlyCount: value.catalogueOnlyCapabilityIds.length,
        provenanceCount: value.provenance.length,
        provenanceDigest: digestStrings(value.provenance),
      }];
    }),
  );

  return {
    version: 1,
    run: {
      id: run.id,
      itemId: run.itemId,
      actorId: run.actorId,
      generation: run.generation,
      runnerType: run.runnerType,
      runnerProfile: run.runnerProfile,
    },
    observation: {
      snapshotId: snapshot.snapshotId,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      surfaceFingerprint: snapshot.surfaceFingerprint,
      requiredFingerprint: snapshot.requiredFingerprint,
      runnerVersion: snapshot.runnerVersion,
      clientProduct: snapshot.clientProduct,
      clientBuild: snapshot.clientBuild,
      modelProfile: snapshot.modelProfile,
      transport: snapshot.transport,
      transition: snapshot.transition,
      observedAt: snapshot.observedAt,
      traceId: snapshot.traceId,
      externalSurfaceRefDigest: snapshot.externalSurfaceRef === null
        ? null
        : sha256(snapshot.externalSurfaceRef),
    },
    classes,
    requirements: {
      required: snapshot.requiredCapabilities,
      observed: snapshot.observedRequiredCapabilities,
      missing: snapshot.missingRequiredCapabilities,
      catalogueOnly: snapshot.catalogueOnlyRequiredCapabilities,
    },
    reconciliation: {
      state: reconciliation.state,
      previousSnapshotId: reconciliation.previousSnapshotId,
      surfaceChanged: reconciliation.surfaceChanged,
      missingSincePrevious: summarizeRefs(reconciliation.missingSincePrevious),
      addedSincePrevious: summarizeRefs(reconciliation.addedSincePrevious),
      degradedClasses: reconciliation.degradedClasses,
      dispatchDecision: reconciliation.dispatchDecision,
      consequentialCallsAllowed: reconciliation.consequentialCallsAllowed,
      recommendedRecoveryAction: reconciliation.recommendedRecoveryAction,
    },
    evidencePolicy: {
      observationAuthority: "runner_report",
      reportedByActorId: run.actorId,
      serverVerifiedExecutableBindings: false,
      containsCapabilityDisplayNames: false,
      containsRawProvenance: false,
      containsExternalSurfaceReference: false,
      containsSecrets: false,
      requiredCapabilityIdsIncluded: true,
      historicalCallsProveCurrentBinding: false,
    },
  };
}

function validateRunBinding(
  run: RecordEffectiveToolSurfaceEventInput["run"],
  snapshot: EffectiveToolSurfaceSnapshot,
  previous: EffectiveToolSurfaceSnapshot | undefined,
  actor: ActorInput,
): void {
  if (actor.id !== run.actorId) {
    throw new RangeError("Tool-surface reporter does not match the durable run actor");
  }
  if (snapshot.runId !== run.id) {
    throw new RangeError("Tool-surface snapshot run ID does not match the durable run");
  }
  if (snapshot.runGeneration !== run.generation) {
    throw new RangeError("Tool-surface snapshot generation does not match the durable run");
  }
  if (snapshot.runnerAdapter !== run.runnerType) {
    throw new RangeError("Tool-surface runner adapter does not match the durable run type");
  }
  if (!previous) return;
  if (previous.runId !== snapshot.runId) {
    throw new RangeError("Previous tool-surface snapshot belongs to a different run");
  }
  if (previous.requiredFingerprint !== snapshot.requiredFingerprint) {
    throw new RangeError("Tool-surface required-capability set changed before persistence");
  }
  if (previous.runGeneration > snapshot.runGeneration) {
    throw new RangeError("Previous tool-surface snapshot has a newer run generation");
  }
  if (Date.parse(previous.observedAt) >= Date.parse(snapshot.observedAt)) {
    throw new RangeError("Tool-surface observations must be persisted in chronological order");
  }
}

function summarizeRefs(
  refs: readonly ToolSurfaceCapabilityRef[],
): Record<EffectiveToolSurfaceClass, { count: number; digest: string }> {
  return Object.fromEntries(
    effectiveToolSurfaceClasses.map((className) => {
      const ids = refs
        .filter((entry) => entry.class === className)
        .map((entry) => entry.id)
        .sort();
      return [className, { count: ids.length, digest: digestStrings(ids) }];
    }),
  ) as Record<EffectiveToolSurfaceClass, { count: number; digest: string }>;
}

function eventIdempotencyKey(
  itemId: string,
  snapshot: EffectiveToolSurfaceSnapshot,
): string {
  return `run-tool-surface:${createHash("sha256")
    .update(JSON.stringify({ itemId, snapshotFingerprint: snapshot.snapshotFingerprint }))
    .digest("hex")}`;
}

function digestStrings(values: readonly string[]): string {
  return sha256(JSON.stringify([...values].sort()));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
