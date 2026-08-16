import { stableJson } from "./canonical-json.js";
import {
  admitOrchestratorActivityObservation,
} from "./orchestrator-activity-observation-admission.js";
import type {
  OrchestratorActivityObservation,
} from "./orchestrator-activity-observation.js";

export interface DurableProjectActivityOrchestratorV1 {
  readonly orchestrator: readonly OrchestratorActivityObservation[];
  readonly orchestratorTruncated: boolean;
}

const maximumObservations = 256;
const maximumObservationJsonLength = 64 * 1024;

/**
 * Admits the exact read-only envelope returned by
 * `orchestratorActivity:listObservations` for use by `project-activity/v1`.
 *
 * This is a transport adapter only. It creates no persistence, authority,
 * causal joins, summaries, or activity semantics of its own.
 */
export function admitDurableProjectActivityOrchestratorV1(
  value: unknown,
): DurableProjectActivityOrchestratorV1 {
  const envelope = fixedRecord(
    value,
    "Durable project activity orchestrator envelope",
  );
  const observationsValue = dataField(
    envelope,
    "observations",
    "Durable project activity orchestrator observations",
  );
  const truncated = dataField(
    envelope,
    "truncated",
    "Durable project activity orchestrator truncation",
  );
  if (typeof truncated !== "boolean") {
    throw new TypeError("Durable project activity orchestrator truncation must be boolean");
  }

  const observations = ordinaryArray(
    observationsValue,
    "Durable project activity orchestrator observations",
  );
  const admitted: OrchestratorActivityObservation[] = [];
  let previousAppendOrder = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const rowValue = arrayEntry(
      observations.value,
      index,
      "Durable project activity orchestrator observations",
    );
    const row = fixedRecord(
      rowValue,
      `Durable project activity orchestrator row ${index + 1}`,
    );
    const appendOrder = dataField(
      row,
      "appendOrder",
      `Durable project activity orchestrator row ${index + 1} append order`,
    );
    if (!Number.isSafeInteger(appendOrder) || (appendOrder as number) < 1) {
      throw new RangeError("Durable project activity append order is invalid");
    }
    if ((appendOrder as number) <= previousAppendOrder) {
      throw new RangeError("Durable project activity append order must be strictly increasing");
    }
    previousAppendOrder = appendOrder as number;

    const observationJson = dataField(
      row,
      "observationJson",
      `Durable project activity orchestrator row ${index + 1} observation JSON`,
    );
    if (
      typeof observationJson !== "string"
      || observationJson.length < 2
      || observationJson.length > maximumObservationJsonLength
    ) {
      throw new RangeError("Durable project activity observation JSON is invalid");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(observationJson);
    } catch {
      throw new TypeError("Durable project activity observation JSON is invalid");
    }
    const observation = admitOrchestratorActivityObservation(parsed);
    if (stableJson(observation) !== observationJson) {
      throw new RangeError("Durable project activity observation JSON is not canonical");
    }
    admitted.push(observation);
  }

  return Object.freeze({
    orchestrator: Object.freeze(admitted),
    orchestratorTruncated: truncated,
  });
}

function fixedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
  if (isArray) throw new TypeError(`${label} must be an object`);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain or null prototype`);
  }
  return value as Record<string, unknown>;
}

function dataField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an enumerable data property`);
  }
  return descriptor.value;
}

function ordinaryArray(
  value: unknown,
  label: string,
): Readonly<{ value: unknown[]; length: number }> {
  let isArray: boolean;
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = isArray && value !== null ? Object.getPrototypeOf(value) : null;
    lengthDescriptor = isArray && value !== null
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
  if (!isArray || prototype !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array`);
  }
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumObservations
  ) {
    throw new RangeError(`${label} exceeded its bound`);
  }
  return Object.freeze({
    value: value as unknown[],
    length: lengthDescriptor.value as number,
  });
}

function arrayEntry(array: unknown[], index: number, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`${label} entries must be enumerable data properties`);
  }
  return descriptor.value;
}
