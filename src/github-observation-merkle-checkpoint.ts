import {
  compileGitHubObservationMerkleCheckpointV1 as compileBase,
  createGitHubObservationConsistencyProofV1 as createConsistencyBase,
  createGitHubObservationInclusionProofV1 as createInclusionBase,
  verifyGitHubObservationConsistencyProofV1 as verifyConsistencyBase,
  verifyGitHubObservationInclusionProofV1 as verifyInclusionBase,
} from "./github-observation-merkle-checkpoint-base.js";

export {
  GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
} from "./github-observation-merkle-checkpoint-base.js";
export type {
  CompileGitHubObservationMerkleCheckpointInputV1,
  CreateGitHubObservationConsistencyProofInputV1,
  CreateGitHubObservationInclusionProofInputV1,
  GitHubObservationConsistencyProofV1,
  GitHubObservationInclusionProofV1,
  GitHubObservationMerkleCheckpointV1,
  GitHubObservationMerkleLeafInputV1,
} from "./github-observation-merkle-checkpoint-base.js";

const compileKeys = [
  "version",
  "ledgerId",
  "compilerId",
  "createdAt",
  "leaves",
] as const;
const leafKeys = [
  "sequence",
  "observationId",
  "semanticFingerprint",
] as const;
const checkpointKeys = [
  "version",
  "algorithm",
  "ledgerId",
  "compilerId",
  "treeSize",
  "firstSequence",
  "lastSequence",
  "rootDigest",
  "createdAt",
  "checkpointFingerprint",
] as const;
const inclusionInputKeys = ["checkpoint", "leaves", "leafIndex"] as const;
const inclusionProofKeys = [
  "version",
  "algorithm",
  "ledgerId",
  "checkpointFingerprint",
  "treeSize",
  "leafIndex",
  "sequence",
  "observationId",
  "semanticFingerprint",
  "leafDigest",
  "auditPath",
  "proofFingerprint",
] as const;
const consistencyInputKeys = [
  "olderCheckpoint",
  "newerCheckpoint",
  "newerLeaves",
] as const;
const consistencyProofKeys = [
  "version",
  "algorithm",
  "ledgerId",
  "compilerId",
  "olderTreeSize",
  "newerTreeSize",
  "olderCheckpointFingerprint",
  "newerCheckpointFingerprint",
  "auditPath",
  "proofFingerprint",
] as const;

