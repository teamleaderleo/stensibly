import {
  ASSURANCE_OVERLAY_V1,
  ASSURANCE_REVIEW_POLICIES,
  ASSURANCE_RISK_CLASSES,
  ASSURANCE_WRITE_CLASSES,
  compileAssuranceOverlayV1 as compileCoreOverlay,
  selectAssuranceOverlayV1 as selectCoreOverlay,
  type AssuranceOverlayInputV1,
  type AssuranceOverlayRequirementsInputV1,
  type AssuranceOverlayRequirementsV1,
  type AssuranceOverlayScopeInputV1,
  type AssuranceOverlayScopeV1,
  type AssuranceOverlaySelectionContextInputV1,
  type AssuranceOverlaySelectionContextV1,
  type AssuranceOverlaySelectionV1,
  type AssuranceOverlaySelectorInputV1,
  type AssuranceOverlaySelectorV1,
  type AssuranceOverlayV1,
  type AssuranceReviewPolicy,
  type AssuranceRiskClass,
  type AssuranceWriteClass,
} from "./assurance-overlay-core.js";

export {
  ASSURANCE_OVERLAY_V1,
  ASSURANCE_REVIEW_POLICIES,
  ASSURANCE_RISK_CLASSES,
  ASSURANCE_WRITE_CLASSES,
};
export type {
  AssuranceOverlayInputV1,
  AssuranceOverlayRequirementsInputV1,
  AssuranceOverlayRequirementsV1,
  AssuranceOverlayScopeInputV1,
  AssuranceOverlayScopeV1,
  AssuranceOverlaySelectionContextInputV1,
  AssuranceOverlaySelectionContextV1,
  AssuranceOverlaySelectionV1,
  AssuranceOverlaySelectorInputV1,
  AssuranceOverlaySelectorV1,
  AssuranceOverlayV1,
  AssuranceReviewPolicy,
  AssuranceRiskClass,
  AssuranceWriteClass,
};

export type AssuranceTrustedClock = () => Date;

const overlayKeys = [
  "version",
  "overlayId",
  "revision",
  "issuedAt",
  "expiresAt",
  "selector",
  "scope",
  "requirements",
  "instructions",
] as const;
const scopeKeys = [
  "repositories",
  "projects",
  "resources",
  "writeClasses",
  "operations",
  "fileFence",
  "metadataFence",
] as const;
const contextKeys = [
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
] as const;

export function compileAssuranceOverlayV1(value: unknown): AssuranceOverlayV1 {
  validateOverlayProjectIdentity(value);
  return compileCoreOverlay(value);
}

export function selectAssuranceOverlayV1(
  overlaysValue: unknown,
  contextValue: unknown,
  trustedClock: AssuranceTrustedClock,
): AssuranceOverlaySelectionV1 | null {
  const overlays = exactArray(
    overlaysValue,
    "Assurance overlay catalogue",
    0,
    200,
  );
  for (const overlay of overlays) {
    validateOverlayProjectIdentity(overlay);
    compileCoreOverlay(overlay);
  }

  const context = exactRecord(
    contextValue,
    contextKeys,
    "Assurance overlay selection context",
  );
  if (context.project !== null) projectSlug(context.project);
  selectCoreOverlay([], contextValue);
  const observedAt = canonicalTimestamp(
    context.observedAt,
    "Assurance context observation time",
  );
  if (!trustedSelectionTimeMatches(trustedClock, observedAt)) return null;
  return selectCoreOverlay(overlaysValue, contextValue);
}

function validateOverlayProjectIdentity(value: unknown): void {
  const overlay = exactRecord(value, overlayKeys, "Assurance overlay");
  const scope = exactRecord(
    overlay.scope,
    scopeKeys,
    "Assurance overlay scope",
  );
  const projects = exactArray(
    scope.projects,
    "Assurance projects",
    0,
    100,
  );
  for (const project of projects) projectSlug(project);
}

function trustedSelectionTimeMatches(
  trustedClock: unknown,
  observedAt: string,
): boolean {
  if (typeof trustedClock !== "function") return false;
  let trusted: unknown;
  try {
    trusted = trustedClock();
  } catch {
    return false;
  }
  if (!(trusted instanceof Date)) return false;
  let milliseconds: number;
  let canonical: string;
  try {
    milliseconds = Date.prototype.getTime.call(trusted);
    canonical = Date.prototype.toISOString.call(trusted);
  } catch {
    return false;
  }
  return Number.isFinite(milliseconds) && canonical === observedAt;
}

function projectSlug(value: unknown): string {
  const project = exactText(value, "Assurance project", 100);
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/u.test(project)) {
    throw new RangeError("Assurance project is invalid");
  }
  return project;
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(allowedKeys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new RangeError(`${label} contains unknown fields`);
    }
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw new RangeError(`${label} is missing required fields`);
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
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} must be a plain array`);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} entries`,
    );
  }
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new RangeError(`${label} contains unsupported fields`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
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

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) throw new RangeError(`${label} must be an ISO UTC timestamp`);
  const date = new Date(value);
  const milliseconds = Date.prototype.getTime.call(date);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be canonical`);
  }
  const canonical = Date.prototype.toISOString.call(date);
  const expected = value.length === 20 ? value.replace(/Z$/u, ".000Z") : value;
  if (canonical !== expected) throw new RangeError(`${label} must be canonical`);
  return canonical;
}
