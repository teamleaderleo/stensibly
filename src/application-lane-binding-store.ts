import { compareCodeUnits, stableJson } from "./canonical-json.js";
import {
  buildApplicationWorkBindingV1,
  type ApplicationWorkBindingV1,
} from "./application-lane-binding.js";

export const PROJECT_APPLICATION_LANE_BINDING_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_PROJECT_APPLICATION_LANE_BINDING_LIMIT = 100;
export const MAX_PROJECT_APPLICATION_LANE_BINDING_LIMIT = 500;

export interface BindApplicationLaneInput {
  binding: unknown;
  idempotencyKey: string;
}

export interface RetireApplicationLaneBindingInput {
  project: string;
  bindingId: string;
  expectedGeneration: number;
  retiredAt: string;
  idempotencyKey: string;
}

export interface ProjectApplicationLaneBindingSnapshotV1 {
  readonly version: 1;
  readonly project: string;
  readonly bindings: readonly ApplicationWorkBindingV1[];
  readonly truncated: boolean;
}

export interface ApplicationLaneBindingStore {
  bindApplicationLane(input: BindApplicationLaneInput): Promise<ApplicationWorkBindingV1>;
  getApplicationLaneBinding(
    project: string,
    bindingId: string,
  ): Promise<ApplicationWorkBindingV1 | null>;
  listCurrentApplicationLaneBindings(
    project: string,
    itemId: string,
  ): Promise<readonly ApplicationWorkBindingV1[]>;
  listProjectCurrentApplicationLaneBindings(
    project: string,
    limit?: number,
  ): Promise<ProjectApplicationLaneBindingSnapshotV1>;
  listApplicationLaneBindingHistory(
    project: string,
    bindingId: string,
  ): Promise<readonly ApplicationWorkBindingV1[]>;
  retireApplicationLaneBinding(
    input: RetireApplicationLaneBindingInput,
  ): Promise<ApplicationWorkBindingV1>;
}

export interface AdmittedBindApplicationLaneCommand {
  binding: ApplicationWorkBindingV1;
  idempotencyKey: string;
  requestJson: string;
  bindingInputJson: string;
}

export interface AdmittedRetireApplicationLaneBindingCommand {
  project: string;
  bindingId: string;
  expectedGeneration: number;
  retiredAt: string;
  idempotencyKey: string;
  requestJson: string;
}

export class ApplicationLaneBindingConflictError extends Error {
  readonly code = "application_lane_binding_conflict";

  constructor(message = "Application lane binding conflict") {
    super(message);
    this.name = "ApplicationLaneBindingConflictError";
  }
}

export class ApplicationLaneBindingNotFoundError extends Error {
  readonly code = "application_lane_binding_not_found";

  constructor(message = "Application lane binding not found") {
    super(message);
    this.name = "ApplicationLaneBindingNotFoundError";
  }
}

export class ApplicationLaneBindingStorageError extends Error {
  readonly code = "application_lane_binding_storage_failed";

  constructor(message = "Application lane binding storage failed") {
    super(message);
    this.name = "ApplicationLaneBindingStorageError";
  }
}

export function admitBindApplicationLaneCommand(
  input: BindApplicationLaneInput,
): AdmittedBindApplicationLaneCommand {
  const binding = buildApplicationWorkBindingV1(input.binding);
  if (binding.generation !== 1) {
    throw new RangeError("A new application lane binding must start at generation 1");
  }
  if (binding.retiredAt !== null) {
    throw new RangeError("A new application lane binding must be active");
  }
  const idempotencyKey = exactText(
    input.idempotencyKey,
    "Application lane binding idempotency key",
    240,
  );
  const bindingInputJson = canonicalApplicationWorkBindingInputJson(binding);
  const requestJson = stableJson({
    operation: "bind",
    binding: JSON.parse(bindingInputJson),
  });
  return Object.freeze({
    binding,
    idempotencyKey,
    requestJson,
    bindingInputJson,
  });
}

export function admitRetireApplicationLaneBindingCommand(
  input: RetireApplicationLaneBindingInput,
): AdmittedRetireApplicationLaneBindingCommand {
  const project = exactProject(input.project);
  const bindingId = exactIdentifier(input.bindingId, "Application lane binding ID");
  const expectedGeneration = positiveInteger(
    input.expectedGeneration,
    "Expected application lane binding generation",
  );
  const retiredAt = exactTimestamp(input.retiredAt, "Application lane binding retirement time");
  const idempotencyKey = exactText(
    input.idempotencyKey,
    "Application lane binding idempotency key",
    240,
  );
  const requestJson = stableJson({
    operation: "retire",
    project,
    bindingId,
    expectedGeneration,
    retiredAt,
  });
  return Object.freeze({
    project,
    bindingId,
    expectedGeneration,
    retiredAt,
    idempotencyKey,
    requestJson,
  });
}

