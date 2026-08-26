import { v } from "convex/values";
import { stableJson, sha256 } from "../src/canonical-json";
import {
  parseElaturaApplicationLaneEventV1,
  type ApplicationWorkBindingV1,
} from "../src/application-lane-binding";
import { parseApplicationWorkBindingInputJson } from "../src/application-lane-binding-store";
import {
  compileApplicationLaneWakeIntentV1,
  parseApplicationLaneWakeIntentV1,
  parseApplicationLaneWakeRegistrationV1,
  type ApplicationLaneWakeIntentV1,
} from "../src/application-lane-wake-intent";
import {
  applicationLaneWakeToDispatchTriggerV1,
  parseDispatchTriggerV1,
  type DispatchTriggerV1,
} from "../src/dispatch-trigger";
import { runnerProfileProvenanceV1 } from "../src/runner-profile-provenance";
import {
  assertLeaseSeconds,
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { dispatchHostedExactGeneration } from "./lib/exactDispatch";
import {
  executionEnvelopeValidator,
  normalizeExecutionEnvelope,
} from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

export const recordWake = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    registrationJson: v.string(),
    eventJson: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveScope(ctx, args.workspace, args.project);
    const registration = parseApplicationLaneWakeRegistrationV1(parseJson(args.registrationJson));
    const event = parseElaturaApplicationLaneEventV1(parseJson(args.eventJson));
    if (registration.project !== scope.projectSlug) {
      throw new Error("APPLICATION_LANE_WAKE_PROJECT_MISMATCH");
    }
    const requestJson = stableJson({ registration, event });
    const requestKey = `application-lane-wake-admission:${hashBody(requestJson)}`;

    const replay = await ctx.db
      .query("applicationLaneWakeIntents")
      .withIndex("by_workspace_request_key", (q) =>
        q.eq("workspaceId", scope.workspaceId).eq("requestKey", requestKey)
      )
      .unique();
    if (replay) {
      if (replay.requestJson !== requestJson || replay.projectId !== scope.projectId) {
        throw new Error("APPLICATION_LANE_WAKE_ADMISSION_CONFLICT");
      }
      return stableJson(await admitStoredWake(ctx, replay, scope));
    }

    const bindingRow = await currentBindingRow(ctx, scope.projectId, registration.bindingId);
    if (!bindingRow) throw new Error("APPLICATION_LANE_WAKE_BINDING_UNAVAILABLE");
    const { binding, bindingInput, item } = await admitStoredBinding(ctx, bindingRow, scope);
    const authority = {
      project: scope.projectSlug,
      itemId: item.externalId,
      claimGeneration: item.claimGeneration,
    };
    const decision = compileApplicationLaneWakeIntentV1(
      registration,
      bindingInput,
      authority,
      event,
    );
    if (!decision.matched || !decision.wakeIntent) {
      throw new Error(`APPLICATION_LANE_WAKE_NOT_ADMITTED:${decision.reason}`);
    }
    const wake = decision.wakeIntent;
    const wakeJson = stableJson(wake);
    const recordedAt = Date.now();
    if (recordedAt < Date.parse(wake.observedAt)) {
      throw new Error("APPLICATION_LANE_WAKE_OBSERVATION_IN_FUTURE");
    }

    const existingSource = await ctx.db
      .query("applicationLaneWakeIntents")
      .withIndex("by_workspace_source_ref", (q) =>
        q.eq("workspaceId", scope.workspaceId).eq("sourceRef", wake.idempotencyKey)
      )
      .unique();
    if (existingSource) {
      const stored = await admitStoredWake(ctx, existingSource, scope);
      if (stableJson(stored) !== wakeJson || existingSource.requestJson !== requestJson) {
        throw new Error("APPLICATION_LANE_WAKE_SOURCE_CONFLICT");
      }
      return wakeJson;
    }

    await ctx.db.insert("applicationLaneWakeIntents", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      itemId: item._id,
      itemExternalId: wake.itemId,
      requestKey,
      requestJson,
      sourceRef: wake.idempotencyKey,
      wakeFingerprint: wake.fingerprint,
      wakeJson,
      registrationId: wake.registrationId,
      registrationGeneration: wake.registrationGeneration,
      claimGeneration: wake.claimGeneration,
      bindingId: wake.bindingId,
      bindingGeneration: wake.bindingGeneration,
      laneRef: wake.laneRef,
      laneGeneration: wake.laneGeneration,
      sourceEventId: wake.sourceEventId,
      observedAt: Date.parse(wake.observedAt),
      recordedAt,
    });
    const stored = await ctx.db
      .query("applicationLaneWakeIntents")
      .withIndex("by_workspace_source_ref", (q) =>
        q.eq("workspaceId", scope.workspaceId).eq("sourceRef", wake.idempotencyKey)
      )
      .unique();
    if (!stored) throw new Error("APPLICATION_LANE_WAKE_STORAGE_FAILED");
    return stableJson(await admitStoredWake(ctx, stored, scope));
  },
});

