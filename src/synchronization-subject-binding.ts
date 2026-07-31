import { sha256, stableJson } from "./canonical-json.js";
import {
  compileSynchronizationState,
  fingerprintSynchronizationCoordinationInput,
  type GitHubSourceFactV1,
  type ProofWakeEvidenceFactV1,
  type StensiblyAuthorityFactV1,
  type StensiblyCoordinationFactV1,
  type StensiblyOperationFactV1,
  type SynchronizationCompilerInputV1,
  type SynchronizationProjectionV1,
  type SynchronizationSubjectV1,
} from "./synchronization-state.js";

export const synchronizationSubjectBindingRevision =
  "synchronization-subject-binding/1" as const;

export type SubjectBoundFact<Fact> = Readonly<Fact & {
  subjectFingerprint: string;
}>;

export interface SubjectBoundSynchronizationCompilerInputV1
  extends Omit<
    SynchronizationCompilerInputV1,
    "source" | "evidence" | "operation" | "authority" | "coordination"
  > {
  source: SubjectBoundFact<GitHubSourceFactV1> | null;
  evidence: SubjectBoundFact<ProofWakeEvidenceFactV1> | null;
  operation: SubjectBoundFact<StensiblyOperationFactV1> | null;
  authority: SubjectBoundFact<StensiblyAuthorityFactV1> | null;
  coordination: SubjectBoundFact<StensiblyCoordinationFactV1> | null;
}

export interface SubjectBoundSynchronizationProjectionV1
  extends Omit<SynchronizationProjectionV1, "inputFingerprint" | "projectionFingerprint"> {
  bindingRevision: typeof synchronizationSubjectBindingRevision;
  subjectFingerprint: string;
  inputFingerprint: string;
  projectionFingerprint: string;
}

interface NormalizedSubjectBoundInput {
  subjectFingerprint: string;
  baseInput: SynchronizationCompilerInputV1;
}

const inputFields = Object.freeze([
  "schemaVersion",
  "policyVersion",
  "evaluatedAt",
  "subject",
  "source",
  "evidence",
  "operation",
  "authority",
  "coordination",
  "declaredConflicts",
]);

const sourceFields = Object.freeze([
  "id",
  "deliveryId",
  "revision",
  "observedAt",
  "freshnessUntil",
  "status",
]);
const evidenceFields = Object.freeze([
  "id",
  "projectionFingerprint",
  "sourceRevision",
  "observedAt",
  "freshnessUntil",
  "status",
]);
const operationFields = Object.freeze([
  "id",
  "state",
  "targetRevision",
  "providerRevision",
  "observedAt",
]);
const authorityFields = Object.freeze([
  "id",
  "generation",
  "currentGeneration",
  "status",
  "observedAt",
]);
const coordinationFields = Object.freeze([
  "id",
  "inputFingerprint",
  "status",
  "observedAt",
]);

export function fingerprintSynchronizationSubject(subject: unknown): string {
  const admitted = compileSynchronizationState({
    schemaVersion: 1,
    policyVersion: "synchronization-subject-fingerprint/v1",
    evaluatedAt: "1970-01-01T00:00:00.000Z",
    subject,
    source: null,
    evidence: null,
    operation: null,
    authority: null,
    coordination: null,
    declaredConflicts: [],
  }).subject;
  return sha256(stableJson(admitted));
}

export function fingerprintSubjectBoundSynchronizationCoordinationInput(
  input: unknown,
): string {
  return fingerprintSynchronizationCoordinationInput(
    normalizeSubjectBoundInput(input).baseInput,
  );
}

export function compileSubjectBoundSynchronizationState(
  input: unknown,
): SubjectBoundSynchronizationProjectionV1 {
  const normalized = normalizeSubjectBoundInput(input);
  const base = compileSynchronizationState(normalized.baseInput);
  const inputFingerprint = sha256(stableJson({
    bindingRevision: synchronizationSubjectBindingRevision,
    subjectFingerprint: normalized.subjectFingerprint,
    baseInputFingerprint: base.inputFingerprint,
  }));
  const body = {
    schemaVersion: base.schemaVersion,
    compilerRevision: base.compilerRevision,
    bindingRevision: synchronizationSubjectBindingRevision,
    policyVersion: base.policyVersion,
    evaluatedAt: base.evaluatedAt,
    subject: base.subject,
    subjectFingerprint: normalized.subjectFingerprint,
    state: base.state,
    conflicts: base.conflicts,
    nextAction: base.nextAction,
    facts: base.facts,
    inputFingerprint,
    authorizesMutation: false as const,
    authorizesAuthority: false as const,
  };
  return deepFreeze({
    ...body,
    projectionFingerprint: sha256(stableJson(body)),
  });
}

function normalizeSubjectBoundInput(input: unknown): NormalizedSubjectBoundInput {
  const record = exactRecord(input, inputFields, "Subject-bound synchronization input");
  const subjectFingerprint = fingerprintSynchronizationSubject(record.subject);
  const baseInput: SynchronizationCompilerInputV1 = {
    schemaVersion: record.schemaVersion as 1,
    policyVersion: record.policyVersion as string,
    evaluatedAt: record.evaluatedAt as string,
    subject: record.subject as SynchronizationSubjectV1,
    source: record.source === null
      ? null
      : stripBoundFact(record.source, sourceFields, subjectFingerprint, "GitHub source fact") as GitHubSourceFactV1,
    evidence: record.evidence === null
      ? null
      : stripBoundFact(record.evidence, evidenceFields, subjectFingerprint, "ProofWake evidence fact") as ProofWakeEvidenceFactV1,
    operation: record.operation === null
      ? null
      : stripBoundFact(record.operation, operationFields, subjectFingerprint, "Stensibly operation fact") as StensiblyOperationFactV1,
    authority: record.authority === null
      ? null
      : stripBoundFact(record.authority, authorityFields, subjectFingerprint, "Stensibly authority fact") as StensiblyAuthorityFactV1,
    coordination: record.coordination === null
      ? null
      : stripBoundFact(record.coordination, coordinationFields, subjectFingerprint, "Stensibly coordination fact") as StensiblyCoordinationFactV1,
    declaredConflicts: record.declaredConflicts as SynchronizationCompilerInputV1["declaredConflicts"],
  };
  return { subjectFingerprint, baseInput };
}

function stripBoundFact(
  value: unknown,
  baseFields: readonly string[],
  expectedSubjectFingerprint: string,
  label: string,
): Record<string, unknown> {
  const fields = [...baseFields, "subjectFingerprint"];
  const fact = exactRecord(value, fields, label);
  const suppliedSubjectFingerprint = fingerprint(
    fact.subjectFingerprint,
    `${label} subject fingerprint`,
  );
  if (suppliedSubjectFingerprint !== expectedSubjectFingerprint) {
    throw new TypeError("Synchronization fact subject did not match compiler subject");
  }
  return Object.freeze(Object.fromEntries(
    baseFields.map((field) => [field, fact[field]]),
  ));
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain or null prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== fields.length || fields.some((field) => !names.includes(field))) {
    throw new TypeError(`${label} fields were invalid`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
