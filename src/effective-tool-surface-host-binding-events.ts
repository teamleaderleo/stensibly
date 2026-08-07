import { createHash } from "node:crypto";
import { effectiveToolSurfaceClasses } from "./effective-tool-surface.js";
import {
  reconcileEffectiveToolSurfaceHostBinding,
  type EffectiveToolSurfaceHostBindingSnapshot,
} from "./effective-tool-surface-host-binding.js";
import type { WorkLedger } from "./ledger.js";
import type { ActorInput } from "./schemas.js";
import type { WorkRun } from "./runs-core.js";
import type { ItemEvent } from "./store.js";

export const EFFECTIVE_TOOL_SURFACE_HOST_BINDING_EVENT_TYPE =
  "run.tool_surface_host_binding_observed";

export interface RecordEffectiveToolSurfaceHostBindingEventInput {
  ledger: Pick<WorkLedger, "recordEvent">;
  run: Pick<
    WorkRun,
    "id" | "itemId" | "actorId" | "generation" | "runnerType" | "runnerProfile"
  >;
  snapshot: EffectiveToolSurfaceHostBindingSnapshot;
  previousSnapshot?: EffectiveToolSurfaceHostBindingSnapshot;
  actor: ActorInput;
}

/**
 * Persists one content-minimised host-binding observation through the existing
 * append-only run event path. The evidence is runner-reported host state; it
 * does not infer Stensibly server, provider, OAuth, or executable-tool health.
 */
export async function recordEffectiveToolSurfaceHostBindingEvent(
  input: RecordEffectiveToolSurfaceHostBindingEventInput,
): Promise<ItemEvent> {
  validateRunBinding(
    input.run,
    input.snapshot,
    input.previousSnapshot,
    input.actor,
  );
  const reconciliation = reconcileEffectiveToolSurfaceHostBinding(
    input.snapshot,
    input.previousSnapshot,
  );
  const payload = buildPayload(input.run, input.snapshot, reconciliation);
  return input.ledger.recordEvent({
    id: input.run.itemId,
    actor: input.actor,
    type: EFFECTIVE_TOOL_SURFACE_HOST_BINDING_EVENT_TYPE,
    payload,
    idempotencyKey: eventIdempotencyKey(input.run.itemId, input.snapshot),
  });
}

function buildPayload(
  run: RecordEffectiveToolSurfaceHostBindingEventInput["run"],
  snapshot: EffectiveToolSurfaceHostBindingSnapshot,
  reconciliation: ReturnType<typeof reconcileEffectiveToolSurfaceHostBinding>,
): Record<string, unknown> {
  const classes = Object.fromEntries(
    effectiveToolSurfaceClasses.map((className) => {
      const value = snapshot.classObservations[className];
      return [className, {
        observation: value.observation,
        catalogueCount: value.catalogueCount,
        catalogueDigest: value.catalogueDigest,
        executableCount: value.executableCount,
        executableDigest: value.executableDigest,
        provenanceCount: value.provenance.length,
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
      snapshotId: snapshot.toolSurface.snapshotId,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      hostBindingFingerprint: snapshot.hostBindingFingerprint,
      toolSurfaceSnapshotFingerprint: snapshot.toolSurface.snapshotFingerprint,
      toolSurfaceSurfaceFingerprint: snapshot.toolSurface.surfaceFingerprint,
      requiredFingerprint: snapshot.toolSurface.requiredFingerprint,
      transition: snapshot.toolSurface.transition,
      observedAt: snapshot.toolSurface.observedAt,
      traceId: snapshot.toolSurface.traceId,
    },
    classes,
    reconciliation: {
      state: reconciliation.state,
      previousSnapshotId: reconciliation.previousSnapshotId,
      hostBindingChanged: reconciliation.hostBindingChanged,
      toolSurfaceChanged: reconciliation.base.surfaceChanged,
      classObservationChanges: reconciliation.classObservationChanges,
      absentClasses: reconciliation.absentClasses,
      unobservedClasses: reconciliation.unobservedClasses,
      degradedClasses: reconciliation.base.degradedClasses,
      dispatchDecision: reconciliation.dispatchDecision,
      consequentialCallsAllowed: reconciliation.consequentialCallsAllowed,
      recommendedRecoveryAction: reconciliation.recommendedRecoveryAction,
      recommendedRecoveryReason: reconciliation.recommendedRecoveryReason,
      serverContractHealthInferred: false,
      historicalCallsProveCurrentBinding: false,
    },
    evidencePolicy: {
      observationAuthority: "runner_report",
      reportedByActorId: run.actorId,
      serverVerifiedHostBinding: false,
      serverContractHealthInferred: false,
      containsCapabilityIds: false,
      containsCapabilityDisplayNames: false,
      containsRawProvenance: false,
      containsExternalSurfaceReference: false,
      containsSecrets: false,
      historicalCallsProveCurrentBinding: false,
    },
  };
}

function validateRunBinding(
  run: RecordEffectiveToolSurfaceHostBindingEventInput["run"],
  snapshot: EffectiveToolSurfaceHostBindingSnapshot,
  previous: EffectiveToolSurfaceHostBindingSnapshot | undefined,
  actor: ActorInput,
): void {
  const toolSurface = snapshot.toolSurface;
  if (actor.id !== run.actorId) {
    throw new RangeError("Host-binding reporter does not match the durable run actor");
  }
  if (toolSurface.runId !== run.id) {
    throw new RangeError("Host-binding snapshot run ID does not match the durable run");
  }
  if (toolSurface.runGeneration !== run.generation) {
    throw new RangeError("Host-binding snapshot generation does not match the durable run");
  }
  if (toolSurface.runnerAdapter !== run.runnerType) {
    throw new RangeError("Host-binding runner adapter does not match the durable run type");
  }
  if (!previous) return;

  const previousToolSurface = previous.toolSurface;
  if (previousToolSurface.runId !== toolSurface.runId) {
    throw new RangeError("Previous host-binding snapshot belongs to a different run");
  }
  if (previousToolSurface.runnerAdapter !== toolSurface.runnerAdapter) {
    throw new RangeError("Previous host-binding snapshot uses a different runner adapter");
  }
  if (previousToolSurface.requiredFingerprint !== toolSurface.requiredFingerprint) {
    throw new RangeError("Host-binding required-capability set changed before persistence");
  }
  if (previousToolSurface.runGeneration > toolSurface.runGeneration) {
    throw new RangeError("Previous host-binding snapshot has a newer run generation");
  }
  if (Date.parse(previousToolSurface.observedAt) >= Date.parse(toolSurface.observedAt)) {
    throw new RangeError("Host-binding observations must be persisted in chronological order");
  }
}

function eventIdempotencyKey(
  itemId: string,
  snapshot: EffectiveToolSurfaceHostBindingSnapshot,
): string {
  return `run-tool-surface-host-binding:${createHash("sha256")
    .update(JSON.stringify({
      itemId,
      snapshotFingerprint: snapshot.snapshotFingerprint,
    }))
    .digest("hex")}`;
}