export const consume = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    triggerJson: v.string(),
    actor: actorValidator,
    runnerType: v.string(),
    runnerProfile: v.string(),
    runnerProfileVersion: v.optional(v.union(v.string(), v.null())),
    leaseSeconds: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    retryBackoffSeconds: v.optional(v.number()),
    executionEnvelope: v.optional(executionEnvelopeValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveScope(ctx, args.workspace, args.project);
    const trigger = parseDispatchTriggerV1(parseJson(args.triggerJson));
    if (trigger.project !== scope.projectSlug || trigger.triggerClass !== "wake_intent") {
      throw new Error("APPLICATION_LANE_TRIGGER_SCOPE_MISMATCH");
    }

    const replay = await ctx.db
      .query("applicationLaneTriggerConsumptions")
      .withIndex("by_workspace_trigger_key", (q) =>
        q.eq("workspaceId", scope.workspaceId)
          .eq("triggerIdempotencyKey", trigger.idempotencyKey)
      )
      .unique();
    if (replay) {
      const receipt = await admitStoredReceipt(ctx, replay, scope);
      requireReceiptMatchesTrigger(receipt, trigger);
      return freeze({ status: "consumed" as const, replay: true, receipt });
    }

    const wakeRow = await ctx.db
      .query("applicationLaneWakeIntents")
      .withIndex("by_workspace_source_ref", (q) =>
        q.eq("workspaceId", scope.workspaceId).eq("sourceRef", trigger.sourceRef)
      )
      .unique();
    if (!wakeRow) return staleSource(trigger);
    const wake = await admitStoredWake(ctx, wakeRow, scope);
    const sourceTrigger = applicationLaneWakeToDispatchTriggerV1(wake);
    if (stableJson(sourceTrigger) !== stableJson(trigger)) {
      throw new Error("APPLICATION_LANE_TRIGGER_SOURCE_CONFLICT");
    }

    const bindingRow = await currentBindingRow(ctx, scope.projectId, wake.bindingId);
    if (!bindingRow) return staleSource(trigger);
    const { binding, item } = await admitStoredBinding(ctx, bindingRow, scope);
    if (
      binding.retiredAt !== null
      || binding.itemId !== wake.itemId
      || binding.generation !== wake.bindingGeneration
      || binding.laneRef !== wake.laneRef
      || binding.laneGeneration !== wake.laneGeneration
      || !binding.capabilities.includes("events")
    ) {
      return staleSource(trigger);
    }

    const dispatchActor = await upsertActor(ctx, scope.workspaceId, args.actor);
    if (!dispatchActor) throw new Error("APPLICATION_LANE_TRIGGER_ACTOR_UNAVAILABLE");
    const provenance = runnerProfileProvenanceV1(
      args.runnerProfile,
      args.runnerProfileVersion,
    );
    const envelope = normalizeExecutionEnvelope(
      args.executionEnvelope,
      `Consume application wake ${wake.idempotencyKey}`,
    );
    const dispatch = await dispatchHostedExactGeneration(ctx, {
      workspaceId: scope.workspaceId,
      itemId: item._id,
      actor: dispatchActor,
      expectedClaimGeneration: trigger.expectedClaimGeneration,
      runnerType: boundedText(args.runnerType, "Runner type", 80),
      runnerProfile: provenance.profileId,
      runnerProfileVersion: provenance.profileVersion,
      leaseSeconds: assertLeaseSeconds(args.leaseSeconds ?? 900),
      maxAttempts: boundedInteger(args.maxAttempts ?? 3, "Maximum attempts", 1, 20),
      retryBackoffSeconds: boundedInteger(
        args.retryBackoffSeconds ?? 60,
        "Retry backoff seconds",
        0,
        86_400,
      ),
      executionEnvelope: envelope,
      eventSource: "application_lane_wake",
      now: Date.now(),
    });
    if (dispatch.status === "stale_generation") {
      return freeze({
        status: "stale_generation" as const,
        triggerFingerprint: trigger.fingerprint,
        expectedClaimGeneration: trigger.expectedClaimGeneration,
        currentClaimGeneration: dispatch.currentClaimGeneration,
      });
    }
    if (dispatch.status === "unavailable") {
      return freeze({
        status: "unavailable" as const,
        triggerFingerprint: trigger.fingerprint,
      });
    }

    const consumedAt = Date.now();
    const receipt = buildReceipt(
      trigger,
      dispatch.claimedGeneration,
      dispatch.run.externalId,
      consumedAt,
    );
    await ctx.db.insert("applicationLaneTriggerConsumptions", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      itemId: item._id,
      itemExternalId: trigger.itemId,
      triggerIdempotencyKey: trigger.idempotencyKey,
      triggerFingerprint: trigger.fingerprint,
      sourceRef: trigger.sourceRef,
      sourceFingerprint: trigger.sourceFingerprint,
      expectedClaimGeneration: trigger.expectedClaimGeneration,
      claimedGeneration: dispatch.claimedGeneration,
      runId: dispatch.run._id,
      runExternalId: dispatch.run.externalId,
      receiptJson: stableJson(receipt),
      receiptFingerprint: receipt.fingerprint,
      consumedAt,
    });
    const stored = await ctx.db
      .query("applicationLaneTriggerConsumptions")
      .withIndex("by_workspace_trigger_key", (q) =>
        q.eq("workspaceId", scope.workspaceId)
          .eq("triggerIdempotencyKey", trigger.idempotencyKey)
      )
      .unique();
    if (!stored) throw new Error("APPLICATION_LANE_TRIGGER_RECEIPT_STORAGE_FAILED");
    return freeze({
      status: "consumed" as const,
      replay: false,
      receipt: await admitStoredReceipt(ctx, stored, scope),
    });
  },
});

