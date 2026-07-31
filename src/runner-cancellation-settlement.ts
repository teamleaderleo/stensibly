import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  AuthoritativeSettlementController,
  createResourceSettlementReceipt,
  evaluateResourceGenerationAdvance,
  type ResourceGenerationAdvanceDecision,
  type ResourceSettlementReceipt,
} from "./resource-settlement.js";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerExternalReferenceV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerExternalReferenceV1,
} from "./runner-adapter-v1.js";

export const RUNNER_CANCELLATION_SETTLEMENT_V1 = 1 as const;

export interface RunnerCancellationSettlementScopeV1 {
  version: typeof RUNNER_CANCELLATION_SETTLEMENT_V1;
  workspace: string;
  project: string;
}

export type RunnerCancellationSettlementOutcomeV1 =
  | "cancellation_observed"
  | "adapter_failure";

export interface RunnerCancellationSettlementResultV1 {
  version: typeof RUNNER_CANCELLATION_SETTLEMENT_V1;
  workspace: string;
  project: string;
  commandId: string;
  commandFingerprint: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  requestedAt: string;
  observedAt: string;
  outcome: RunnerCancellationSettlementOutcomeV1;
  cancellation: RunnerCancellationObservationV1 | null;
  settlement: ResourceSettlementReceipt;
  generationAdvance: ResourceGenerationAdvanceDecision;
  containsPrivateContent: false;
  containsCredentials: false;
  resultFingerprint: string;
}

export type RunnerCancellationSettlementClock = () => string;

const resultPolicyVersion = "runner-cancellation-settlement-v2";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const slugPattern = /^[a-z0-9][a-z0-9_-]*$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const realisticCredentialPattern = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;
const externalReferenceKeys = [
  "version",
  "kind",
  "adapterId",
  "externalId",
  "digest",
  "uri",
  "generation",
  "createdAt",
  "accessClass",
  "containsPrivateContent",
  "containsCredentials",
] as const;

export class RunnerCancellationSettlementCoordinatorV1 {
  readonly #adapter: RunnerAdapterV1;
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #scope: RunnerCancellationSettlementScopeV1;
  readonly #command: RunnerCancellationCommandV1;
  readonly #commandFingerprint: string;
  readonly #clock: RunnerCancellationSettlementClock;
  readonly #controller =
    new AuthoritativeSettlementController<RunnerCancellationSettlementResultV1>();

  constructor(
    adapterValue: RunnerAdapterV1,
    scopeValue: RunnerCancellationSettlementScopeV1,
    commandValue: RunnerCancellationCommandV1,
    clock: RunnerCancellationSettlementClock = () => new Date().toISOString(),
  ) {
    this.#adapter = adapterPort(adapterValue);
    this.#descriptor = parseRunnerAdapterDescriptorV1(this.#adapter.describe());
    if (this.#descriptor.cancellationMode === "unsupported") {
      throw new RangeError("Runner adapter does not support cancellation");
    }
    this.#scope = parseScope(scopeValue);
    this.#command = parseCancellationCommand(commandValue, this.#descriptor);
    this.#commandFingerprint = fingerprintCancellationCommand(this.#command);
    if (typeof clock !== "function") {
      throw new RangeError("Runner cancellation settlement clock must be a function");
    }
    this.#clock = clock;
  }

  get phase(): "open" | "closing" | "settled_success" | "settled_failure" {
    return this.#controller.phase;
  }

  get admissionOpen(): boolean {
    return this.#controller.admissionOpen;
  }

  request(signal?: AbortSignal): Promise<RunnerCancellationSettlementResultV1> {
    if (this.#controller.admissionOpen) {
      this.#controller.start(() => this.#execute());
    }
    return this.#controller.wait(signal);
  }

  async #execute(): Promise<RunnerCancellationSettlementResultV1> {
    const execution = resolveExecutionAuthority(
      this.#clock,
      this.#command.requestedAt,
      this.#command.authority.expiresAt,
    );
    if (!execution.allowed) {
      return this.#buildResult("adapter_failure", null, execution.observedAt);
    }

    let outcome: RunnerCancellationSettlementOutcomeV1 = "adapter_failure";
    let cancellation: RunnerCancellationObservationV1 | null = null;
    try {
      const returned = await this.#adapter.requestCancellation(this.#command);
      cancellation = parseCancellationObservation(
        returned,
        this.#command,
        this.#descriptor,
      );
      if (cancellation.observedAt < execution.observedAt) {
        throw new RangeError(
          "Runner cancellation observation predates adapter execution",
        );
      }
      outcome = "cancellation_observed";
    } catch {
      cancellation = null;
      outcome = "adapter_failure";
    }

