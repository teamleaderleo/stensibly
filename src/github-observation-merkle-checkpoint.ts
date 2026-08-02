import { sha256, stableJson } from "./canonical-json.js";

export const GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1 = 1 as const;
export const GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1 =
  "sha256-canonical-json-merkle/v1" as const;

export interface GitHubObservationMerkleLeafInputV1 {
  sequence: number;
  observationId: string;
  semanticFingerprint: string;
}

export interface CompileGitHubObservationMerkleCheckpointInputV1 {
  version: typeof GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1;
  ledgerId: string;
  compilerId: string;
  createdAt: string;
  leaves: readonly GitHubObservationMerkleLeafInputV1[];
}

export interface GitHubObservationMerkleCheckpointV1 {
  readonly version: typeof GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1;
  readonly algorithm: typeof GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1;
  readonly ledgerId: string;
  readonly compilerId: string;
  readonly treeSize: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly rootDigest: string;
  readonly createdAt: string;
  readonly checkpointFingerprint: string;
}

export interface CreateGitHubObservationInclusionProofInputV1 {
  checkpoint: GitHubObservationMerkleCheckpointV1;
  leaves: readonly GitHubObservationMerkleLeafInputV1[];
  leafIndex: number;
}

export interface GitHubObservationInclusionProofV1 {
  readonly version: typeof GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1;
  readonly algorithm: typeof GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1;
  readonly ledgerId: string;
  readonly checkpointFingerprint: string;
  readonly treeSize: number;
  readonly leafIndex: number;
  readonly sequence: number;
  readonly observationId: string;
  readonly semanticFingerprint: string;
  readonly leafDigest: string;
  readonly auditPath: readonly string[];
  readonly proofFingerprint: string;
}

export interface CreateGitHubObservationConsistencyProofInputV1 {
  olderCheckpoint: GitHubObservationMerkleCheckpointV1;
  newerCheckpoint: GitHubObservationMerkleCheckpointV1;
  newerLeaves: readonly GitHubObservationMerkleLeafInputV1[];
}

export interface GitHubObservationConsistencyProofV1 {
  readonly version: typeof GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1;
  readonly algorithm: typeof GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1;
  readonly ledgerId: string;
  readonly compilerId: string;
  readonly olderTreeSize: number;
  readonly newerTreeSize: number;
  readonly olderCheckpointFingerprint: string;
  readonly newerCheckpointFingerprint: string;
  readonly auditPath: readonly string[];
  readonly proofFingerprint: string;
}

const compileKeys = ["version", "ledgerId", "compilerId", "createdAt", "leaves"] as const;
const leafKeys = ["sequence", "observationId", "semanticFingerprint"] as const;
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

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const unsafeIdentityPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const maximumLeaves = 4_096;
const maximumAuditPath = 64;
const leafDomain = "stensibly.github-observation-merkle.leaf/v1";
const nodeDomain = "stensibly.github-observation-merkle.node/v1";
const emptyDomain = "stensibly.github-observation-merkle.empty/v1";

type DataRecord = Record<string, unknown>;
type AdmittedLeaf = Readonly<GitHubObservationMerkleLeafInputV1>;

export function compileGitHubObservationMerkleCheckpointV1(
  value: unknown,
): GitHubObservationMerkleCheckpointV1 {
  const input = exactRecord(value, compileKeys, "GitHub observation Merkle checkpoint input");
  if (input.version !== GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1) {
    throw new RangeError("GitHub observation Merkle checkpoint version is unsupported");
  }
  const ledgerId = boundedIdentity(input.ledgerId, "Observation ledger ID", 160);
  const compilerId = boundedIdentity(input.compilerId, "Observation checkpoint compiler ID", 160);
  const createdAt = canonicalTimestamp(input.createdAt, "Observation checkpoint creation time");
  const leaves = admitLeaves(input.leaves);
  return compileCheckpoint({ ledgerId, compilerId, createdAt, leaves });
}

