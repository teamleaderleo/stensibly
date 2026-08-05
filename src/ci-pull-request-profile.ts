import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const CI_PULL_REQUEST_PROFILE_V1 = 1 as const;
export const CI_RED_CONTROL_LABEL = "ci:red-control" as const;
export const CI_RED_CONTROL_DECLARATION = Object.freeze({
  schema: "ci-red-control/v1",
  independentIntegration: "independent-integration: prohibited",
} as const);
export const CI_PULL_REQUEST_VALIDATION_PROFILES = [
  "full_parallel",
  "red_control_focused",
] as const;
export const CI_PULL_REQUEST_PROFILE_REASONS = [
  "ordinary_pull_request",
  "red_control_requires_draft",
  "red_control_declaration_missing",
  "red_control_declaration_ambiguous",
  "red_control_parent_missing",
  "red_control_parent_invalid",
  "red_control_parent_ambiguous",
  "red_control_parent_self_reference",
  "red_control_focused",
] as const;

export type CiPullRequestValidationProfile = typeof CI_PULL_REQUEST_VALIDATION_PROFILES[number];
export type CiPullRequestProfileReason = typeof CI_PULL_REQUEST_PROFILE_REASONS[number];

export interface CiPullRequestProfileInputV1 {
  version: typeof CI_PULL_REQUEST_PROFILE_V1;
  repository: string;
  pullRequestNumber: number;
  candidateRevision: string;
  draft: boolean;
  labels: string[];
  body: string | null;
}

export interface CiPullRequestProfileDecisionV1 {
  version: typeof CI_PULL_REQUEST_PROFILE_V1;
  repository: string;
  pullRequestNumber: number;
  candidateRevision: string;
  validationProfile: CiPullRequestValidationProfile;
  reason: CiPullRequestProfileReason;
  draft: boolean;
  redControlLabelPresent: boolean;
  absorbingParentPullRequestNumber: number | null;
  requiresAbsorbingParentFullValidation: boolean;
  authorizesIntegration: false;
  authorizesMutation: false;
  decisionFingerprint: string;
}

