import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  CHANGE_LINEAGE_CHECK_CONCLUSIONS,
  CHANGE_LINEAGE_LIFECYCLES,
  CHANGE_LINEAGE_OPERATIONS,
  CHANGE_LINEAGE_PROVIDERS,
  CHANGE_LINEAGE_REVIEW_DISPOSITIONS,
  CHANGE_LINEAGE_VERSION,
  type ChangeLineageChange,
  type ChangeLineageCheck,
  type ChangeLineageOperation,
  type ChangeLineageRevision,
  type ChangeRevisionReference,
} from "./change-lineage-contract.js";

export interface ParsedChangeLineageInput {
  repository: string;
  observedAt: string;
  changes: ChangeLineageChange[];
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const secretIdentityPattern = /(?:^|[/:._-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/i;

export function parseChangeLineageInput(input: unknown): ParsedChangeLineageInput {
  const record = exactRecord(input, ["repository", "observedAt", "changes"], "Change lineage input");
  const repository = repositoryName(record.repository);
  const observedAt = canonicalTimestamp(record.observedAt, "Change lineage observation time");
  const changes = exactArray(record.changes, "Change lineage changes", 0, 200)
    .map((entry) => parseChange(entry, repository, observedAt))
    .sort((a, b) => codeUnitCompare(a.changeId, b.changeId));
  const changeIds = new Set<string>();
  const providerIds = new Set<string>();
  for (const change of changes) {
    if (changeIds.has(change.changeId)) throw new RangeError(`Change lineage contains duplicate change ${change.changeId}`);
    const providerIdentity = `${change.provider}\u0000${change.providerChangeId}\u0000${change.targetRef}`;
    if (providerIds.has(providerIdentity)) throw new RangeError("Change lineage contains duplicate provider change identity");
    changeIds.add(change.changeId);
    providerIds.add(providerIdentity);
  }
  return { repository, observedAt, changes };
}

function parseChange(input: unknown, repository: string, projectionObservedAt: string): ChangeLineageChange {
  const record = exactRecord(input, [
    "changeId", "provider", "providerChangeId", "targetRef", "lifecycle",
    "currentRevisionId", "supersededBy", "semanticDependencies", "revisions",
    "requiredChecks", "checks", "reviewedRevisionId", "reviewDisposition", "unresolvedThreads",
  ], "Change lineage change");
  const changeId = identity(record.changeId, "Change ID", 240);
  const provider = closed(record.provider, CHANGE_LINEAGE_PROVIDERS, "Change provider");
  const providerChangeId = identity(record.providerChangeId, "Provider change ID", 512);
  const targetRef = gitRef(record.targetRef, "Change target ref");
  const lifecycle = closed(record.lifecycle, CHANGE_LINEAGE_LIFECYCLES, "Change lifecycle");
  const currentRevisionId = identity(record.currentRevisionId, "Current revision ID", 240);
  const supersededBy = record.supersededBy === null ? null : identity(record.supersededBy, "Superseding change ID", 240);
  if (supersededBy === changeId) throw new RangeError("Change cannot supersede itself");
  if ((lifecycle === "superseded") !== (supersededBy !== null)) {
    throw new RangeError("Superseded change lifecycle requires exactly one superseding change");
  }
  const semanticDependencies = uniqueStrings(
    exactArray(record.semanticDependencies, "Change semantic dependencies", 0, 100)
      .map((value) => identity(value, "Semantic dependency change ID", 240)),
    "Change semantic dependencies",
  );
  if (semanticDependencies.includes(changeId)) throw new RangeError("Change cannot depend semantically on itself");

  const revisions = exactArray(record.revisions, "Change revisions", 1, 500)
    .map((entry) => parseRevision(entry, projectionObservedAt))
    .sort((a, b) => a.generation - b.generation);
  const revisionIds = new Set<string>();
  const generations = new Set<number>();
  let previousObservedAt: string | null = null;
  for (const revision of revisions) {
    if (revisionIds.has(revision.revisionId)) throw new RangeError(`Change ${changeId} contains duplicate revision ${revision.revisionId}`);
    if (generations.has(revision.generation)) throw new RangeError(`Change ${changeId} contains duplicate generation ${revision.generation}`);
    if (previousObservedAt !== null && Date.parse(revision.observedAt) < Date.parse(previousObservedAt)) {
      throw new RangeError(`Change ${changeId} revision observations must be monotonic by generation`);
    }
    revisionIds.add(revision.revisionId);
    generations.add(revision.generation);
    previousObservedAt = revision.observedAt;
  }
  const current = revisions.find((revision) => revision.revisionId === currentRevisionId);
  if (!current) throw new RangeError(`Change ${changeId} current revision ${currentRevisionId} is missing`);
  if (current.generation !== revisions.at(-1)!.generation) {
    throw new RangeError(`Change ${changeId} current revision must be its highest observed generation`);
  }

  const requiredChecks = uniqueStrings(
    exactArray(record.requiredChecks, "Change required checks", 0, 100)
      .map((value) => exactText(value, "Required check name", 160)),
    "Change required checks",
  );
  const checks = exactArray(record.checks, "Change checks", 0, 500)
    .map(parseCheck)
    .sort((a, b) => codeUnitCompare(a.name, b.name) || codeUnitCompare(a.revisionId, b.revisionId));
  const checkKeys = new Set<string>();
  for (const check of checks) {
    if (!revisionIds.has(check.revisionId)) throw new RangeError(`Change ${changeId} check ${check.name} names missing revision ${check.revisionId}`);
    const key = `${check.name}\u0000${check.revisionId}`;
    if (checkKeys.has(key)) throw new RangeError(`Change ${changeId} contains duplicate check ${check.name} for revision ${check.revisionId}`);
    checkKeys.add(key);
  }

  const reviewDisposition = closed(record.reviewDisposition, CHANGE_LINEAGE_REVIEW_DISPOSITIONS, "Change review disposition");
  const reviewedRevisionId = record.reviewedRevisionId === null ? null : identity(record.reviewedRevisionId, "Reviewed revision ID", 240);
  if (reviewDisposition === "none" && reviewedRevisionId !== null) throw new RangeError("Change without a review cannot name a reviewed revision");
  if (reviewDisposition !== "none" && reviewedRevisionId === null) throw new RangeError("Change review requires an exact reviewed revision");
  if (reviewedRevisionId !== null && !revisionIds.has(reviewedRevisionId)) {
    throw new RangeError(`Change ${changeId} review names missing revision ${reviewedRevisionId}`);
  }
  const unresolvedThreads = nonNegative(record.unresolvedThreads, "Change unresolved review threads", 10_000);
  if (reviewDisposition === "none" && unresolvedThreads > 0) throw new RangeError("Change without a review cannot carry unresolved threads");

  return deepFreeze({
    changeId, provider, providerChangeId, targetRef, lifecycle, currentRevisionId,
    supersededBy, semanticDependencies, revisions, requiredChecks, checks,
    reviewedRevisionId, reviewDisposition, unresolvedThreads,
    stableIdentityFingerprint: fingerprintCanonicalRequest({
      version: CHANGE_LINEAGE_VERSION, repository, provider, providerChangeId, targetRef,
    }),
  });
}

function parseRevision(input: unknown, projectionObservedAt: string): ChangeLineageRevision {
  const record = exactRecord(input, [
    "revisionId", "generation", "observedAt", "operation", "predecessors",
    "stackParent", "sourceReferences", "recoveryReference",
  ], "Change revision");
  const revisionId = identity(record.revisionId, "Revision ID", 240);
  const generation = positive(record.generation, "Revision generation", 1_000_000);
  const observedAt = canonicalTimestamp(record.observedAt, "Revision observation time");
  if (Date.parse(observedAt) > Date.parse(projectionObservedAt)) throw new RangeError("Revision observation follows the lineage observation");
  const operation = closed(record.operation, CHANGE_LINEAGE_OPERATIONS, "Revision operation");
  const predecessors = exactArray(record.predecessors, "Revision predecessors", 0, 100)
    .map((entry) => revisionReference(entry, "Revision predecessor"))
    .sort(compareRevisionReferences);
  uniqueReferences(predecessors, "Revision predecessors");
  validatePredecessorCount(operation, predecessors.length);
  const stackParent = record.stackParent === null ? null : revisionReference(record.stackParent, "Revision stack parent");
  const sourceReferences = uniqueStrings(
    exactArray(record.sourceReferences, "Revision source references", 1, 100)
      .map((value) => identity(value, "Revision source reference", 1_024)),
    "Revision source references",
  );
  return deepFreeze({
    revisionId, generation, observedAt, operation, predecessors, stackParent,
    sourceReferences, recoveryReference: identity(record.recoveryReference, "Revision recovery reference", 1_024),
  });
}

function parseCheck(input: unknown): ChangeLineageCheck {
  const record = exactRecord(input, ["name", "revisionId", "conclusion"], "Change check");
  return deepFreeze({
    name: exactText(record.name, "Change check name", 160),
    revisionId: identity(record.revisionId, "Change check revision ID", 240),
    conclusion: closed(record.conclusion, CHANGE_LINEAGE_CHECK_CONCLUSIONS, "Change check conclusion"),
  });
}

function revisionReference(input: unknown, label: string): ChangeRevisionReference {
  const record = exactRecord(input, ["changeId", "revisionId"], label);
  return deepFreeze({
    changeId: identity(record.changeId, `${label} change ID`, 240),
    revisionId: identity(record.revisionId, `${label} revision ID`, 240),
  });
}

function validatePredecessorCount(operation: ChangeLineageOperation, count: number): void {
  if ((operation === "create" || operation === "import") && count !== 0) throw new RangeError(`${operation} revision cannot name a predecessor`);
  if (operation === "squash" && count < 2) throw new RangeError("squash revision requires at least two predecessors");
  if (!["create", "import", "squash"].includes(operation) && count !== 1) {
    throw new RangeError(`${operation} revision requires exactly one predecessor`);
  }
}

function exactRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RangeError(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new RangeError(`${label} contains a symbol field`);
  const allowed = new Set(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new RangeError(`${label} contains an unknown field`);
    if (!descriptor.enumerable || !("value" in descriptor)) throw new RangeError(`${label} fields must be enumerable data properties`);
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) if (!Object.hasOwn(descriptors, key)) throw new RangeError(`${label} is missing a required field`);
  return result;
}

function exactArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) {
    throw new RangeError(`${label} must contain between ${minimum} and ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new RangeError(`${label} contains a symbol field`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) throw new RangeError(`${label} contains an unknown field`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new RangeError(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) throw new RangeError(`${label} entries must be enumerable data properties`);
    result.push(descriptor.value);
  }
  return result;
}

function repositoryName(value: unknown): string {
  const repository = ascii(value, "Change lineage repository", 200).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,99})\/[a-z0-9](?:[a-z0-9_.-]{0,99})$/.test(repository)) {
    throw new RangeError("Change lineage repository is invalid");
  }
  return repository;
}
function identity(value: unknown, label: string, maximum: number): string {
  const result = ascii(value, label, maximum);
  if (secretIdentityPattern.test(result)) throw new RangeError(`${label} cannot be secret-shaped`);
  return result;
}
function gitRef(value: unknown, label: string): string {
  const ref = ascii(value, label, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new RangeError(`${label} is invalid`);
  }
  return ref;
}
function ascii(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || !/^[\x21-\x7e]+$/.test(value)) {
    throw new RangeError(`${label} must use exact printable ASCII without whitespace`);
  }
  return value;
}
function exactText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}
function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) throw new RangeError(`${label} must be an ISO UTC timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid timestamp`);
  const canonical = date.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/, ".000Z") : value;
  if (canonical !== expected) throw new RangeError(`${label} must be a valid timestamp`);
  return canonical;
}
function positive(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new RangeError(`${label} must be a positive integer`);
  return value as number;
}
function nonNegative(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new RangeError(`${label} must be a non-negative integer`);
  return value as number;
}
function closed<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) throw new RangeError(`${label} is invalid`);
  return value as T[number];
}
function uniqueStrings(values: string[], label: string): string[] {
  values.sort(codeUnitCompare);
  if (new Set(values).size !== values.length) throw new RangeError(`${label} must be unique`);
  return values;
}
function uniqueReferences(values: readonly ChangeRevisionReference[], label: string): void {
  if (new Set(values.map(revisionKey)).size !== values.length) throw new RangeError(`${label} must be unique`);
}
export function revisionKey(reference: ChangeRevisionReference): string {
  return `${reference.changeId}\u0000${reference.revisionId}`;
}
export function sameRevisionReference(a: ChangeRevisionReference, b: ChangeRevisionReference): boolean {
  return a.changeId === b.changeId && a.revisionId === b.revisionId;
}
export function compareRevisionReferences(a: ChangeRevisionReference, b: ChangeRevisionReference): number {
  return codeUnitCompare(a.changeId, b.changeId) || codeUnitCompare(a.revisionId, b.revisionId);
}
export function codeUnitCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}