    const timing = resolveSettlementTime(
      this.#clock,
      this.#command.requestedAt,
      execution.observedAt,
      cancellation?.observedAt ?? null,
    );
    if (timing.failed) {
      cancellation = null;
      outcome = "adapter_failure";
    }
    return this.#buildResult(outcome, cancellation, timing.observedAt);
  }

  #buildResult(
    outcome: RunnerCancellationSettlementOutcomeV1,
    cancellation: RunnerCancellationObservationV1 | null,
    observedAt: string,
  ): RunnerCancellationSettlementResultV1 {
    const settlement = createResourceSettlementReceipt({
      workspace: this.#scope.workspace,
      project: this.#scope.project,
      resourceId: `run:${this.#command.runId}`,
      resourceKind: "runner_adapter",
      generation: this.#command.runGeneration,
      operationRef: this.#commandFingerprint,
      policyVersion: resultPolicyVersion,
      failureMode: "continue_through_error",
      admissionState: "closed",
      disposition: "reconciliation_hold",
      openedAt: this.#command.requestedAt,
      closingStartedAt: this.#command.requestedAt,
      terminalAt: observedAt,
      observedAt,
      owners: [{
        id: `${this.#command.adapterId}:${this.#command.profileId}`,
        kind: "worker",
        generation: this.#command.runGeneration,
        attempted: true,
        state: "reconciliation_required",
        attemptedAt: this.#command.requestedAt,
        settledAt: observedAt,
        failureClass: "unknown_outcome",
        reconciliationRequired: true,
        canPublishLate: true,
        outputFingerprint: cancellation?.reference?.digest ?? null,
        publicationFenceFingerprint: null,
      }],
    });
    const generationAdvance = evaluateResourceGenerationAdvance(
      settlement,
      this.#command.runGeneration + 1,
    );
    if (generationAdvance.allowed) {
      throw new Error(
        "Runner cancellation settlement unexpectedly allowed generation advance",
      );
    }

    const withoutFingerprint = {
      version: RUNNER_CANCELLATION_SETTLEMENT_V1,
      workspace: this.#scope.workspace,
      project: this.#scope.project,
      commandId: this.#command.commandId,
      commandFingerprint: this.#commandFingerprint,
      adapterId: this.#command.adapterId,
      adapterVersion: this.#command.adapterVersion,
      profileId: this.#command.profileId,
      runId: this.#command.runId,
      runGeneration: this.#command.runGeneration,
      leaseGeneration: this.#command.leaseGeneration,
      requestedAt: this.#command.requestedAt,
      observedAt,
      outcome,
      cancellation,
      settlement,
      generationAdvance,
      containsPrivateContent: false as const,
      containsCredentials: false as const,
    };
    return deepFreeze({
      ...withoutFingerprint,
      resultFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
    });
  }
}

function adapterPort(value: RunnerAdapterV1): RunnerAdapterV1 {
  if (
    !value
    || typeof value !== "object"
    || typeof value.describe !== "function"
    || typeof value.requestCancellation !== "function"
  ) {
    throw new RangeError("Runner cancellation settlement requires an adapter port");
  }
  return value;
}

function parseScope(value: unknown): RunnerCancellationSettlementScopeV1 {
  const input = exactRecord(value, "Runner cancellation settlement scope", [
    "version",
    "workspace",
    "project",
  ]);
  if (input.version !== RUNNER_CANCELLATION_SETTLEMENT_V1) {
    throw new RangeError(
      `Runner cancellation settlement scope version must be ${RUNNER_CANCELLATION_SETTLEMENT_V1}`,
    );
  }
  return deepFreeze({
    version: RUNNER_CANCELLATION_SETTLEMENT_V1,
    workspace: boundedSlug(input.workspace, "Runner cancellation workspace", 80),
    project: boundedSlug(input.project, "Runner cancellation project", 80),
  });
}