export function createGitHubObservationInclusionProofV1(
  value: unknown,
): GitHubObservationInclusionProofV1 {
  const input = exactRecord(value, inclusionInputKeys, "GitHub observation inclusion proof input");
  const checkpoint = admitCheckpoint(input.checkpoint);
  if (checkpoint.treeSize === 0) {
    throw new RangeError("An empty observation checkpoint has no inclusion proof");
  }
  const leaves = admitLeaves(input.leaves);
  const leafIndex = nonNegativeInteger(input.leafIndex, "Observation inclusion leaf index");
  if (leafIndex >= leaves.length) {
    throw new RangeError("Observation inclusion leaf index is outside the tree");
  }
  const recomputed = compileCheckpoint({
    ledgerId: checkpoint.ledgerId,
    compilerId: checkpoint.compilerId,
    createdAt: checkpoint.createdAt,
    leaves,
  });
  if (recomputed.checkpointFingerprint !== checkpoint.checkpointFingerprint) {
    throw new RangeError("Observation inclusion leaves do not match the checkpoint");
  }
  const leaf = leaves[leafIndex]!;
  const digests = leaves.map((entry) => hashLeaf(checkpoint.ledgerId, entry));
  const proof = {
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
    ledgerId: checkpoint.ledgerId,
    checkpointFingerprint: checkpoint.checkpointFingerprint,
    treeSize: checkpoint.treeSize,
    leafIndex,
    sequence: leaf.sequence,
    observationId: leaf.observationId,
    semanticFingerprint: leaf.semanticFingerprint,
    leafDigest: digests[leafIndex]!,
    auditPath: Object.freeze(inclusionPath(digests, leafIndex)),
  };
  return deepFreeze({
    ...proof,
    proofFingerprint: sha256(stableJson(proof)),
  });
}

export function verifyGitHubObservationInclusionProofV1(
  checkpointValue: unknown,
  proofValue: unknown,
): boolean {
  const checkpoint = admitCheckpoint(checkpointValue);
  const proof = admitInclusionProof(proofValue);
  if (
    checkpoint.treeSize === 0
    || proof.ledgerId !== checkpoint.ledgerId
    || proof.checkpointFingerprint !== checkpoint.checkpointFingerprint
    || proof.treeSize !== checkpoint.treeSize
    || proof.leafIndex >= checkpoint.treeSize
  ) {
    return false;
  }
  const leafDigest = hashLeaf(checkpoint.ledgerId, {
    sequence: proof.sequence,
    observationId: proof.observationId,
    semanticFingerprint: proof.semanticFingerprint,
  });
  if (leafDigest !== proof.leafDigest) return false;
  const root = rootFromInclusionProof(
    leafDigest,
    proof.leafIndex,
    proof.treeSize,
    proof.auditPath,
  );
  return root === checkpoint.rootDigest;
}

export function createGitHubObservationConsistencyProofV1(
  value: unknown,
): GitHubObservationConsistencyProofV1 {
  const input = exactRecord(value, consistencyInputKeys, "GitHub observation consistency proof input");
  const older = admitCheckpoint(input.olderCheckpoint);
  const newer = admitCheckpoint(input.newerCheckpoint);
  assertCheckpointProgression(older, newer);
  const leaves = admitLeaves(input.newerLeaves);
  const recomputedNewer = compileCheckpoint({
    ledgerId: newer.ledgerId,
    compilerId: newer.compilerId,
    createdAt: newer.createdAt,
    leaves,
  });
  if (recomputedNewer.checkpointFingerprint !== newer.checkpointFingerprint) {
    throw new RangeError("Observation consistency leaves do not match the newer checkpoint");
  }
  const olderLeaves = leaves.slice(0, older.treeSize);
  const recomputedOlder = compileCheckpoint({
    ledgerId: older.ledgerId,
    compilerId: older.compilerId,
    createdAt: older.createdAt,
    leaves: olderLeaves,
  });
  if (recomputedOlder.checkpointFingerprint !== older.checkpointFingerprint) {
    throw new RangeError("The older checkpoint is not a prefix of the newer observation history");
  }
  const digests = leaves.map((entry) => hashLeaf(newer.ledgerId, entry));
  const proof = {
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
    ledgerId: newer.ledgerId,
    compilerId: newer.compilerId,
    olderTreeSize: older.treeSize,
    newerTreeSize: newer.treeSize,
    olderCheckpointFingerprint: older.checkpointFingerprint,
    newerCheckpointFingerprint: newer.checkpointFingerprint,
    auditPath: Object.freeze(consistencyPath(digests, older.treeSize)),
  };
  return deepFreeze({
    ...proof,
    proofFingerprint: sha256(stableJson(proof)),
  });
}

