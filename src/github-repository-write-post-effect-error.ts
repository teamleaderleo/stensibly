import {
  admitGitHubBranchRef,
  admitGitObjectId,
  containsGitHubRepositoryWriteCredential,
} from "./github-repository-write-admission.js";
import type {
  RepositoryWriteProviderResult,
} from "./repository-write-fence.js";

const inputKeys = ["code", "result"] as const;
const requiredResultKeys = ["commitSha", "targetRef"] as const;
const optionalResultKeys = ["providerRequestId", "parentSha"] as const;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type GitHubRepositoryWritePostEffectCode =
  "repository_write_effect_readback_incomplete";

/**
 * Carries only exact provider effect identity after publication. The service
 * must still bind this result to the prepared write and canonical provider
 * state before retaining it as verified reconciliation evidence.
 */
export class GitHubRepositoryWritePostEffectError extends Error {
  readonly code: GitHubRepositoryWritePostEffectCode;
  readonly result: Readonly<RepositoryWriteProviderResult>;

  constructor(input: unknown) {
    const record = exactRecord(input, inputKeys);
    if (record.code !== "repository_write_effect_readback_incomplete") {
      throw invalidEvidence();
    }
    const result = admitResult(record.result);
    super("GitHub repository write effect readback requires reconciliation");
    this.name = "GitHubRepositoryWritePostEffectError";
    this.code = record.code;
    this.result = result;
    Object.freeze(this);
  }
}

function admitResult(value: unknown): Readonly<RepositoryWriteProviderResult> {
  const record = exactRecord(
    value,
    requiredResultKeys,
    optionalResultKeys,
  );
  const commitSha = admittedObjectId(record.commitSha);
  const targetRef = admittedTargetRef(record.targetRef);
  const parentSha = record.parentSha === undefined
    ? undefined
    : admittedObjectId(record.parentSha);
  const providerRequestId = record.providerRequestId === undefined
    ? undefined
    : admittedRequestId(record.providerRequestId);
  return Object.freeze({
    commitSha,
    targetRef,
    ...(parentSha === undefined ? {} : { parentSha }),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  });
}

function admittedObjectId(value: unknown): string {
  try {
    return admitGitObjectId(value);
  } catch {
    throw invalidEvidence();
  }
}

function admittedTargetRef(value: unknown): string {
  try {
    return admitGitHubBranchRef(value);
  } catch {
    throw invalidEvidence();
  }
}

function admittedRequestId(value: unknown): string {
  if (
    typeof value !== "string"
    || !requestIdPattern.test(value)
    || containsGitHubRepositoryWriteCredential(value)
  ) {
    throw invalidEvidence();
  }
  return value;
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  required: K,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidEvidence();
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw invalidEvidence();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidEvidence();
  }

  const requiredSet = new Set<string>(required);
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of [...required, ...optional]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw invalidEvidence();
    }
    if (descriptor === undefined) {
      if (requiredSet.has(key)) throw invalidEvidence();
      continue;
    }
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw invalidEvidence();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function invalidEvidence(): TypeError {
  return new TypeError("GitHub repository write post-effect evidence is invalid");
}
