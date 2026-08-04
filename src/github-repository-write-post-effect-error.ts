import type {
  RepositoryWriteProviderResult,
} from "./repository-write-fence.js";

const resultKeys = [
  "commitSha",
  "providerRequestId",
  "targetRef",
  "parentSha",
] as const;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const credentialShapedPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

export type GitHubRepositoryWritePostEffectCode =
  "repository_write_effect_readback_incomplete";

/**
 * Carries only strictly admitted provider effect identity after publication.
 * The service must still bind this result to the prepared write and canonical
 * provider state before retaining it as verified reconciliation evidence.
 */
export class GitHubRepositoryWritePostEffectError extends Error {
  readonly code: GitHubRepositoryWritePostEffectCode;
  readonly result: Readonly<RepositoryWriteProviderResult>;

  constructor(input: unknown) {
    const record = exactRecord(input, ["code", "result"]);
    if (record.code !== "repository_write_effect_readback_incomplete") {
      throw new TypeError("GitHub repository write post-effect code is invalid");
    }
    super("GitHub repository write effect readback requires reconciliation");
    this.name = "GitHubRepositoryWritePostEffectError";
    this.code = record.code;
    this.result = admitResult(record.result);
    Object.freeze(this);
  }
}

function admitResult(value: unknown): Readonly<RepositoryWriteProviderResult> {
  const record = exactRecord(value, resultKeys);
  const commitSha = objectId(record.commitSha, "commit");
  const parentSha = optionalObjectId(record.parentSha, "parent");
  const targetRef = exactText(record.targetRef, 240, "target ref");
  const providerRequestId = record.providerRequestId === undefined
    ? undefined
    : requestId(record.providerRequestId);
  const result: RepositoryWriteProviderResult = {
    commitSha,
    targetRef,
    ...(parentSha ? { parentSha } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
  };
  return Object.freeze(result);
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitHub repository write post-effect evidence is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("GitHub repository write post-effect evidence is invalid");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("GitHub repository write post-effect evidence is invalid");
  }
  const allowed = new Set(allowedKeys);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !allowed.has(key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new TypeError("GitHub repository write post-effect evidence is invalid");
    }
    result[key] = descriptor.value;
  }
  for (const key of allowedKeys) {
    if (key === "providerRequestId" || key === "parentSha") continue;
    if (!Object.hasOwn(result, key)) {
      throw new TypeError("GitHub repository write post-effect evidence is invalid");
    }
  }
  return result;
}

function objectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !objectIdPattern.test(value)) {
    throw new TypeError(`GitHub repository write post-effect ${label} identity is invalid`);
  }
  return value;
}

function optionalObjectId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : objectId(value, label);
}

function requestId(value: unknown): string {
  if (
    typeof value !== "string"
    || !requestIdPattern.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw new TypeError("GitHub repository write post-effect request identity is invalid");
  }
  return value;
}

function exactText(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || !/^[\x20-\x7e]+$/u.test(value)
    || credentialShapedPattern.test(value)
  ) {
    throw new TypeError(`GitHub repository write post-effect ${label} is invalid`);
  }
  return value;
}