export function verifyGitHubObservationConsistencyProofV1(
  olderCheckpointValue: unknown,
  newerCheckpointValue: unknown,
  proofValue: unknown,
): boolean {
  const older = admitCheckpoint(olderCheckpointValue);
  const newer = admitCheckpoint(newerCheckpointValue);
  const proof = admitConsistencyProof(proofValue);
  if (!checkpointProgressionMatches(older, newer)) return false;
  if (
    proof.ledgerId !== older.ledgerId
    || proof.compilerId !== older.compilerId
    || proof.olderTreeSize !== older.treeSize
    || proof.newerTreeSize !== newer.treeSize
    || proof.olderCheckpointFingerprint !== older.checkpointFingerprint
    || proof.newerCheckpointFingerprint !== newer.checkpointFingerprint
  ) {
    return false;
  }
  return verifyConsistencyPath(
    older.treeSize,
    newer.treeSize,
    older.rootDigest,
    newer.rootDigest,
    proof.auditPath,
  );
}

function compileCheckpoint(input: {
  ledgerId: string;
  compilerId: string;
  createdAt: string;
  leaves: readonly AdmittedLeaf[];
}): GitHubObservationMerkleCheckpointV1 {
  const digests = input.leaves.map((leaf) => hashLeaf(input.ledgerId, leaf));
  const data = {
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
    ledgerId: input.ledgerId,
    compilerId: input.compilerId,
    treeSize: input.leaves.length,
    firstSequence: input.leaves[0]?.sequence ?? null,
    lastSequence: input.leaves.at(-1)?.sequence ?? null,
    rootDigest: digests.length === 0
      ? hashEmpty(input.ledgerId)
      : treeHash(digests, 0, digests.length),
    createdAt: input.createdAt,
  };
  return deepFreeze({
    ...data,
    checkpointFingerprint: sha256(stableJson(data)),
  });
}

function admitCheckpoint(value: unknown): GitHubObservationMerkleCheckpointV1 {
  const input = exactRecord(value, checkpointKeys, "GitHub observation Merkle checkpoint");
  if (
    input.version !== GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1
    || input.algorithm !== GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1
  ) {
    throw new RangeError("GitHub observation Merkle checkpoint contract is unsupported");
  }
  const treeSize = boundedCount(input.treeSize, "Observation checkpoint tree size", maximumLeaves);
  const firstSequence = nullablePositiveInteger(
    input.firstSequence,
    "Observation checkpoint first sequence",
  );
  const lastSequence = nullablePositiveInteger(
    input.lastSequence,
    "Observation checkpoint last sequence",
  );
  if (
    (treeSize === 0 && (firstSequence !== null || lastSequence !== null))
    || (treeSize > 0 && (firstSequence === null || lastSequence === null))
    || (
      treeSize > 0
      && firstSequence !== null
      && lastSequence !== null
      && lastSequence - firstSequence + 1 !== treeSize
    )
  ) {
    throw new RangeError("Observation checkpoint sequence range is inconsistent");
  }
  const data = {
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
    ledgerId: boundedIdentity(input.ledgerId, "Observation ledger ID", 160),
    compilerId: boundedIdentity(input.compilerId, "Observation checkpoint compiler ID", 160),
    treeSize,
    firstSequence,
    lastSequence,
    rootDigest: digest(input.rootDigest, "Observation checkpoint root digest"),
    createdAt: canonicalTimestamp(input.createdAt, "Observation checkpoint creation time"),
  };
  const checkpointFingerprint = digest(
    input.checkpointFingerprint,
    "Observation checkpoint fingerprint",
  );
  if (sha256(stableJson(data)) !== checkpointFingerprint) {
    throw new RangeError("Observation checkpoint fingerprint did not match its fields");
  }
  return deepFreeze({ ...data, checkpointFingerprint });
}