export function retireApplicationWorkBinding(
  current: ApplicationWorkBindingV1,
  command: AdmittedRetireApplicationLaneBindingCommand,
): ApplicationWorkBindingV1 {
  if (current.project !== command.project || current.id !== command.bindingId) {
    throw new ApplicationLaneBindingConflictError(
      "Application lane retirement target does not match the current binding",
    );
  }
  if (current.retiredAt !== null) {
    throw new ApplicationLaneBindingConflictError(
      `Application lane binding ${current.id} is already retired`,
    );
  }
  if (current.generation !== command.expectedGeneration) {
    throw new ApplicationLaneBindingConflictError(
      `Application lane binding ${current.id} generation changed`,
    );
  }
  if (Date.parse(command.retiredAt) <= Date.parse(current.createdAt)) {
    throw new RangeError("Application lane binding retirement must follow creation");
  }
  return buildApplicationWorkBindingV1({
    version: 1,
    id: current.id,
    generation: current.generation + 1,
    project: current.project,
    itemId: current.itemId,
    provider: "elatura",
    laneRef: current.laneRef,
    laneGeneration: current.laneGeneration,
    capabilities: current.capabilities,
    createdAt: current.createdAt,
    retiredAt: command.retiredAt,
  });
}

export function compileProjectApplicationLaneBindingSnapshotV1(
  projectInput: string,
  bindingsInput: readonly unknown[],
  limitInput?: number,
): ProjectApplicationLaneBindingSnapshotV1 {
  const project = exactProject(projectInput);
  const limit = exactApplicationLaneBindingProjectReadLimit(limitInput);
  if (!Array.isArray(bindingsInput) || bindingsInput.length > limit + 1) {
    throw new ApplicationLaneBindingStorageError();
  }
  const bindings = bindingsInput.map((value) => {
    let binding: ApplicationWorkBindingV1;
    try {
      binding = buildApplicationWorkBindingV1(value);
    } catch {
      throw new ApplicationLaneBindingStorageError();
    }
    if (binding.project !== project || binding.retiredAt !== null) {
      throw new ApplicationLaneBindingStorageError();
    }
    return binding;
  });
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.id)) throw new ApplicationLaneBindingStorageError();
    seen.add(binding.id);
  }
  bindings.sort((left, right) =>
    compareCodeUnits(left.itemId, right.itemId)
    || compareCodeUnits(left.id, right.id)
    || left.generation - right.generation
  );
  const truncated = bindings.length > limit;
  return Object.freeze({
    version: PROJECT_APPLICATION_LANE_BINDING_SNAPSHOT_VERSION,
    project,
    bindings: Object.freeze(bindings.slice(0, limit)),
    truncated,
  });
}

export function exactApplicationLaneBindingProjectReadLimit(value?: number): number {
  if (value === undefined) return DEFAULT_PROJECT_APPLICATION_LANE_BINDING_LIMIT;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_PROJECT_APPLICATION_LANE_BINDING_LIMIT
  ) {
    throw new RangeError(
      `Application lane binding project read limit must be a positive safe integer up to ${MAX_PROJECT_APPLICATION_LANE_BINDING_LIMIT}`,
    );
  }
  return value;
}

export function canonicalApplicationWorkBindingInputJson(
  binding: ApplicationWorkBindingV1,
): string {
  return stableJson({
    version: 1,
    id: binding.id,
    generation: binding.generation,
    project: binding.project,
    itemId: binding.itemId,
    provider: "elatura",
    laneRef: binding.laneRef,
    laneGeneration: binding.laneGeneration,
    capabilities: binding.capabilities,
    createdAt: binding.createdAt,
    retiredAt: binding.retiredAt,
  });
}

export function parseApplicationWorkBindingInputJson(
  value: string,
): ApplicationWorkBindingV1 {
  const text = exactText(value, "Application lane binding JSON", 32_768);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApplicationLaneBindingStorageError();
  }
  try {
    const binding = buildApplicationWorkBindingV1(parsed);
    if (canonicalApplicationWorkBindingInputJson(binding) !== text) {
      throw new ApplicationLaneBindingStorageError();
    }
    return binding;
  } catch (error) {
    if (error instanceof ApplicationLaneBindingStorageError) throw error;
    throw new ApplicationLaneBindingStorageError();
  }
}

export function exactApplicationLaneBindingProject(value: string): string {
  return exactProject(value);
}

export function exactApplicationLaneBindingId(value: string): string {
  return exactIdentifier(value, "Application lane binding ID");
}

export function exactApplicationLaneBindingItemId(value: string): string {
  return exactIdentifier(value, "Application lane binding item ID");
}

export function exactApplicationLaneBindingIdempotencyKey(value: string): string {
  return exactText(value, "Application lane binding idempotency key", 240);
}

function exactProject(value: string): string {
  const text = exactText(value, "Application lane binding project", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(text)) {
    throw new RangeError("Application lane binding project must be a lowercase slug");
  }
  return text;
}

function exactIdentifier(value: string, label: string): string {
  const text = exactText(value, label, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(text)) {
    throw new RangeError(`${label} is invalid`);
  }
  return text;
}

function exactTimestamp(value: string, label: string): string {
  const text = exactText(value, label, 80);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new RangeError(`${label} is invalid`);
  return new Date(millis).toISOString();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function exactText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}
