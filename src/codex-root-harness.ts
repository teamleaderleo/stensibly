import { createHash } from "node:crypto";
import type {
  CodexAppServerConnection,
  CodexAppServerNotification,
} from "./codex-app-server-client.js";
import {
  parseRunnerExternalReferencePortableV1,
  type RunnerExternalReferencePortableV1,
} from "./runner-external-reference-portable.js";
import {
  requireExactRunnerProfileResumeV1,
  runnerProfileProvenanceV1,
  type RunnerProfileProvenanceV1,
} from "./runner-profile-provenance.js";

export const CODEX_ROOT_HARNESS_V1 = 1 as const;
export const CODEX_APP_SERVER_ADAPTER_ID = "openai-codex-app-server" as const;

export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never";

export interface CodexRootMissionV1 {
  readonly version: typeof CODEX_ROOT_HARNESS_V1;
  readonly missionRef: string;
  readonly responsibilityGeneration: number;
  readonly revisionDigest: `sha256:${string}`;
  readonly objective: string;
  /** Current compiled brief. It is sent to Codex but never retained in a binding or receipt. */
  readonly launchBrief: string;
}

export interface CodexRootProfileV1 {
  readonly version: typeof CODEX_ROOT_HARNESS_V1;
  readonly provenance: RunnerProfileProvenanceV1;
  readonly model: string;
  readonly effort: CodexReasoningEffort;
  readonly cwd: string;
  readonly sandbox: CodexSandboxMode;
  readonly networkAccess: boolean;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly goalTokenBudget: number | null;
}

export interface CodexRootRuntimeIdentityV1 {
  readonly threadId: string;
  readonly sessionId: string;
  readonly isIndependentRoot: true;
  readonly model: string;
  readonly modelProvider: string;
  readonly effort: string | null;
  readonly cwd: string;
}

export interface CodexRootBindingV1 {
  readonly version: typeof CODEX_ROOT_HARNESS_V1;
  readonly adapterId: typeof CODEX_APP_SERVER_ADAPTER_ID;
  readonly missionRef: string;
  readonly responsibilityGeneration: number;
  readonly missionRevisionDigest: `sha256:${string}`;
  readonly objectiveDigest: `sha256:${string}`;
  readonly profile: RunnerProfileProvenanceV1;
  readonly runtime: CodexRootRuntimeIdentityV1;
  readonly rootRef: RunnerExternalReferencePortableV1;
  readonly predecessorRootRef: RunnerExternalReferencePortableV1 | null;
  readonly goalTokenBudget: number | null;
}

export type CodexRootDispositionV1 =
  | "initial_root"
  | "hot_continuation"
  | "resumed_after_controller_restart"
  | "fresh_successor_root";

export interface CodexRootGoalObservationV1 {
  readonly objectiveDigest: `sha256:${string}`;
  readonly status: string;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly reconciled: boolean;
}

export interface CodexRootTokenUsageV1 {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly modelContextWindow: number | null;
}

export interface CodexRootRunObservationV1 {
  readonly version: typeof CODEX_ROOT_HARNESS_V1;
  readonly disposition: CodexRootDispositionV1;
  readonly rootRef: RunnerExternalReferencePortableV1;
  readonly predecessorRootRef: RunnerExternalReferencePortableV1 | null;
  readonly threadId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnStatus: string;
  readonly sandbox: CodexSandboxMode;
  readonly networkAccess: boolean;
  readonly briefCharacters: number;
  readonly handoffMs: number;
  readonly executionMs: number;
  readonly elapsedMs: number;
  readonly goal: CodexRootGoalObservationV1;
  readonly tokenUsage: CodexRootTokenUsageV1 | null;
}

export interface CodexRootRunResultV1 {
  readonly binding: CodexRootBindingV1;
  readonly observation: CodexRootRunObservationV1;
}

export interface CodexRootBackpressureV1 {
  readonly version: typeof CODEX_ROOT_HARNESS_V1;
  readonly kind: "native_child_slot_capacity";
  readonly scope: "codex_session_tree";
  readonly retryable: true;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly detailDigest: `sha256:${string}`;
}