const inputKeys = [
  "version",
  "repository",
  "pullRequestNumber",
  "candidateRevision",
  "draft",
  "labels",
  "body",
] as const;
const maximumBodyBytes = 65_536;
const maximumLabels = 100;
const maximumLabelLength = 100;
const commitPattern = /^[0-9a-f]{40}$/u;
const parentPrefix = "absorbing-parent:";
const parentPattern = /^absorbing-parent: #([1-9][0-9]{0,9})$/u;
const credentialPattern = /(?:^|[._:/-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/iu;

export function compileCiPullRequestProfileV1(value: unknown): CiPullRequestProfileDecisionV1 {
  const input = exactRecord(value, inputKeys, "CI pull request profile input");
  if (input.version !== CI_PULL_REQUEST_PROFILE_V1) {
    throw new RangeError("CI pull request profile version is unsupported");
  }

  const repository = repositoryName(input.repository);
  const pullRequestNumber = positiveInteger(
    input.pullRequestNumber,
    "CI pull request number",
    2_147_483_647,
  );
  const candidateRevision = commitSha(input.candidateRevision);
  const draft = booleanValue(input.draft, "CI pull request draft state");
  const labels = stringArray(
    input.labels,
    "CI pull request labels",
    maximumLabels,
    maximumLabelLength,
  );
  const body = nullableBoundedBody(input.body);
  const redControlLabelPresent = labels.includes(CI_RED_CONTROL_LABEL);

  let validationProfile: CiPullRequestValidationProfile = "full_parallel";
  let reason: CiPullRequestProfileReason = "ordinary_pull_request";
  let absorbingParentPullRequestNumber: number | null = null;

  if (redControlLabelPresent) {
    if (!draft) {
      reason = "red_control_requires_draft";
    } else {
      const declaration = parseRedControlDeclaration(body);
      reason = declaration.reason;
      absorbingParentPullRequestNumber = declaration.absorbingParentPullRequestNumber;
      if (reason === "red_control_focused") {
        if (absorbingParentPullRequestNumber === pullRequestNumber) {
          reason = "red_control_parent_self_reference";
          absorbingParentPullRequestNumber = null;
        } else {
          validationProfile = "red_control_focused";
        }
      }
    }
  }

  const decision = {
    version: CI_PULL_REQUEST_PROFILE_V1,
    repository,
    pullRequestNumber,
    candidateRevision,
    validationProfile,
    reason,
    draft,
    redControlLabelPresent,
    absorbingParentPullRequestNumber,
    requiresAbsorbingParentFullValidation: validationProfile === "red_control_focused",
    authorizesIntegration: false as const,
    authorizesMutation: false as const,
  };
  return deepFreeze({
    ...decision,
    decisionFingerprint: fingerprintCanonicalRequest(decision),
  });
}

function parseRedControlDeclaration(body: string | null): {
  reason: CiPullRequestProfileReason;
  absorbingParentPullRequestNumber: number | null;
} {
  if (body === null) {
    return { reason: "red_control_declaration_missing", absorbingParentPullRequestNumber: null };
  }
  const lines = body
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim());
  const schemaLines = lines.filter((line) => line === CI_RED_CONTROL_DECLARATION.schema);
  const integrationLines = lines.filter(
    (line) => line === CI_RED_CONTROL_DECLARATION.independentIntegration,
  );
  if (schemaLines.length === 0 || integrationLines.length === 0) {
    return { reason: "red_control_declaration_missing", absorbingParentPullRequestNumber: null };
  }
  if (schemaLines.length !== 1 || integrationLines.length !== 1) {
    return { reason: "red_control_declaration_ambiguous", absorbingParentPullRequestNumber: null };
  }

  const parentLines = lines.filter((line) => line.startsWith(parentPrefix));
  if (parentLines.length === 0) {
    return { reason: "red_control_parent_missing", absorbingParentPullRequestNumber: null };
  }
  if (parentLines.length !== 1) {
    return { reason: "red_control_parent_ambiguous", absorbingParentPullRequestNumber: null };
  }
  const match = parentPattern.exec(parentLines[0]!);
  if (match === null) {
    return { reason: "red_control_parent_invalid", absorbingParentPullRequestNumber: null };
  }
  const absorbingParentPullRequestNumber = Number(match[1]);
  if (!Number.isSafeInteger(absorbingParentPullRequestNumber) || absorbingParentPullRequestNumber > 2_147_483_647) {
    return { reason: "red_control_parent_invalid", absorbingParentPullRequestNumber: null };
  }
  return { reason: "red_control_focused", absorbingParentPullRequestNumber };
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): Record<K[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const expected = new Set<string>(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new RangeError(`${label} contains unknown or missing fields`);
  }
  const result = Object.create(null) as Record<K[number], unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label} requires data properties`);
    }
    result[key as K[number]] = descriptor.value;
  }
  return result;
}

function stringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maximumItems) throw new RangeError(`${label} exceeds its item limit`);
  const allowedKeys = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) allowedKeys.add(String(index));
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    throw new RangeError(`${label} contains unsupported properties`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label} requires dense data properties`);
    }
    const entry = descriptor.value;
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > maximumItemLength ||
      entry !== entry.trim() ||
      /[\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw new RangeError(`${label} contains an invalid label`);
    }
    if (seen.has(entry)) throw new RangeError(`${label} contains duplicate labels`);
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function repositoryName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 201 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    credentialPattern.test(value)
  ) {
    throw new RangeError("CI repository is invalid");
  }
  if (value !== value.toLowerCase()) {
    throw new RangeError("CI repository must be an exact lowercase owner/name identity");
  }
  const [owner, name, extra] = value.split("/");
  if (
    extra !== undefined ||
    owner === undefined ||
    name === undefined ||
    owner.includes("--") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(owner) ||
    !/^[a-z0-9](?:[a-z0-9_.-]{0,99})$/u.test(name)
  ) {
    throw new RangeError("CI repository is invalid");
  }
  return value;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    throw new RangeError("CI candidate revision must be a lowercase commit SHA");
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function nullableBoundedBody(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("CI pull request body must be text or null");
  if (new TextEncoder().encode(value).byteLength > maximumBodyBytes) {
    throw new RangeError("CI pull request body exceeds its byte limit");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}