async function resolveScope(ctx: any, workspaceInput: string | undefined, projectInput: string) {
  const workspace = await findWorkspace(ctx, normalizeWorkspace(workspaceInput));
  if (!workspace) throw new Error("APPLICATION_LANE_WAKE_WORKSPACE_NOT_FOUND");
  const projectSlug = assertSlug(projectInput, "Project");
  const project = await findProject(ctx, workspace._id, projectSlug);
  if (!project) throw new Error("APPLICATION_LANE_WAKE_PROJECT_NOT_FOUND");
  return { workspaceId: workspace._id, projectId: project._id, projectSlug };
}

async function currentBindingRow(ctx: any, projectId: any, bindingId: string) {
  return await ctx.db
    .query("applicationLaneBindings")
    .withIndex("by_project_id_and_external_id_and_is_current", (q: any) =>
      q.eq("projectId", projectId).eq("externalId", bindingId).eq("isCurrent", true)
    )
    .unique();
}

async function admitStoredBinding(ctx: any, row: any, scope: any): Promise<{
  binding: ApplicationWorkBindingV1;
  bindingInput: unknown;
  item: any;
}> {
  let bindingInput: unknown;
  let binding: ApplicationWorkBindingV1;
  try {
    bindingInput = parseJson(row.bindingJson);
    binding = parseApplicationWorkBindingInputJson(row.bindingJson);
  } catch {
    throw new Error("APPLICATION_LANE_BINDING_STORAGE_CORRUPT");
  }
  const item = await ctx.db.get("items", row.itemId);
  const recordedAt = binding.retiredAt === null
    ? Date.parse(binding.createdAt)
    : Date.parse(binding.retiredAt);
  const valid = row.workspaceId === scope.workspaceId
    && row.projectId === scope.projectId
    && item !== null
    && item.workspaceId === scope.workspaceId
    && item.projectId === scope.projectId
    && item.externalId === binding.itemId
    && row.itemExternalId === binding.itemId
    && row.externalId === binding.id
    && row.generation === binding.generation
    && row.provider === "elatura"
    && row.laneRef === binding.laneRef
    && row.laneGeneration === binding.laneGeneration
    && row.status === (binding.retiredAt === null ? "active" : "retired")
    && row.bindingFingerprint === binding.fingerprint
    && row.recordedAt === recordedAt;
  if (!valid) throw new Error("APPLICATION_LANE_BINDING_STORAGE_CORRUPT");
  return { binding, bindingInput, item };
}