function admitInclusionProof(value: unknown): GitHubObservationInclusionProofV1 {
  const input = exactRecord(value, inclusionProofKeys, "GitHub observation inclusion proof");
  if (
    input.version !== GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1
    || input.algorithm !== GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1
  ) {
    throw new RangeError("GitHub observation inclusion proof contract is unsupported");
  }
  const data = {
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
    ledgerId: boundedIdentity(input.ledgerId, "Observation ledger ID", 160),
    checkpointFingerprint: digest(
      input.checkpointFingerprint,
      "Observation inclusion checkpoint fingerprint",
    ),
    treeSize: positiveInteger(input.treeSize, "Observation inclusion tree size"),
    leafIndex: nonNegativeInteger(input.leafIndex, "Observation inclusion leaf index"),
    sequence: positiveInteger(input.sequence, "Observation inclusion sequence"),
    observationId: boundedIdentity(input.observationId, "Observation ID", 512),
    semanticFingerprint: digest(
      input.semanticFingerprint,
      "Observation semantic fingerprint",
    ),
    leafDigest: digest(input.leafDigest, "Observation inclusion leaf digest"),
    auditPath: Object.freeze(admitDigestPath(input.auditPath, "Observation inclusion audit path")),
  };
  if (data.treeSize > maximumLeaves || data.leafIndex >= data.treeSize) {
    throw new RangeError("Observation inclusion proof tree position is invalid");
  }
  const proofFingerprint = digest(input.proofFingerprint, "Observation inclusion proof fingerprint");
  if (sha256(stableJson(data)) !== proofFingerprint) {
    throw new RangeError("Observation inclusion proof fingerprint did not match its fields");
  }
  return deepFreeze({ ...data, proofFingerprint });
}

function admitConsistencyProof(value: unknown): GitHubObservationConsistencyProofV1 {
  const input = exactRecord(value, consistencyProofKeys, "GitHub observation consistency proof");
  if (
    input.version !== GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1
    || input.algorithm !== GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1
  ) {
    throw new RangeError("GitHub observation consistency proof contract is unsupported");
  }
  const data = {
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
    ledgerId: boundedIdentity(input.ledgerId, "Observation ledger ID", 160),
    compilerId: boundedIdentity(input.compilerId, "Observation checkpoint compiler ID", 160),
    olderTreeSize: boundedCount(
      input.olderTreeSize,
      "Older observation checkpoint tree size",
      maximumLeaves,
    ),
    newerTreeSize: boundedCount(
      input.newerTreeSize,
      "Newer observation checkpoint tree size",
      maximumLeaves,
    ),
    olderCheckpointFingerprint: digest(
      input.olderCheckpointFingerprint,
      "Older observation checkpoint fingerprint",
    ),
    newerCheckpointFingerprint: digest(
      input.newerCheckpointFingerprint,
      "Newer observation checkpoint fingerprint",
    ),
    auditPath: Object.freeze(admitDigestPath(input.auditPath, "Observation consistency audit path")),
  };
  if (data.olderTreeSize > data.newerTreeSize) {
    throw new RangeError("Observation consistency proof cannot shrink history");
  }
  const proofFingerprint = digest(input.proofFingerprint, "Observation consistency proof fingerprint");
  if (sha256(stableJson(data)) !== proofFingerprint) {
    throw new RangeError("Observation consistency proof fingerprint did not match its fields");
  }
  return deepFreeze({ ...data, proofFingerprint });
}