export interface CodexRootHarnessOptions {
  readonly turnTimeoutMs?: number;
  readonly settlementTimeoutMs?: number;
  readonly clock?: () => Date;
}

/**
 * Stateless mission/root reconciliation over one app-server connection.
 * Stensibly owns missions and bindings; this class owns no queue or durable ledger.
 */
export class CodexRootHarness {
  readonly #connection: CodexAppServerConnection;
  readonly #turnTimeoutMs: number;
  readonly #settlementTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #loadedByThisController = new Set<string>();

  constructor(connection: CodexAppServerConnection, options: CodexRootHarnessOptions = {}) {
    this.#connection = connection;
    this.#turnTimeoutMs = positiveInteger(options.turnTimeoutMs ?? 600_000, "Turn timeout");
    this.#settlementTimeoutMs = positiveInteger(options.settlementTimeoutMs ?? 30_000, "Turn settlement timeout");
    this.#clock = options.clock ?? (() => new Date());
  }

  async start(missionInput: CodexRootMissionV1, profileInput: CodexRootProfileV1): Promise<CodexRootRunResultV1> {
    const operationStartedAt = this.#clock().getTime();
    const mission = admitMission(missionInput);
    const profile = admitProfile(profileInput);
    return this.#startFresh(mission, profile, null, "initial_root", operationStartedAt);
  }

  async continue(
    bindingInput: CodexRootBindingV1,
    missionInput: CodexRootMissionV1,
    profileInput: CodexRootProfileV1,
  ): Promise<CodexRootRunResultV1> {
    const operationStartedAt = this.#clock().getTime();
    const binding = admitBinding(bindingInput);
    const mission = admitMission(missionInput);
    const profile = admitProfile(profileInput);
    if (!missionMatches(binding, mission) || !profilesMatch(binding.profile, profile.provenance)) {
      return this.#startFresh(
        mission,
        profile,
        binding.rootRef,
        "fresh_successor_root",
        operationStartedAt,
      );
    }

