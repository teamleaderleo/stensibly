export const RUNNER_EXTERNAL_REFERENCE_V1 = 1 as const;

export const runnerExternalReferenceKindsPortable = [
  "session",
  "continuation",
  "checkpoint",
  "trace",
  "usage",
  "log",
  "artifact",
  "provider_receipt",
] as const;
export type RunnerExternalReferenceKindPortable =
  typeof runnerExternalReferenceKindsPortable[number];

export const runnerReferenceAccessClassesPortable = [
  "private",
  "project",
  "workspace",
] as const;
export type RunnerReferenceAccessClassPortable =
  typeof runnerReferenceAccessClassesPortable[number];

export interface RunnerExternalReferencePortableV1 {
  version: typeof RUNNER_EXTERNAL_REFERENCE_V1;
  kind: RunnerExternalReferenceKindPortable;
  adapterId: string;
  externalId: string | null;
  digest: string | null;
  uri: string | null;
  generation: number | null;
  createdAt: string;
  accessClass: RunnerReferenceAccessClassPortable;
  containsPrivateContent: false;
  containsCredentials: false;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialPattern = /(?:stn\.tok_|github_pat_|gh[pousr]_|sk-(?:proj-)?|Bearer\s+)[A-Za-z0-9._~+\/-]+/iu;

/**
 * Runtime-portable admission for the existing runner external-reference v1 wire shape.
 * Keep this module free of Node-only imports so Convex/workerd recovery code can reuse it.
 */
export function parseRunnerExternalReferencePortableV1(
  value: unknown,
): RunnerExternalReferencePortableV1 {
  const input = strictRecord(value, "Runner external reference", [
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
  ]);
  if (input.version !== RUNNER_EXTERNAL_REFERENCE_V1) {
    throw new RangeError(
      `Runner external reference version must be ${RUNNER_EXTERNAL_REFERENCE_V1}`,
    );
  }
  const externalId = nullableIdentifier(input.externalId, "Runner external ID");
  const digest = input.digest === null
    ? null
    : boundedPattern(input.digest, "Runner external digest", digestPattern, 71);
  const uri = nullableText(input.uri, "Runner external URI", 2_000);
  if (externalId === null && digest === null && uri === null) {
    throw new RangeError(
      "Runner external reference requires an external ID, digest, or URI",
    );
  }
  if (input.containsPrivateContent !== false || input.containsCredentials !== false) {
    throw new RangeError(
      "Runner external references must exclude private content and credentials",
    );
  }
  return deepFreeze({
    version: RUNNER_EXTERNAL_REFERENCE_V1,
    kind: exactEnum(
      input.kind,
      runnerExternalReferenceKindsPortable,
      "Runner external reference kind",
    ),
    adapterId: boundedIdentifier(input.adapterId, "Runner external adapter ID"),
    externalId,
    digest,
    uri,
    generation: nullableGeneration(input.generation, "Runner external generation"),
    createdAt: canonicalTimestamp(input.createdAt, "Runner external creation time"),
    accessClass: exactEnum(
      input.accessClass,
      runnerReferenceAccessClassesPortable,
      "Runner external access class",
    ),
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  const output = value as Record<string, unknown>;
  const unexpected = Object.keys(output).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new RangeError(`${label} contains unsupported field ${unexpected[0]}`);
  }
  return output;
}

function boundedIdentifier(value: unknown, label: string): string {
  return boundedPattern(value, label, identifierPattern, 160);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : boundedIdentifier(value, label);
}

function boundedPattern(
  value: unknown,
  label: string,
  pattern: RegExp,
  maximum: number,
): string {
  const text = boundedText(value, label, maximum);
  if (!pattern.test(text)) throw new RangeError(`${label} has an invalid format`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  const output = value.trim();
  if (!output || output.length > maximum || unsafeTextPattern.test(output)) {
    throw new RangeError(`${label} must contain from 1 to ${maximum} safe characters`);
  }
  if (credentialPattern.test(output)) {
    throw new RangeError(`${label} must not contain credential-shaped text`);
  }
  return output;
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedText(value, label, maximum);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 32) {
    throw new RangeError(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new RangeError(`${label} must be a valid timestamp`);
  const canonical = new Date(millis).toISOString();
  if (canonical !== value) throw new RangeError(`${label} must use canonical UTC milliseconds`);
  return canonical;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableGeneration(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function exactEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as Values[number];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
