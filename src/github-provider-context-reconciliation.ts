import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1 as BASE_SCHEMA_VERSION,
  compileGitHubProviderContextReconciliation as compileBase,
  type CurrentGitHubIssueContextIdentityV1 as BaseCurrentIdentity,
  type GitHubProviderContextReconciliationInputV1 as BaseInput,
  type GitHubProviderContextReconciliationNextAction as BaseNextAction,
  type GitHubProviderContextReconciliationOutcome as BaseOutcome,
  type GitHubProviderContextReconciliationProposalV1 as BaseProposal,
} from "./github-provider-context-reconciliation-base.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";

export const GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1 = BASE_SCHEMA_VERSION;

export type CurrentGitHubIssueContextIdentityV1 = BaseCurrentIdentity;
export type GitHubProviderContextReconciliationInputV1 = BaseInput;
export type GitHubProviderContextReconciliationNextAction = BaseNextAction;
export type GitHubProviderContextReconciliationOutcome = BaseOutcome;
export type GitHubProviderContextReconciliationProposalV1 = BaseProposal;

const inputKeys = ["schemaVersion", "receipt", "current"] as const;
const currentKeys = ["externalId", "sourceRevision"] as const;

type DataRecord = Record<string, unknown>;

/**
 * Applies the repository-wide retained-credential policy to the caller-owned
 * current identity before delegating a detached input to the reviewed compiler.
 */
export function compileGitHubProviderContextReconciliation(
  value: unknown,
): GitHubProviderContextReconciliationProposalV1 {
  const input = snapshotRecord(
    value,
    inputKeys,
    "GitHub provider context reconciliation input",
  );
  const current = input.current === null
    ? null
    : snapshotRecord(
      input.current,
      currentKeys,
      "Current GitHub issue context identity",
    );
  const sourceRevision = current?.sourceRevision;
  if (
    typeof sourceRevision === "string"
    && containsRealisticRetainedCredential(sourceRevision)
  ) {
    throw new RangeError(
      "Current GitHub issue source revision cannot be credential-shaped",
    );
  }
  return compileBase({
    schemaVersion: input.schemaVersion,
    receipt: input.receipt,
    current,
  });
}

function snapshotRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.some((key) =>
      typeof key !== "string" || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError(`${label} contains unknown fields`);
  }
  if (ownKeys.length !== keys.length) {
    throw new TypeError(`${label} is missing required fields`);
  }
  const output = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}