    const isHot = this.#loadedByThisController.has(binding.runtime.threadId);
    let runtime = binding.runtime;
    if (!isHot) {
      const response = record(await this.#connection.request("thread/resume", {
        threadId: binding.runtime.threadId,
        model: profile.model,
        cwd: profile.cwd,
        approvalPolicy: profile.approvalPolicy,
        sandbox: profile.sandbox,
      }), "thread/resume response");
      runtime = runtimeIdentity(response, "thread/resume response");
      if (runtime.threadId !== binding.runtime.threadId || runtime.sessionId !== binding.runtime.sessionId) {
        throw new Error("Codex resumed a different root identity");
      }
      this.#loadedByThisController.add(runtime.threadId);
    }

    const goalState = await this.#reconcileGoal(runtime.threadId, mission, profile);
    const nextBinding = freezeBinding({
      ...binding,
      runtime,
      goalTokenBudget: profile.goalTokenBudget,
    });
    return this.#runTurn(
      nextBinding,
      mission.launchBrief,
      profile,
      isHot ? "hot_continuation" : "resumed_after_controller_restart",
      goalState,
      operationStartedAt,
    );
  }

  async #startFresh(
    mission: CodexRootMissionV1,
    profile: CodexRootProfileV1,
    predecessorRootRef: RunnerExternalReferencePortableV1 | null,
    disposition: "initial_root" | "fresh_successor_root",
    operationStartedAt: number,
  ): Promise<CodexRootRunResultV1> {
    const response = record(await this.#connection.request("thread/start", {
      model: profile.model,
      cwd: profile.cwd,
      runtimeWorkspaceRoots: [profile.cwd],
      approvalPolicy: profile.approvalPolicy,
      sandbox: profile.sandbox,
      ephemeral: false,
      historyMode: "paginated",
      serviceName: "stensibly-codex-root-harness",
    }), "thread/start response");
    const runtime = runtimeIdentity(response, "thread/start response");
    this.#loadedByThisController.add(runtime.threadId);
    const rootRef = rootReference(
      runtime,
      mission.responsibilityGeneration,
      this.#clock().toISOString(),
    );
    const binding = freezeBinding({
      version: CODEX_ROOT_HARNESS_V1,
      adapterId: CODEX_APP_SERVER_ADAPTER_ID,
      missionRef: mission.missionRef,
      responsibilityGeneration: mission.responsibilityGeneration,
      missionRevisionDigest: mission.revisionDigest,
      objectiveDigest: digest(mission.objective),
      profile: profile.provenance,
      runtime,
      rootRef,
      predecessorRootRef,
      goalTokenBudget: profile.goalTokenBudget,
    });
    const goalState = await this.#setAndReadGoal(
      runtime.threadId,
      mission,
      profile,
      false,
      "active",
    );
    return this.#runTurn(
      binding,
      mission.launchBrief,
      profile,
      disposition,
      goalState,
      operationStartedAt,
    );
  }

  async #reconcileGoal(
    threadId: string,
    mission: CodexRootMissionV1,
    profile: CodexRootProfileV1,
  ): Promise<GoalState> {
    const response = record(
      await this.#connection.request("thread/goal/get", { threadId }),
      "thread/goal/get response",
    );
    const goal = response.goal === null ? null : record(response.goal, "Codex thread goal");
    if (goal !== null) assertGoalBudgetCanRun(goal, profile.goalTokenBudget);
    const stale = goal === null
      || text(goal.objective, "Codex goal objective") !== mission.objective
      || nullableInteger(goal.tokenBudget, "Codex goal token budget") !== profile.goalTokenBudget;
    if (stale) {
      const preservedStatus = goal === null
        ? "paused"
        : goalStatus(goal.status);
      return this.#setAndReadGoal(
        threadId,
        mission,
        profile,
        true,
        preservedStatus,
      );
    }
    return goalState(goal, false);
  }

  async #setAndReadGoal(
    threadId: string,
    mission: CodexRootMissionV1,
    profile: CodexRootProfileV1,
    reconciled: boolean,
    status: CodexThreadGoalStatus,
  ): Promise<GoalState> {
    await this.#connection.request("thread/goal/set", {
      threadId,
      objective: mission.objective,
      status,
      tokenBudget: profile.goalTokenBudget,
    });
    const response = record(
      await this.#connection.request("thread/goal/get", { threadId }),
      "thread/goal/get response",
    );
    if (response.goal === null) throw new Error("Codex did not persist the requested thread goal");
    const goal = record(response.goal, "Codex thread goal");
    if (text(goal.objective, "Codex goal objective") !== mission.objective) {
      throw new Error("Codex persisted a different thread goal objective");
    }
    return goalState(goal, reconciled);
  }

  async #runTurn(
    binding: CodexRootBindingV1,
    currentBrief: string,
    profile: CodexRootProfileV1,
    disposition: CodexRootDispositionV1,
    beforeGoal: GoalState,
    operationStartedAt: number,
  ): Promise<CodexRootRunResultV1> {
    const cursor = this.#connection.notificationCursor();
    let turnId: string;
    if (disposition === "initial_root" || disposition === "fresh_successor_root") {
      const response = record(await this.#connection.request("turn/start", {
        threadId: binding.runtime.threadId,
        input: [{ type: "text", text: currentBrief, text_elements: [] }],
        cwd: profile.cwd,
        approvalPolicy: profile.approvalPolicy,
        sandboxPolicy: sandboxPolicy(profile.sandbox, profile.cwd, profile.networkAccess),
        model: profile.model,
        effort: profile.effort,
      }), "turn/start response");
      const startedTurn = record(response.turn, "Codex turn");
      turnId = identifier(startedTurn.id, "Codex turn ID");
    } else {
      if (beforeGoal.status === "active") {
        throw new Error(
          "Codex root goal is already active; reconcile the in-flight turn before delivering another brief",
        );
      }
      await this.#connection.request("thread/settings/update", {
        threadId: binding.runtime.threadId,
        cwd: profile.cwd,
        approvalPolicy: profile.approvalPolicy,
        sandboxPolicy: sandboxPolicy(profile.sandbox, profile.cwd, profile.networkAccess),
        model: profile.model,
        effort: profile.effort,
      });
      await this.#connection.request("thread/goal/set", {
        threadId: binding.runtime.threadId,
        status: "active",
        tokenBudget: profile.goalTokenBudget,
      });
      const started = await this.#connection.waitForNotification(
        "turn/started",
        (params) => startedTurnMatches(params, binding.runtime.threadId),
        cursor,
        this.#turnTimeoutMs,
      );
      const runtimeTurn = record(record(started.params, "turn/started params").turn, "started Codex turn");
      turnId = identifier(runtimeTurn.id, "Codex runtime turn ID");
      await this.#connection.request("turn/steer", {
        threadId: binding.runtime.threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: currentBrief, text_elements: [] }],
      });
    }
    const turnAcceptedAt = this.#clock().getTime();
    const terminalGoal = await this.#connection.waitForNotification(
      "thread/goal/updated",
      (params) => terminalGoalMatches(params, binding.runtime.threadId),
      cursor,
      this.#turnTimeoutMs,
    );
    const terminalParams = record(terminalGoal.params, "thread/goal/updated params");
    const runtimeTurnId = terminalParams.turnId === null
      ? turnId
      : identifier(terminalParams.turnId, "Codex runtime turn ID");
    const settledTurn = await this.#settleTurn(binding.runtime.threadId, runtimeTurnId, cursor);
    const turnStatus = text(settledTurn.status, "Codex turn status");
    const afterGoalResponse = record(
      await this.#connection.request("thread/goal/get", { threadId: binding.runtime.threadId }),
      "thread/goal/get response",
    );
    const afterGoal = afterGoalResponse.goal === null
      ? beforeGoal
      : goalState(record(afterGoalResponse.goal, "Codex thread goal"), beforeGoal.reconciled);
    const tokenUsage = latestTokenUsage(
      this.#connection.notificationsSince(cursor),
      binding.runtime.threadId,
      runtimeTurnId,
    );
    const finishedAt = this.#clock().getTime();
    const observation: CodexRootRunObservationV1 = deepFreeze({
      version: CODEX_ROOT_HARNESS_V1,
      disposition,
      rootRef: binding.rootRef,
      predecessorRootRef: binding.predecessorRootRef,
      threadId: binding.runtime.threadId,
      sessionId: binding.runtime.sessionId,
      turnId: runtimeTurnId,
      turnStatus,
      sandbox: profile.sandbox,
      networkAccess: profile.networkAccess,
      briefCharacters: currentBrief.length,
      handoffMs: Math.max(0, turnAcceptedAt - operationStartedAt),
      executionMs: Math.max(0, finishedAt - turnAcceptedAt),
      elapsedMs: Math.max(0, finishedAt - operationStartedAt),
      goal: afterGoal,
      tokenUsage,
    });
    return deepFreeze({ binding, observation });
  }

  async #settleTurn(
    threadId: string,
    turnId: string,
    cursor: number,
  ): Promise<Record<string, unknown>> {
    try {
      const completed = await this.#connection.waitForNotification(
        "turn/completed",
        (params) => completedTurnMatches(params, threadId, turnId),
        cursor,
        this.#settlementTimeoutMs,
      );
      return record(record(completed.params, "turn/completed params").turn, "completed Codex turn");
    } catch (error) {
      await this.#connection.request("turn/interrupt", { threadId, turnId });
      try {
        const interrupted = await this.#connection.waitForNotification(
          "turn/completed",
          (params) => completedTurnMatches(params, threadId, turnId),
          cursor,
          this.#settlementTimeoutMs,
        );
        return record(record(interrupted.params, "turn/completed params").turn, "interrupted Codex turn");
      } catch {
        throw new Error(
          `Codex goal became terminal but runtime turn ${turnId} did not settle after interrupt: ${errorMessage(error)}`,
        );
      }
    }
  }
}