function parseCancellationCommand(
  value: unknown,
  descriptor: RunnerAdapterDescriptorV1,
): RunnerCancellationCommandV1 {
  const input = exactRecord(value, "Runner cancellation command", [
    "version",
    "commandId",
    "adapterId",
    "adapterVersion",
    "profileId",
    "runId",
    "runGeneration",
    "leaseGeneration",
    "authority",
    "requestedAt",
    "reason",
  ]);
  if (input.version !== RUNNER_ADAPTER_V1) {
    throw new RangeError(`Runner cancellation command version must be ${RUNNER_ADAPTER_V1}`);
  }
  const commandId = boundedIdentifier(input.commandId, "Runner cancellation command ID", 160);
  const adapterId = boundedIdentifier(input.adapterId, "Runner cancellation adapter ID", 80);
  const adapterVersion = boundedText(
    input.adapterVersion,
    "Runner cancellation adapter version",
    160,
  );
  const profileId = boundedIdentifier(input.profileId, "Runner cancellation profile ID", 79);
  if (`${adapterId}:${profileId}`.length > 160) {
    throw new RangeError("Runner cancellation owner identity is too long");
  }
  const runId = boundedIdentifier(input.runId, "Runner cancellation run ID", 156);
  const runGeneration = positiveInteger(
    input.runGeneration,
    "Runner cancellation run generation",
  );
  const leaseGeneration = positiveInteger(
    input.leaseGeneration,
    "Runner cancellation lease generation",
  );
  const requestedAt = canonicalTimestamp(
    input.requestedAt,
    "Runner cancellation request time",
  );
  const authorityInput = exactRecord(input.authority, "Runner cancellation authority", [
    "resource",
    "holderId",
    "generation",
    "expiresAt",
  ]);
  const resource = boundedIdentifier(
    authorityInput.resource,
    "Runner cancellation authority resource",
    160,
  ) as `run:${string}`;
  const authority: RunnerCancellationCommandV1["authority"] = deepFreeze({
    resource,
    holderId: boundedIdentifier(
      authorityInput.holderId,
      "Runner cancellation authority holder",
      160,
    ),
    generation: positiveInteger(
      authorityInput.generation,
      "Runner cancellation authority generation",
    ),
    expiresAt: canonicalTimestamp(
      authorityInput.expiresAt,
      "Runner cancellation authority expiry",
    ),
  });
  if (authority.resource !== `run:${runId}`) {
    throw new RangeError("Runner cancellation authority resource does not match run");
  }
  if (authority.generation !== leaseGeneration) {
    throw new RangeError("Runner cancellation authority generation does not match lease");
  }
  if (authority.expiresAt <= requestedAt) {
    throw new RangeError("Runner cancellation authority is expired at request time");
  }
  if (adapterId !== descriptor.adapterId) {
    throw new RangeError("Runner cancellation adapter does not match descriptor");
  }
  if (adapterVersion !== descriptor.adapterVersion) {
    throw new RangeError("Runner cancellation adapter version does not match descriptor");
  }
  if (!descriptor.profiles.some((entry) => entry.id === profileId)) {
    throw new RangeError("Runner cancellation profile is absent from descriptor");
  }
  return deepFreeze({
    version: RUNNER_ADAPTER_V1,
    commandId,
    adapterId,
    adapterVersion,
    profileId,
    runId,
    runGeneration,
    leaseGeneration,
    authority,
    requestedAt,
    reason: boundedText(input.reason, "Runner cancellation reason", 2_000),
  });
}

