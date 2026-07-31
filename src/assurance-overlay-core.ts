import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const ASSURANCE_OVERLAY_V1 = 1 as const;
export const ASSURANCE_WRITE_CLASSES = [
  "append_only_evidence",
  "disposable_candidate",
  "canonical_state",
] as const;
export const ASSURANCE_RISK_CLASSES = [
  "tier_0",
  "tier_1",
  "tier_2",
  "tier_3",
] as const;
export const ASSURANCE_REVIEW_POLICIES = [
  "self_review",
  "independent_when_canonical",
  "independent_required",
] as const;

export type AssuranceWriteClass = typeof ASSURANCE_WRITE_CLASSES[number];
export type AssuranceRiskClass = typeof ASSURANCE_RISK_CLASSES[number];
export type AssuranceReviewPolicy = typeof ASSURANCE_REVIEW_POLICIES[number];

export interface AssuranceOverlaySelectorInputV1 {
  adapterId: string;
  executionSurface: string;
  providerId: string | null;
  modelId: string | null;
  profileId: string | null;
  protocolVersion: string;
  harnessVersion: string;
  toolManifestFingerprint: string;
  taskClasses: string[];
  riskClasses: AssuranceRiskClass[];
  priority: number;
}

export interface AssuranceOverlayScopeInputV1 {
  repositories: string[];
  projects: string[];
  resources: string[];
  writeClasses: AssuranceWriteClass[];
  operations: string[];
  fileFence: string[];
  metadataFence: string[];
}

export interface AssuranceOverlayRequirementsInputV1 {
  checks: string[];
  stopConditions: string[];
  reviewPolicy: AssuranceReviewPolicy;
  expectedRevision: string | null;
  evidenceRefs: string[];
}

export interface AssuranceOverlayInputV1 {
  version: typeof ASSURANCE_OVERLAY_V1;
  overlayId: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  selector: AssuranceOverlaySelectorInputV1;
  scope: AssuranceOverlayScopeInputV1;
  requirements: AssuranceOverlayRequirementsInputV1;
  instructions: string[];
}

export interface AssuranceOverlaySelectorV1 {
  adapterId: string;
  executionSurface: string;
  providerId: string | null;
  modelId: string | null;
  profileId: string | null;
  protocolVersion: string;
  harnessVersion: string;
  toolManifestFingerprint: string;
  taskClasses: readonly string[];
  riskClasses: readonly AssuranceRiskClass[];
  priority: number;
}

export interface AssuranceOverlayScopeV1 {
  repositories: readonly string[];
  projects: readonly string[];
  resources: readonly string[];
  writeClasses: readonly AssuranceWriteClass[];
  operations: readonly string[];
  fileFence: readonly string[];
  metadataFence: readonly string[];
}

export interface AssuranceOverlayRequirementsV1 {
  checks: readonly string[];
  stopConditions: readonly string[];
  reviewPolicy: AssuranceReviewPolicy;
  expectedRevision: string | null;
  evidenceRefs: readonly string[];
  selfReviewPasses: readonly ["factual_evidence", "scope_impact"];
}

export interface AssuranceOverlayV1 {
  version: typeof ASSURANCE_OVERLAY_V1;
  overlayId: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  selector: AssuranceOverlaySelectorV1;
  scope: AssuranceOverlayScopeV1;
  requirements: AssuranceOverlayRequirementsV1;
  instructions: readonly string[];
  overlayFingerprint: string;
}

export interface AssuranceOverlaySelectionContextInputV1 {
  adapterId: string;
  executionSurface: string;
  providerId: string | null;
  modelId: string | null;
  profileId: string | null;
  protocolVersion: string;
  harnessVersion: string;
  toolManifestFingerprint: string;
  taskClass: string;
  riskClass: AssuranceRiskClass;
  repository: string | null;
  project: string | null;
  resource: string | null;
  writeClass: AssuranceWriteClass;
  operation: string;
  currentRevision: string | null;
  requestedFiles: string[];
  requestedMetadata: string[];
  observedAt: string;
}