async function admitStoredWake(
  ctx: any,
  row: any,
  scope: any,
): Promise<ApplicationLaneWakeIntentV1> {
  let wake: ApplicationLaneWakeIntentV1;
  try {
    wake = parseApplicationLaneWakeIntentV1(parseJson(row.wakeJson));
  } catch {
    throw new Error("APPLICATION_LANE_WAKE_STORAGE_CORRUPT");
  }
  const item = await ctx.db.get("items", row.itemId);
  const valid = row.workspaceId === scope.workspaceId
    && row.projectId === scope.projectId
    && item !== null
    && item.workspaceId === scope.workspaceId
    && item.projectId === scope.projectId
    && item.externalId === wake.itemId
    && row.itemExternalId === wake.itemId
    && row.sourceRef === wake.idempotencyKey
    && row.wakeFingerprint === wake.fingerprint
    && row.wakeJson === stableJson(wake)
    && row.registrationId === wake.registrationId
    && row.registrationGeneration === wake.registrationGeneration
    && row.claimGeneration === wake.claimGeneration
    && row.bindingId === wake.bindingId
    && row.bindingGeneration === wake.bindingGeneration
    && row.laneRef === wake.laneRef
    && row.laneGeneration === wake.laneGeneration
    && row.sourceEventId === wake.sourceEventId
    && row.observedAt === Date.parse(wake.observedAt)
    && Number.isFinite(row.recordedAt)
    && row.recordedAt >= row.observedAt;
  if (!valid) throw new Error("APPLICATION_LANE_WAKE_STORAGE_CORRUPT");
  return wake;
}

type Receipt = Readonly<{
  version: 1;
  kind: "dispatch_trigger_consumption";
  triggerFingerprint: string;
  triggerIdempotencyKey: string;
  project: string;
  itemId: string;
  expectedClaimGeneration: number;
  claimedGeneration: number;
  sourceRef: string;
  sourceFingerprint: string;
  runId: string;
  consumedAt: string;
  grantsAuthority: false;
  authorizesFurtherDispatch: false;
  fingerprint: string;
}>;

function buildReceipt(
  trigger: DispatchTriggerV1,
  claimedGeneration: number,
  runId: string,
  consumedAt: number,
): Receipt {
  if (claimedGeneration !== trigger.expectedClaimGeneration + 1) {
    throw new Error("APPLICATION_LANE_TRIGGER_GENERATION_CORRUPT");
  }
  const core = {
    version: 1 as const,
    kind: "dispatch_trigger_consumption" as const,
    triggerFingerprint: trigger.fingerprint,
    triggerIdempotencyKey: trigger.idempotencyKey,
    project: trigger.project,
    itemId: trigger.itemId,
    expectedClaimGeneration: trigger.expectedClaimGeneration,
    claimedGeneration,
    sourceRef: trigger.sourceRef,
    sourceFingerprint: trigger.sourceFingerprint,
    runId,
    consumedAt: new Date(consumedAt).toISOString(),
    grantsAuthority: false as const,
    authorizesFurtherDispatch: false as const,
  };
  return freeze({ ...core, fingerprint: sha256(stableJson(core)) });
}