function admitLeaves(value: unknown): readonly AdmittedLeaf[] {
  const source = exactArray(value, "Observation Merkle leaves", 0, maximumLeaves);
  const leaves = source.map((entry, index) => {
    const leaf = exactRecord(entry, leafKeys, `Observation Merkle leaf ${index}`);
    return Object.freeze({
      sequence: positiveInteger(leaf.sequence, `Observation Merkle leaf ${index} sequence`),
      observationId: boundedIdentity(
        leaf.observationId,
        `Observation Merkle leaf ${index} ID`,
        512,
      ),
      semanticFingerprint: digest(
        leaf.semanticFingerprint,
        `Observation Merkle leaf ${index} semantic fingerprint`,
      ),
    });
  });
  for (let index = 1; index < leaves.length; index += 1) {
    if (leaves[index]!.sequence !== leaves[index - 1]!.sequence + 1) {
      throw new RangeError("Observation Merkle leaf sequences must be contiguous and ordered");
    }
  }
  return Object.freeze(leaves);
}

function hashLeaf(ledgerId: string, leaf: AdmittedLeaf): string {
  return sha256(stableJson({
    domain: leafDomain,
    ledgerId,
    sequence: leaf.sequence,
    observationId: leaf.observationId,
    semanticFingerprint: leaf.semanticFingerprint,
  }));
}

function hashNode(left: string, right: string): string {
  return sha256(stableJson({ domain: nodeDomain, left, right }));
}

function hashEmpty(ledgerId: string): string {
  return sha256(stableJson({ domain: emptyDomain, ledgerId }));
}

function treeHash(digests: readonly string[], start: number, length: number): string {
  if (length === 1) return digests[start]!;
  const split = largestPowerOfTwoLessThan(length);
  return hashNode(
    treeHash(digests, start, split),
    treeHash(digests, start + split, length - split),
  );
}

function inclusionPath(digests: readonly string[], leafIndex: number): string[] {
  return inclusionSubpath(digests, 0, digests.length, leafIndex);
}

function inclusionSubpath(
  digests: readonly string[],
  start: number,
  length: number,
  leafIndex: number,
): string[] {
  if (length === 1) return [];
  const split = largestPowerOfTwoLessThan(length);
  if (leafIndex < split) {
    return [
      ...inclusionSubpath(digests, start, split, leafIndex),
      treeHash(digests, start + split, length - split),
    ];
  }
  return [
    ...inclusionSubpath(digests, start + split, length - split, leafIndex - split),
    treeHash(digests, start, split),
  ];
}

function rootFromInclusionProof(
  leafDigest: string,
  leafIndex: number,
  treeSize: number,
  auditPath: readonly string[],
): string | null {
  let node = leafDigest;
  let leaf = leafIndex;
  let last = treeSize - 1;
  for (const sibling of auditPath) {
    if (leaf % 2 === 1 || leaf === last) {
      node = hashNode(sibling, node);
      while (leaf !== 0 && leaf % 2 === 0) {
        leaf = Math.floor(leaf / 2);
        last = Math.floor(last / 2);
      }
    } else {
      node = hashNode(node, sibling);
    }
    leaf = Math.floor(leaf / 2);
    last = Math.floor(last / 2);
  }
  return last === 0 ? node : null;
}

function consistencyPath(digests: readonly string[], olderSize: number): string[] {
  if (olderSize === 0 || olderSize === digests.length) return [];
  return consistencySubpath(digests, 0, olderSize, digests.length, true);
}

function consistencySubpath(
  digests: readonly string[],
  start: number,
  olderSize: number,
  newerSize: number,
  includeOldRoot: boolean,
): string[] {
  if (olderSize === newerSize) {
    return includeOldRoot ? [] : [treeHash(digests, start, newerSize)];
  }
  const split = largestPowerOfTwoLessThan(newerSize);
  if (olderSize <= split) {
    return [
      ...consistencySubpath(
        digests,
        start,
        olderSize,
        split,
        includeOldRoot,
      ),
      treeHash(digests, start + split, newerSize - split),
    ];
  }
  return [
    ...consistencySubpath(
      digests,
      start + split,
      olderSize - split,
      newerSize - split,
      false,
    ),
    treeHash(digests, start, split),
  ];
}