export interface AssuranceOverlaySelectionContextV1 {
  adapterId: string;
  executionSurface: string;
  providerId: string | null;
  modelId: string | null;
  profileId: string | null;
  protocolVersion: string;
  harnessVersion: string;
  toolManifestFingerprint: string;
  taskClass: string;
  riskClass: AssuranceRiskClass;
  repository: string | null;
  project: string | null;
  resource: string | null;
  writeClass: AssuranceWriteClass;
  operation: string;
  currentRevision: string | null;
  requestedFiles: readonly string[];
  requestedMetadata: readonly string[];
  observedAt: string;
}

export interface AssuranceOverlaySelectionV1 {
  version: typeof ASSURANCE_OVERLAY_V1;
  context: AssuranceOverlaySelectionContextV1;
  overlay: AssuranceOverlayV1;
  selectionFingerprint: string;
  authorizesOperation: false;
  authorizesCanonicalWrite: false;
}

export function compileAssuranceOverlayV1(value: unknown): AssuranceOverlayV1 {
  const record = exactRecord(value, [
    "version",
    "overlayId",
    "revision",
    "issuedAt",
    "expiresAt",
    "selector",
    "scope",
    "requirements",
    "instructions",
  ], "Assurance overlay");
  if (record.version !== ASSURANCE_OVERLAY_V1) {
    throw new RangeError("Assurance overlay version is unsupported");
  }
  const issuedAt = canonicalTimestamp(record.issuedAt, "Assurance overlay issue time");
  const expiresAt = canonicalTimestamp(record.expiresAt, "Assurance overlay expiry time");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new RangeError("Assurance overlay expiry must follow its issue time");
  }
  const selector = parseSelector(record.selector);
  const scope = parseScope(record.scope);
  const requirements = parseRequirements(record.requirements);
  if (scope.writeClasses.includes("canonical_state")) {
    if (requirements.expectedRevision === null) {
      throw new RangeError(
        "Canonical-state assurance overlays require an expected revision",
      );
    }
    if (requirements.reviewPolicy === "self_review") {
      throw new RangeError(
        "Canonical-state assurance overlays require independent review",
      );
    }
  }
  const instructions = exactArray(
    record.instructions,
    "Assurance overlay instructions",
    1,
    100,
  ).map((entry, index) =>
    exactText(entry, `Assurance overlay instruction ${index + 1}`, 2_000)
  );
  const withoutFingerprint = {
    version: ASSURANCE_OVERLAY_V1,
    overlayId: identifier(record.overlayId, "Assurance overlay ID", 160),
    revision: positiveInteger(record.revision, "Assurance overlay revision", 1_000_000),
    issuedAt,
    expiresAt,
    selector,
    scope,
    requirements,
    instructions,
  };
  return deepFreeze({
    ...withoutFingerprint,
    overlayFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

export function selectAssuranceOverlayV1(
  overlaysValue: unknown,
  contextValue: unknown,
): AssuranceOverlaySelectionV1 | null {
  const overlays = exactArray(
    overlaysValue,
    "Assurance overlay catalogue",
    0,
    200,
  ).map(compileAssuranceOverlayV1);
  const context = parseSelectionContext(contextValue);
  const identities = new Set<string>();
  for (const overlay of overlays) {
    const identity = `${overlay.overlayId}@${overlay.revision}`;
    if (identities.has(identity)) {
      throw new RangeError(`Assurance overlay catalogue contains duplicate ${identity}`);
    }
    identities.add(identity);
  }
  const matches = overlays.filter((overlay) => overlayMatches(overlay, context));
  if (matches.length === 0) return null;
  const highestPriority = Math.max(...matches.map((entry) => entry.selector.priority));
  const selected = matches.filter(
    (entry) => entry.selector.priority === highestPriority,
  );
  if (selected.length !== 1) {
    throw new RangeError(
      `Assurance overlay selection is ambiguous at priority ${highestPriority}`,
    );
  }
  const overlay = selected[0]!;
  return deepFreeze({
    version: ASSURANCE_OVERLAY_V1,
    context,
    overlay,
    selectionFingerprint: fingerprintCanonicalRequest({
      version: ASSURANCE_OVERLAY_V1,
      context,
      overlayFingerprint: overlay.overlayFingerprint,
    }),
    authorizesOperation: false as const,
    authorizesCanonicalWrite: false as const,
  });
}

function parseSelector(value: unknown): AssuranceOverlaySelectorV1 {
  const record = exactRecord(value, [
    "adapterId",
    "executionSurface",
    "providerId",
    "modelId",
    "profileId",
    "protocolVersion",
    "harnessVersion",
    "toolManifestFingerprint",
    "taskClasses",
    "riskClasses",
    "priority",
  ], "Assurance overlay selector");
  return deepFreeze({
    adapterId: identifier(record.adapterId, "Assurance adapter ID", 160),
    executionSurface: identifier(record.executionSurface, "Assurance execution surface", 160),
    providerId: nullableIdentifier(record.providerId, "Assurance provider ID", 160),
    modelId: nullableIdentifier(record.modelId, "Assurance model ID", 240),
    profileId: nullableIdentifier(record.profileId, "Assurance profile ID", 240),
    protocolVersion: identifier(record.protocolVersion, "Assurance protocol version", 160),
    harnessVersion: identifier(record.harnessVersion, "Assurance harness version", 160),
    toolManifestFingerprint: sha256Fingerprint(
      record.toolManifestFingerprint,
      "Assurance tool manifest fingerprint",
    ),
    taskClasses: sortedIdentifiers(record.taskClasses, "Assurance task classes", 1, 100),
    riskClasses: sortedClosedValues(
      record.riskClasses,
      ASSURANCE_RISK_CLASSES,
      "Assurance risk classes",
      1,
      ASSURANCE_RISK_CLASSES.length,
    ),
    priority: nonNegativeInteger(record.priority, "Assurance overlay priority", 10_000),
  });
}

function parseScope(value: unknown): AssuranceOverlayScopeV1 {
  const record = exactRecord(value, [
    "repositories",
    "projects",
    "resources",
    "writeClasses",
    "operations",
    "fileFence",
    "metadataFence",
  ], "Assurance overlay scope");
  const repositories = sortedUnique(
    exactArray(record.repositories, "Assurance repositories", 0, 100)
      .map(repositoryName),
    "Assurance repositories",
  );
  const projects = sortedUnique(
    exactArray(record.projects, "Assurance projects", 0, 100)
      .map(projectSlug),
    "Assurance projects",
  );
  const resources = sortedIdentifiers(record.resources, "Assurance resources", 0, 200);
  if (repositories.length + projects.length + resources.length === 0) {
    throw new RangeError("Assurance overlay must name at least one bounded target");
  }
  return deepFreeze({
    repositories,
    projects,
    resources,
    writeClasses: sortedClosedValues(
      record.writeClasses,
      ASSURANCE_WRITE_CLASSES,
      "Assurance write classes",
      1,
      ASSURANCE_WRITE_CLASSES.length,
    ),
    operations: sortedIdentifiers(record.operations, "Assurance operations", 1, 200),
    fileFence: sortedUnique(
      exactArray(record.fileFence, "Assurance file fence", 0, 2_000)
        .map(repositoryPath),
      "Assurance file fence",
    ),
    metadataFence: sortedIdentifiers(
      record.metadataFence,
      "Assurance metadata fence",
      0,
      200,
    ),
  });
}

function parseRequirements(value: unknown): AssuranceOverlayRequirementsV1 {
  const record = exactRecord(value, [
    "checks",
    "stopConditions",
    "reviewPolicy",
    "expectedRevision",
    "evidenceRefs",
  ], "Assurance overlay requirements");
  return deepFreeze({
    checks: sortedTextList(record.checks, "Assurance checks", 0, 200, 500),
    stopConditions: sortedTextList(
      record.stopConditions,
      "Assurance stop conditions",
      1,
      100,
      1_000,
    ),
    reviewPolicy: closedValue(
      record.reviewPolicy,
      ASSURANCE_REVIEW_POLICIES,
      "Assurance review policy",
    ),
    expectedRevision: nullableRevision(record.expectedRevision),
    evidenceRefs: sortedIdentifiers(
      record.evidenceRefs,
      "Assurance evidence references",
      1,
      200,
    ),
    selfReviewPasses: ["factual_evidence", "scope_impact"] as const,
  });
}

function parseSelectionContext(value: unknown): AssuranceOverlaySelectionContextV1 {
  const record = exactRecord(value, [
    "adapterId",
    "executionSurface",
    "providerId",
    "modelId",
    "profileId",
    "protocolVersion",
    "harnessVersion",
    "toolManifestFingerprint",
    "taskClass",
    "riskClass",
    "repository",
    "project",
    "resource",
    "writeClass",
    "operation",
    "currentRevision",
    "requestedFiles",
    "requestedMetadata",
    "observedAt",
  ], "Assurance overlay selection context");
  const repository = record.repository === null
    ? null
    : repositoryName(record.repository);
  const project = record.project === null ? null : projectSlug(record.project);
  const resource = nullableIdentifier(record.resource, "Assurance context resource", 240);
  if (repository === null && project === null && resource === null) {
    throw new RangeError("Assurance selection context must name a bounded target");
  }
  return deepFreeze({
    adapterId: identifier(record.adapterId, "Assurance context adapter ID", 160),
    executionSurface: identifier(
      record.executionSurface,
      "Assurance context execution surface",
      160,
    ),
    providerId: nullableIdentifier(record.providerId, "Assurance context provider ID", 160),
    modelId: nullableIdentifier(record.modelId, "Assurance context model ID", 240),
    profileId: nullableIdentifier(record.profileId, "Assurance context profile ID", 240),
    protocolVersion: identifier(
      record.protocolVersion,
      "Assurance context protocol version",
      160,
    ),
    harnessVersion: identifier(
      record.harnessVersion,
      "Assurance context harness version",
      160,
    ),
    toolManifestFingerprint: sha256Fingerprint(
      record.toolManifestFingerprint,
      "Assurance context tool manifest fingerprint",
    ),
    taskClass: identifier(record.taskClass, "Assurance context task class", 160),
    riskClass: closedValue(
      record.riskClass,
      ASSURANCE_RISK_CLASSES,
      "Assurance context risk class",
    ),
    repository,
    project,
    resource,
    writeClass: closedValue(
      record.writeClass,
      ASSURANCE_WRITE_CLASSES,
      "Assurance context write class",
    ),
    operation: identifier(record.operation, "Assurance context operation", 240),
    currentRevision: nullableRevision(record.currentRevision),
    requestedFiles: sortedUnique(
      exactArray(record.requestedFiles, "Assurance requested files", 0, 2_000)
        .map(repositoryPath),
      "Assurance requested files",
    ),
    requestedMetadata: sortedIdentifiers(
      record.requestedMetadata,
      "Assurance requested metadata",
      0,
      200,
    ),
    observedAt: canonicalTimestamp(record.observedAt, "Assurance context observation time"),
  });
}

function overlayMatches(
  overlay: AssuranceOverlayV1,
  context: AssuranceOverlaySelectionContextV1,
): boolean {
  const selector = overlay.selector;
  if (
    selector.adapterId !== context.adapterId
    || selector.executionSurface !== context.executionSurface
    || selector.protocolVersion !== context.protocolVersion
    || selector.harnessVersion !== context.harnessVersion
    || selector.toolManifestFingerprint !== context.toolManifestFingerprint
    || !nullableSelectorMatches(selector.providerId, context.providerId)
    || !nullableSelectorMatches(selector.modelId, context.modelId)
    || !nullableSelectorMatches(selector.profileId, context.profileId)
    || !selector.taskClasses.includes(context.taskClass)
    || !selector.riskClasses.includes(context.riskClass)
  ) return false;
  const observedAt = Date.parse(context.observedAt);
  if (
    observedAt < Date.parse(overlay.issuedAt)
    || observedAt >= Date.parse(overlay.expiresAt)
  ) return false;

  const scope = overlay.scope;
  if (
    !scope.writeClasses.includes(context.writeClass)
    || !scope.operations.includes(context.operation)
    || !targetDimensionMatches(scope.repositories, context.repository)
    || !targetDimensionMatches(scope.projects, context.project)
    || !targetDimensionMatches(scope.resources, context.resource)
    || !context.requestedFiles.every((path) => scope.fileFence.includes(path))
    || !context.requestedMetadata.every((field) => scope.metadataFence.includes(field))
  ) return false;
  const expectedRevision = overlay.requirements.expectedRevision;
  return expectedRevision === null || expectedRevision === context.currentRevision;
}

function targetDimensionMatches(
  allowed: readonly string[],
  actual: string | null,
): boolean {
  if (allowed.length === 0) return actual === null;
  return actual !== null && allowed.includes(actual);
}

function nullableSelectorMatches(
  selector: string | null,
  actual: string | null,
): boolean {
  return selector === null || selector === actual;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(allowedKeys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new RangeError(`${label} contains unknown field ${key}`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} field ${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return result;
}

function exactArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum
    || value.length > maximum
  ) throw new RangeError(`${label} must contain between ${minimum} and ${maximum} entries`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      throw new RangeError(`${label} contains unknown field ${key}`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new RangeError(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} entries must be enumerable data properties`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string, maximum: number): string {
  const text = exactText(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(text)) {
    throw new RangeError(`${label} is invalid`);
  }
  return text;
}

function nullableIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === null ? null : identifier(value, label, maximum);
}

function repositoryName(value: unknown): string {
  const repository = exactText(value, "Assurance repository", 201).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_.-]{0,99})\/[a-z0-9](?:[a-z0-9_.-]{0,99})$/u.test(repository)) {
    throw new RangeError("Assurance repository is invalid");
  }
  return repository;
}

function projectSlug(value: unknown): string {
  const project = exactText(value, "Assurance project", 100).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/u.test(project)) {
    throw new RangeError("Assurance project is invalid");
  }
  return project;
}

function repositoryPath(value: unknown): string {
  const path = exactText(value, "Assurance file-fence path", 1_024);
  if (path.startsWith("/") || path.includes("\\")) {
    throw new RangeError("Assurance file-fence path is invalid");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new RangeError("Assurance file-fence path is invalid");
  }
  return path;
}

function sha256Fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function nullableRevision(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !(/^[a-f0-9]{40}$/u.test(value) || /^sha256:[a-f0-9]{64}$/u.test(value))
  ) {
    throw new RangeError(
      "Assurance revision must be a lowercase full commit SHA or SHA-256 fingerprint",
    );
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) throw new RangeError(`${label} must be an ISO UTC timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be valid`);
  const canonical = date.toISOString();
  const expected = value.length === 20 ? value.replace(/Z$/u, ".000Z") : value;
  if (canonical !== expected) throw new RangeError(`${label} must be canonical`);
  return canonical;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function sortedIdentifiers(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  return sortedUnique(
    exactArray(value, label, minimum, maximum)
      .map((entry) => identifier(entry, label, 240)),
    label,
  );
}

function sortedTextList(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  maximumLength: number,
): string[] {
  return sortedUnique(
    exactArray(value, label, minimum, maximum)
      .map((entry) => exactText(entry, label, maximumLength)),
    label,
  );
}

function sortedClosedValues<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
  minimum: number,
  maximum: number,
): T[number][] {
  const entries = exactArray(value, label, minimum, maximum)
    .map((entry) => closedValue(entry, values, label))
    .sort(codeUnitCompare);
  if (new Set(entries).size !== entries.length) {
    throw new RangeError(`${label} must be unique`);
  }
  return entries;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function sortedUnique(values: string[], label: string): string[] {
  values.sort(codeUnitCompare);
  if (new Set(values).size !== values.length) {
    throw new RangeError(`${label} must be unique`);
  }
  return values;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