interface GoalState extends CodexRootGoalObservationV1 {}

type CodexThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

function admitMission(value: CodexRootMissionV1): CodexRootMissionV1 {
  if (value.version !== CODEX_ROOT_HARNESS_V1) throw new RangeError("Codex root mission version is invalid");
  return deepFreeze({
    version: CODEX_ROOT_HARNESS_V1,
    missionRef: safeIdentifier(value.missionRef, "Mission reference", 240),
    responsibilityGeneration: nonNegativeInteger(value.responsibilityGeneration, "Responsibility generation"),
    revisionDigest: sha256Digest(value.revisionDigest, "Mission revision digest"),
    objective: safeText(value.objective, "Mission objective", 20_000),
    launchBrief: safeText(value.launchBrief, "Mission launch brief", 200_000),
  });
}

function admitProfile(value: CodexRootProfileV1): CodexRootProfileV1 {
  if (value.version !== CODEX_ROOT_HARNESS_V1) throw new RangeError("Codex root profile version is invalid");
  const provenance = runnerProfileProvenanceV1(value.provenance.profileId, value.provenance.profileVersion);
  if (provenance.profileVersion === null) throw new RangeError("Codex root profile requires an exact version");
  const effort = exact(value.effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const, "Codex effort");
  const sandbox = exact(value.sandbox, ["read-only", "workspace-write", "danger-full-access"] as const, "Codex sandbox");
  const networkAccess = boolean(value.networkAccess, "Codex network access");
  validateSandboxNetwork(sandbox, networkAccess);
  return deepFreeze({
    version: CODEX_ROOT_HARNESS_V1,
    provenance,
    model: safeIdentifier(value.model, "Codex model", 160),
    effort,
    cwd: absolutePath(value.cwd),
    sandbox,
    networkAccess,
    approvalPolicy: exact(value.approvalPolicy, ["never"] as const, "Codex approval policy"),
    goalTokenBudget: nullablePositiveInteger(value.goalTokenBudget, "Goal token budget"),
  });
}