const maximumLeaves = 4_096;
const maximumAuditPath = 64;
const schemelessGitHubRoutePattern =
  /^(?:www\.)?github\.com\.?(?::443)?\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}\/(?:(?:issues|pull|discussions)\/[1-9][0-9]*|commit\/[0-9a-f]{7,64})(?:$|[\/#]|\.(?:patch|diff)(?:$|[\/#]))/iu;

type DataRecord = Record<string, unknown>;

export function compileGitHubObservationMerkleCheckpointV1(
  value: unknown,
): ReturnType<typeof compileBase> {
  const input = snapshotCompileInput(value);
  preflightCompileInput(input);
  return compileBase(input);
}

export function createGitHubObservationInclusionProofV1(
  value: unknown,
): ReturnType<typeof createInclusionBase> {
  const input = snapshotInclusionInput(value);
  preflightInclusionInput(input);
  return createInclusionBase(input);
}

export function verifyGitHubObservationInclusionProofV1(
  checkpointValue: unknown,
  proofValue: unknown,
): boolean {
  const checkpoint = snapshotCheckpoint(checkpointValue);
  const proof = snapshotInclusionProof(proofValue);
  preflightCheckpoint(checkpoint);
  preflightInclusionProof(proof);
  return verifyInclusionBase(checkpoint, proof);
}

export function createGitHubObservationConsistencyProofV1(
  value: unknown,
): ReturnType<typeof createConsistencyBase> {
  const input = snapshotConsistencyInput(value);
  preflightConsistencyInput(input);
  return createConsistencyBase(input);
}

export function verifyGitHubObservationConsistencyProofV1(
  olderCheckpointValue: unknown,
  newerCheckpointValue: unknown,
  proofValue: unknown,
): boolean {
  const olderCheckpoint = snapshotCheckpoint(olderCheckpointValue);
  const newerCheckpoint = snapshotCheckpoint(newerCheckpointValue);
  const proof = snapshotConsistencyProof(proofValue);
  preflightCheckpoint(olderCheckpoint);
  preflightCheckpoint(newerCheckpoint);
  preflightConsistencyProof(proof);
  return verifyConsistencyBase(
    olderCheckpoint,
    newerCheckpoint,
    proof,
  );
}

function snapshotCompileInput(value: unknown): DataRecord {
  const input = snapshotRecord(
    value,
    compileKeys,
    "GitHub observation Merkle checkpoint input",
  );
  input.leaves = snapshotLeaves(input.leaves);
  return input;
}

function snapshotInclusionInput(value: unknown): DataRecord {
  const input = snapshotRecord(
    value,
    inclusionInputKeys,
    "GitHub observation inclusion proof input",
  );
  input.checkpoint = snapshotCheckpoint(input.checkpoint);
  input.leaves = snapshotLeaves(input.leaves);
  return input;
}

function snapshotConsistencyInput(value: unknown): DataRecord {
  const input = snapshotRecord(
    value,
    consistencyInputKeys,
    "GitHub observation consistency proof input",
  );
  input.olderCheckpoint = snapshotCheckpoint(input.olderCheckpoint);
  input.newerCheckpoint = snapshotCheckpoint(input.newerCheckpoint);
  input.newerLeaves = snapshotLeaves(input.newerLeaves);
  return input;
}

function snapshotCheckpoint(value: unknown): DataRecord {
  return snapshotRecord(
    value,
    checkpointKeys,
    "GitHub observation Merkle checkpoint",
  );
}

function snapshotInclusionProof(value: unknown): DataRecord {
  const proof = snapshotRecord(
    value,
    inclusionProofKeys,
    "GitHub observation inclusion proof",
  );
  proof.auditPath = snapshotArray(
    proof.auditPath,
    "Observation inclusion audit path",
    0,
    maximumAuditPath,
  );
  return proof;
}

function snapshotConsistencyProof(value: unknown): DataRecord {
  const proof = snapshotRecord(
    value,
    consistencyProofKeys,
    "GitHub observation consistency proof",
  );
  proof.auditPath = snapshotArray(
    proof.auditPath,
    "Observation consistency audit path",
    0,
    maximumAuditPath,
  );
  return proof;
}

function snapshotLeaves(value: unknown): unknown[] {
  return snapshotArray(
    value,
    "Observation Merkle leaves",
    0,
    maximumLeaves,
  ).map((entry, index) =>
    snapshotRecord(
      entry,
      leafKeys,
      `Observation Merkle leaf ${index}`,
    )
  );
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
      typeof key !== "string"
      || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError(`${label} contains unknown fields`);
  }
  if (ownKeys.length !== keys.length) {
    throw new TypeError(`${label} is missing required fields`);
  }
  const result = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw new RangeError(`${label} length is outside the accepted range`);
  }
  const allowed = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (Reflect.ownKeys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain dense enumerable data properties`);
    }
    return descriptor.value;
  });
}

function preflightCompileInput(value: unknown): void {
  rejectDataIdentity(value, "ledgerId", "Observation ledger ID is invalid");
  rejectDataIdentity(
    value,
    "compilerId",
    "Observation checkpoint compiler ID is invalid",
  );
  preflightLeaves(dataProperty(value, "leaves"));
}

function preflightInclusionInput(value: unknown): void {
  preflightCheckpoint(dataProperty(value, "checkpoint"));
  preflightLeaves(dataProperty(value, "leaves"));
}

function preflightConsistencyInput(value: unknown): void {
  preflightCheckpoint(dataProperty(value, "olderCheckpoint"));
  preflightCheckpoint(dataProperty(value, "newerCheckpoint"));
  preflightLeaves(dataProperty(value, "newerLeaves"));
}

function preflightCheckpoint(value: unknown): void {
  rejectDataIdentity(value, "ledgerId", "Observation ledger ID is invalid");
  rejectDataIdentity(
    value,
    "compilerId",
    "Observation checkpoint compiler ID is invalid",
  );
}

function preflightInclusionProof(value: unknown): void {
  rejectDataIdentity(value, "ledgerId", "Observation ledger ID is invalid");
  rejectDataIdentity(
    value,
    "observationId",
    "Observation inclusion proof ID is invalid",
  );
}

function preflightConsistencyProof(value: unknown): void {
  rejectDataIdentity(value, "ledgerId", "Observation ledger ID is invalid");
  rejectDataIdentity(
    value,
    "compilerId",
    "Observation checkpoint compiler ID is invalid",
  );
}

function preflightLeaves(value: unknown): void {
  if (!Array.isArray(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = (
    descriptors as Record<string, PropertyDescriptor>
  ).length?.value;
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || length > maximumLeaves
  ) return;
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) continue;
    rejectDataIdentity(
      descriptor.value,
      "observationId",
      `Observation Merkle leaf ${index} ID is invalid`,
    );
  }
}

function rejectDataIdentity(
  value: unknown,
  key: string,
  message: string,
): void {
  const identity = dataProperty(value, key);
  if (
    typeof identity === "string"
    && schemelessGitHubRoutePattern.test(identity)
  ) {
    throw new RangeError(message);
  }
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