async function admitStoredReceipt(ctx: any, row: any, scope: any): Promise<Receipt> {
  const parsed = record(parseJson(row.receiptJson));
  if (!parsed) throw new Error("APPLICATION_LANE_TRIGGER_RECEIPT_CORRUPT");
  const core = {
    version: 1 as const,
    kind: "dispatch_trigger_consumption" as const,
    triggerFingerprint: exactString(parsed.triggerFingerprint),
    triggerIdempotencyKey: exactString(parsed.triggerIdempotencyKey),
    project: exactString(parsed.project),
    itemId: exactString(parsed.itemId),
    expectedClaimGeneration: nonNegativeInteger(parsed.expectedClaimGeneration),
    claimedGeneration: positiveInteger(parsed.claimedGeneration),
    sourceRef: exactString(parsed.sourceRef),
    sourceFingerprint: exactString(parsed.sourceFingerprint),
    runId: exactString(parsed.runId),
    consumedAt: exactTimestamp(parsed.consumedAt),
    grantsAuthority: false as const,
    authorizesFurtherDispatch: false as const,
  };
  if (
    parsed.version !== 1
    || parsed.kind !== "dispatch_trigger_consumption"
    || parsed.grantsAuthority !== false
    || parsed.authorizesFurtherDispatch !== false
    || core.claimedGeneration !== core.expectedClaimGeneration + 1
  ) {
    throw new Error("APPLICATION_LANE_TRIGGER_RECEIPT_CORRUPT");
  }
  const fingerprint = sha256(stableJson(core));
  const receipt = freeze({ ...core, fingerprint });
  const item = await ctx.db.get("items", row.itemId);
  const run = await ctx.db.get("queuedRuns", row.runId);
  const valid = parsed.fingerprint === fingerprint
    && row.workspaceId === scope.workspaceId
    && row.projectId === scope.projectId
    && item !== null
    && item.workspaceId === scope.workspaceId
    && item.projectId === scope.projectId
    && item.externalId === receipt.itemId
    && row.itemExternalId === receipt.itemId
    && run !== null
    && run.workspaceId === scope.workspaceId
    && run.projectId === scope.projectId
    && run.itemId === row.itemId
    && run.externalId === receipt.runId
    && row.runExternalId === receipt.runId
    && row.triggerIdempotencyKey === receipt.triggerIdempotencyKey
    && row.triggerFingerprint === receipt.triggerFingerprint
    && row.sourceRef === receipt.sourceRef
    && row.sourceFingerprint === receipt.sourceFingerprint
    && row.expectedClaimGeneration === receipt.expectedClaimGeneration
    && row.claimedGeneration === receipt.claimedGeneration
    && row.receiptJson === stableJson(receipt)
    && row.receiptFingerprint === receipt.fingerprint
    && new Date(row.consumedAt).toISOString() === receipt.consumedAt;
  if (!valid) throw new Error("APPLICATION_LANE_TRIGGER_RECEIPT_CORRUPT");
  return receipt;
}

function requireReceiptMatchesTrigger(receipt: Receipt, trigger: DispatchTriggerV1) {
  if (
    receipt.triggerFingerprint !== trigger.fingerprint
    || receipt.triggerIdempotencyKey !== trigger.idempotencyKey
    || receipt.project !== trigger.project
    || receipt.itemId !== trigger.itemId
    || receipt.expectedClaimGeneration !== trigger.expectedClaimGeneration
    || receipt.sourceRef !== trigger.sourceRef
    || receipt.sourceFingerprint !== trigger.sourceFingerprint
  ) {
    throw new Error("APPLICATION_LANE_TRIGGER_REPLAY_CONFLICT");
  }
}

function staleSource(trigger: DispatchTriggerV1) {
  return freeze({ status: "stale_source" as const, triggerFingerprint: trigger.fingerprint });
}

function parseJson(value: string): unknown {
  if (typeof value !== "string" || value.length === 0 || value.length > 200_000) {
    throw new Error("APPLICATION_LANE_JSON_INVALID");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("APPLICATION_LANE_JSON_INVALID");
  }
}

function hashBody(value: string): string {
  return sha256(value).slice("sha256:".length);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  return boundedInteger(value, "Generation", 0, Number.MAX_SAFE_INTEGER);
}

function positiveInteger(value: unknown): number {
  return boundedInteger(value, "Generation", 1, Number.MAX_SAFE_INTEGER);
}

function exactString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error("APPLICATION_LANE_TRIGGER_RECEIPT_CORRUPT");
  }
  return value;
}

function exactTimestamp(value: unknown): string {
  const text = exactString(value);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    throw new Error("APPLICATION_LANE_TRIGGER_RECEIPT_CORRUPT");
  }
  return text;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