function admitBinding(value: CodexRootBindingV1): CodexRootBindingV1 {
  if (value.version !== CODEX_ROOT_HARNESS_V1 || value.adapterId !== CODEX_APP_SERVER_ADAPTER_ID) {
    throw new RangeError("Codex root binding is incompatible");
  }
  const profile = runnerProfileProvenanceV1(value.profile.profileId, value.profile.profileVersion);
  if (profile.profileVersion === null) throw new RangeError("Codex root binding requires an exact profile version");
  const rootRef = parseRunnerExternalReferencePortableV1(value.rootRef);
  const predecessorRootRef = value.predecessorRootRef === null
    ? null
    : parseRunnerExternalReferencePortableV1(value.predecessorRootRef);
  const runtime = runtimeIdentityFromBinding(value.runtime);
  if (rootRef.adapterId !== CODEX_APP_SERVER_ADAPTER_ID || rootRef.externalId !== runtime.threadId) {
    throw new RangeError("Codex root reference does not match its runtime identity");
  }
  return freezeBinding({
    version: CODEX_ROOT_HARNESS_V1,
    adapterId: CODEX_APP_SERVER_ADAPTER_ID,
    missionRef: safeIdentifier(value.missionRef, "Mission reference", 240),
    responsibilityGeneration: nonNegativeInteger(value.responsibilityGeneration, "Responsibility generation"),
    missionRevisionDigest: sha256Digest(value.missionRevisionDigest, "Mission revision digest"),
    objectiveDigest: sha256Digest(value.objectiveDigest, "Objective digest"),
    profile,
    runtime,
    rootRef,
    predecessorRootRef,
    goalTokenBudget: nullablePositiveInteger(value.goalTokenBudget, "Goal token budget"),
  });
}

function missionMatches(binding: CodexRootBindingV1, mission: CodexRootMissionV1): boolean {
  return binding.missionRef === mission.missionRef
    && binding.responsibilityGeneration === mission.responsibilityGeneration
    && binding.missionRevisionDigest === mission.revisionDigest
    && binding.objectiveDigest === digest(mission.objective);
}

function profilesMatch(durable: RunnerProfileProvenanceV1, requested: RunnerProfileProvenanceV1): boolean {
  try {
    requireExactRunnerProfileResumeV1(durable, requested);
    return true;
  } catch {
    return false;
  }
}