function parseCancellationObservation(
  value: unknown,
  command: RunnerCancellationCommandV1,
  descriptor: RunnerAdapterDescriptorV1,
): RunnerCancellationObservationV1 {
  const input = exactRecord(value, "Runner cancellation observation", [
    "version",
    "commandId",
    "adapterId",
    "adapterVersion",
    "profileId",
    "runId",
    "runGeneration",
    "leaseGeneration",
    "observedAt",
    "requestAccepted",
    "deliveryKnown",
    "remoteSettlementKnown",
    "reference",
  ]);
  if (input.version !== RUNNER_ADAPTER_V1) {
    throw new RangeError(
      `Runner cancellation observation version must be ${RUNNER_ADAPTER_V1}`,
    );
  }
  const reference = input.reference === null
    ? null
    : parseRunnerExternalReferenceV1(
      exactRecord(input.reference, "Runner cancellation reference", externalReferenceKeys),
    );
  const observation: RunnerCancellationObservationV1 = deepFreeze({
    version: RUNNER_ADAPTER_V1,
    commandId: boundedIdentifier(
      input.commandId,
      "Runner cancellation observation command ID",
      160,
    ),
    adapterId: boundedIdentifier(
      input.adapterId,
      "Runner cancellation observation adapter ID",
      80,
    ),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner cancellation observation adapter version",
      160,
    ),
    profileId: boundedIdentifier(
      input.profileId,
      "Runner cancellation observation profile ID",
      79,
    ),
    runId: boundedIdentifier(
      input.runId,
      "Runner cancellation observation run ID",
      156,
    ),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Runner cancellation observation run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner cancellation observation lease generation",
    ),
    observedAt: canonicalTimestamp(
      input.observedAt,
      "Runner cancellation observation time",
    ),
    requestAccepted: booleanValue(
      input.requestAccepted,
      "Runner cancellation request-accepted flag",
    ),
    deliveryKnown: booleanValue(
      input.deliveryKnown,
      "Runner cancellation delivery-known flag",
    ),
    remoteSettlementKnown: false,
    reference,
  });
  if (input.remoteSettlementKnown !== false) {
    throw new RangeError(
      "Runner cancellation observation cannot claim remote settlement in v1",
    );
  }
  if (observation.deliveryKnown && !observation.requestAccepted) {
    throw new RangeError(
      "Runner cancellation delivery cannot be known when the request was not accepted",
    );
  }
  if (
    observation.commandId !== command.commandId
    || observation.adapterId !== command.adapterId
    || observation.adapterVersion !== command.adapterVersion
    || observation.profileId !== command.profileId
    || observation.runId !== command.runId
    || observation.runGeneration !== command.runGeneration
    || observation.leaseGeneration !== command.leaseGeneration
  ) {
    throw new RangeError("Runner cancellation observation does not match command");
  }
  if (observation.adapterId !== descriptor.adapterId) {
    throw new RangeError("Runner cancellation observation does not match descriptor");
  }
  if (observation.observedAt < command.requestedAt) {
    throw new RangeError("Runner cancellation observation predates its request");
  }
  if (reference !== null) {
    if (reference.adapterId !== descriptor.adapterId) {
      throw new RangeError("Runner cancellation reference adapter does not match descriptor");
    }
    if (
      reference.generation !== null
      && reference.generation !== command.runGeneration
    ) {
      throw new RangeError("Runner cancellation reference generation does not match run");
    }
    if (reference.createdAt > observation.observedAt) {
      throw new RangeError(
        "Runner cancellation reference was created after its observation",
      );
    }
  }
  return observation;
}

function resolveExecutionAuthority(
  clock: RunnerCancellationSettlementClock,
  requestedAt: string,
  expiresAt: string,
): { observedAt: string; allowed: boolean } {
  let value: unknown;
  try {
    value = clock();
  } catch {
    return { observedAt: requestedAt, allowed: false };
  }
  let observedAt: string;
  try {
    observedAt = canonicalTimestamp(
      value,
      "Runner cancellation execution time",
    );
  } catch {
    return { observedAt: requestedAt, allowed: false };
  }
  if (observedAt < requestedAt || observedAt >= expiresAt) {
    return { observedAt: requestedAt, allowed: false };
  }
  return { observedAt, allowed: true };
}

function resolveSettlementTime(
  clock: RunnerCancellationSettlementClock,
  requestedAt: string,
  executionObservedAt: string,
  cancellationObservedAt: string | null,
): { observedAt: string; failed: boolean } {
  let value: unknown;
  try {
    value = clock();
  } catch {
    return { observedAt: requestedAt, failed: true };
  }
  let observedAt: string;
  try {
    observedAt = canonicalTimestamp(
      value,
      "Runner cancellation settlement observation time",
    );
  } catch {
    return { observedAt: requestedAt, failed: true };
  }
  const minimum = [
    requestedAt,
    executionObservedAt,
    cancellationObservedAt,
  ].filter((entry): entry is string => entry !== null).sort().at(-1)!;
  if (observedAt < minimum) {
    return { observedAt: requestedAt, failed: true };
  }
  return { observedAt, failed: false };
}

function fingerprintCancellationCommand(
  command: RunnerCancellationCommandV1,
): string {
  return fingerprintCanonicalRequest({
    version: command.version,
    commandId: command.commandId,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    authority: {
      resource: command.authority.resource,
      holderId: command.authority.holderId,
      generation: command.authority.generation,
      expiresAt: command.authority.expiresAt,
    },
    requestedAt: command.requestedAt,
    reason: command.reason,
  });
}

function exactRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new RangeError(`${label} cannot contain symbol fields`);
  }
  const allowed = new Set(allowedKeys);
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    if (!allowed.has(key)) {
      throw new RangeError(`${label} has unknown field ${key}`);
    }
    const descriptor = descriptors[key];
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw new RangeError(`${label} must contain only enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (!(key in output)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return output;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !identifierPattern.test(value)
    || unsafeTextPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedSlug(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || value !== value.toLowerCase()
    || !slugPattern.test(value)
    || unsafeTextPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} must be a bounded lowercase slug`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || value !== value.trim()
    || unsafeTextPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new RangeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`${label} must be boolean`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