function verifyConsistencyPath(
  olderSize: number,
  newerSize: number,
  olderRoot: string,
  newerRoot: string,
  auditPath: readonly string[],
): boolean {
  if (olderSize === 0) return auditPath.length === 0;
  if (olderSize === newerSize) {
    return auditPath.length === 0 && olderRoot === newerRoot;
  }
  if (auditPath.length === 0) return false;
  let olderNode = olderSize - 1;
  let newerNode = newerSize - 1;
  while (olderNode % 2 === 1) {
    olderNode = Math.floor(olderNode / 2);
    newerNode = Math.floor(newerNode / 2);
  }
  let index = 0;
  let olderHash: string;
  let newerHash: string;
  if (olderNode === 0) {
    olderHash = olderRoot;
    newerHash = olderRoot;
  } else {
    olderHash = auditPath[index]!;
    newerHash = auditPath[index]!;
    index += 1;
  }
  for (; index < auditPath.length; index += 1) {
    if (newerNode === 0) return false;
    const hash = auditPath[index]!;
    if (olderNode % 2 === 1 || olderNode === newerNode) {
      olderHash = hashNode(hash, olderHash);
      newerHash = hashNode(hash, newerHash);
      while (olderNode !== 0 && olderNode % 2 === 0) {
        olderNode = Math.floor(olderNode / 2);
        newerNode = Math.floor(newerNode / 2);
      }
    } else {
      newerHash = hashNode(newerHash, hash);
    }
    olderNode = Math.floor(olderNode / 2);
    newerNode = Math.floor(newerNode / 2);
  }
  return newerNode === 0 && olderHash === olderRoot && newerHash === newerRoot;
}

function assertCheckpointProgression(
  older: GitHubObservationMerkleCheckpointV1,
  newer: GitHubObservationMerkleCheckpointV1,
): void {
  if (!checkpointProgressionMatches(older, newer)) {
    throw new RangeError("Observation checkpoints do not describe one append-only ledger progression");
  }
}

function checkpointProgressionMatches(
  older: GitHubObservationMerkleCheckpointV1,
  newer: GitHubObservationMerkleCheckpointV1,
): boolean {
  if (
    older.ledgerId !== newer.ledgerId
    || older.compilerId !== newer.compilerId
    || older.algorithm !== newer.algorithm
    || older.treeSize > newer.treeSize
    || Date.parse(older.createdAt) > Date.parse(newer.createdAt)
  ) {
    return false;
  }
  if (older.treeSize === 0) return true;
  return older.firstSequence === newer.firstSequence
    && older.firstSequence !== null
    && older.lastSequence === older.firstSequence + older.treeSize - 1
    && newer.lastSequence === older.firstSequence + newer.treeSize - 1;
}

function largestPowerOfTwoLessThan(value: number): number {
  if (value < 2) throw new RangeError("Merkle subtree must contain at least two leaves");
  let power = 1;
  while (power * 2 < value) power *= 2;
  return power;
}

function admitDigestPath(value: unknown, label: string): string[] {
  return exactArray(value, label, 0, maximumAuditPath)
    .map((entry, index) => digest(entry, `${label} entry ${index}`));
}

function exactRecord<const K extends readonly string[]>(
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
  if (ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
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

function exactArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw new RangeError(`${label} length is outside the accepted range`);
  }
  const allowed = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain dense enumerable data properties`);
    }
    return descriptor.value;
  });
}

function boundedIdentity(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || unsafeIdentityPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || Object.is(value, -0)
  ) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedCount(value: unknown, label: string, maximum: number): number {
  const count = nonNegativeInteger(value, label);
  if (count > maximum) throw new RangeError(`${label} exceeds ${maximum}`);
  return count;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveInteger(value, label);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError(`${label} must be canonical UTC text`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be canonical UTC text`);
  }
  const normalized = new Date(milliseconds).toISOString();
  const canonical = value.includes(".")
    ? normalized === value
    : normalized.replace(/\.000Z$/u, "Z") === value;
  if (!canonical) throw new RangeError(`${label} must be canonical UTC text`);
  return normalized;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return value;
}