function runtimeIdentity(response: Record<string, unknown>, label: string): CodexRootRuntimeIdentityV1 {
  const thread = record(response.thread, `${label} thread`);
  const threadId = identifier(thread.id, "Codex thread ID");
  const sessionId = identifier(thread.sessionId, "Codex session ID");
  if (sessionId !== threadId || thread.parentThreadId !== null || thread.forkedFromId !== null) {
    throw new Error("Codex thread is not an independent root session");
  }
  return deepFreeze({
    threadId,
    sessionId,
    isIndependentRoot: true,
    model: text(response.model, "Codex response model"),
    modelProvider: text(response.modelProvider, "Codex model provider"),
    effort: response.reasoningEffort === null ? null : text(response.reasoningEffort, "Codex effort"),
    cwd: absolutePath(response.cwd),
  });
}

function runtimeIdentityFromBinding(value: CodexRootRuntimeIdentityV1): CodexRootRuntimeIdentityV1 {
  const threadId = identifier(value.threadId, "Codex thread ID");
  const sessionId = identifier(value.sessionId, "Codex session ID");
  if (value.isIndependentRoot !== true || threadId !== sessionId) {
    throw new RangeError("Codex binding must identify an independent root session");
  }
  return deepFreeze({
    threadId,
    sessionId,
    isIndependentRoot: true,
    model: safeIdentifier(value.model, "Codex model", 160),
    modelProvider: safeIdentifier(value.modelProvider, "Codex model provider", 160),
    effort: value.effort === null ? null : safeIdentifier(value.effort, "Codex effort", 32),
    cwd: absolutePath(value.cwd),
  });
}

function rootReference(
  runtime: CodexRootRuntimeIdentityV1,
  generation: number,
  createdAt: string,
): RunnerExternalReferencePortableV1 {
  return parseRunnerExternalReferencePortableV1({
    version: 1,
    kind: "session",
    adapterId: CODEX_APP_SERVER_ADAPTER_ID,
    externalId: runtime.threadId,
    digest: digest({ threadId: runtime.threadId, sessionId: runtime.sessionId }),
    uri: null,
    generation,
    createdAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function freezeBinding(value: CodexRootBindingV1): CodexRootBindingV1 {
  return deepFreeze(value);
}

function goalState(goal: Record<string, unknown>, reconciled: boolean): GoalState {
  return deepFreeze({
    objectiveDigest: digest(text(goal.objective, "Codex goal objective")),
    status: safeIdentifier(goal.status, "Codex goal status", 40),
    tokenBudget: nullableInteger(goal.tokenBudget, "Codex goal token budget"),
    tokensUsed: nonNegativeInteger(goal.tokensUsed, "Codex goal tokens used"),
    timeUsedSeconds: nonNegativeNumber(goal.timeUsedSeconds, "Codex goal time used"),
    reconciled,
  });
}

function latestTokenUsage(
  notifications: readonly CodexAppServerNotification[],
  threadId: string,
  turnId: string,
): CodexRootTokenUsageV1 | null {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (!notification || notification.method !== "thread/tokenUsage/updated") continue;
    if (!isRecord(notification.params)) continue;
    if (notification.params.threadId !== threadId || notification.params.turnId !== turnId) continue;
    const usage = record(notification.params.tokenUsage, "Codex token usage");
    const total = record(usage.total, "Codex total token usage");
    return deepFreeze({
      totalTokens: nonNegativeInteger(total.totalTokens, "Total tokens"),
      inputTokens: nonNegativeInteger(total.inputTokens, "Input tokens"),
      cachedInputTokens: nonNegativeInteger(total.cachedInputTokens, "Cached input tokens"),
      outputTokens: nonNegativeInteger(total.outputTokens, "Output tokens"),
      reasoningOutputTokens: nonNegativeInteger(total.reasoningOutputTokens, "Reasoning output tokens"),
      modelContextWindow: usage.modelContextWindow === null
        ? null
        : positiveInteger(usage.modelContextWindow, "Model context window"),
    });
  }
  return null;
}

function completedTurnMatches(params: unknown, threadId: string, turnId: string): boolean {
  if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.turn)) return false;
  return params.turn.id === turnId;
}

function startedTurnMatches(params: unknown, threadId: string): boolean {
  return isRecord(params) && params.threadId === threadId && isRecord(params.turn);
}

function terminalGoalMatches(params: unknown, threadId: string): boolean {
  if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.goal)) return false;
  return params.goal.status !== "active";
}

function goalStatus(value: unknown): CodexThreadGoalStatus {
  return exact(
    value,
    ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const,
    "Codex goal status",
  );
}

function assertGoalBudgetCanRun(goal: Record<string, unknown>, requestedBudget: number | null): void {
  const status = safeIdentifier(goal.status, "Codex goal status", 40);
  const tokensUsed = nonNegativeInteger(goal.tokensUsed, "Codex goal tokens used");
  if (status === "budgetLimited" && requestedBudget !== null && requestedBudget <= tokensUsed) {
    throw new Error(
      `Codex root goal budget is exhausted at ${tokensUsed} tokens; durable goalTokenBudget must increase before continuation`,
    );
  }
}

function sandboxPolicy(mode: CodexSandboxMode, cwd: string, networkAccess: boolean): unknown {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function codexRootProfileVersion(input: {
  readonly model: string;
  readonly effort: CodexReasoningEffort;
  readonly sandbox: CodexSandboxMode;
  readonly networkAccess: boolean;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly cwd: string;
  readonly appServerVersion: string;
}): string {
  const networkAccess = boolean(input.networkAccess, "Codex network access");
  validateSandboxNetwork(input.sandbox, networkAccess);
  return `sha256-${digest({
    model: input.model,
    effort: input.effort,
    sandbox: input.sandbox,
    networkAccess,
    approvalPolicy: input.approvalPolicy,
    cwd: absolutePath(input.cwd),
    appServerVersion: safeIdentifier(input.appServerVersion, "App-server version", 80),
  }).slice("sha256:".length)}`;
}

export function codexRootMissionRevision(input: unknown): `sha256:${string}` {
  return digest(input);
}

/**
 * Converts native child-capacity failures into bounded local backpressure.
 * It intentionally creates neither work nor a durable retry record.
 */
export function codexChildSlotBackpressureV1(input: {
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly error: unknown;
}): CodexRootBackpressureV1 | null {
  const message = errorText(input.error);
  if (!/(?:max(?:imum)? concurrent (?:agent )?threads?|thread limit|no (?:available )?(?:child|agent|subagent) slots?|(?:child|subagent)[ -]slot (?:capacity|exhausted)|subagent capacity)/iu.test(message)) {
    return null;
  }
  return deepFreeze({
    version: CODEX_ROOT_HARNESS_V1,
    kind: "native_child_slot_capacity",
    scope: "codex_session_tree",
    retryable: true,
    threadId: identifier(input.threadId, "Codex thread ID"),
    turnId: input.turnId === undefined || input.turnId === null
      ? null
      : identifier(input.turnId, "Codex turn ID"),
    detailDigest: digest(message),
  });
}

function digest(value: unknown): `sha256:${string}` {
  const encoded = typeof value === "string" ? value : stableJson(value);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  return safeText(value, label, 200_000);
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000\u007f]/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string, maximum: number): string {
  const output = safeText(value, label, maximum).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@+\-=]*$/u.test(output)) throw new RangeError(`${label} is invalid`);
  return output;
}

function identifier(value: unknown, label: string): string {
  return safeIdentifier(value, label, 240);
}

function sha256Digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new RangeError(`${label} is invalid`);
  return value as `sha256:${string}`;
}

function absolutePath(value: unknown): string {
  const output = safeText(value, "Codex working directory", 4_096).trim();
  if (!output.startsWith("/")) throw new RangeError("Codex working directory must be absolute");
  return output;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${label} must be non-negative`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be positive`);
  return value as number;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveInteger(value, label);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}

function exact<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new RangeError(`${label} is invalid`);
  return value as Values[number];
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} must be boolean`);
  return value;
}

function validateSandboxNetwork(sandbox: CodexSandboxMode, networkAccess: boolean): void {
  if (sandbox === "danger-full-access" && !networkAccess) {
    throw new RangeError("danger-full-access cannot truthfully claim networkAccess false");
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return safeText(error.message, "Codex error", 20_000);
  if (isRecord(error) && typeof error.message === "string") {
    return safeText(error.message, "Codex error", 20_000);
  }
  return safeText(String(error), "Codex error", 20_000);
}
