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

const maximumLeaves = 4_096;
const schemelessGitHubRoutePattern =
  /^(?:www\.)?github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}\/(?:(?:issues|pull|discussions)\/[1-9][0-9]*|commit\/[0-9a-f]{7,40})$/iu;

export function compileGitHubObservationMerkleCheckpointV1(
  value: unknown,
): ReturnType<typeof compileBase> {
  preflightCompileInput(value);
  return compileBase(value);
}

export function createGitHubObservationInclusionProofV1(
  value: unknown,
): ReturnType<typeof createInclusionBase> {
  preflightInclusionInput(value);
  return createInclusionBase(value);
}

export function verifyGitHubObservationInclusionProofV1(
  checkpointValue: unknown,
  proofValue: unknown,
): boolean {
  preflightCheckpoint(checkpointValue);
  preflightInclusionProof(proofValue);
  return verifyInclusionBase(checkpointValue, proofValue);
}

export function createGitHubObservationConsistencyProofV1(
  value: unknown,
): ReturnType<typeof createConsistencyBase> {
  preflightConsistencyInput(value);
  return createConsistencyBase(value);
}

export function verifyGitHubObservationConsistencyProofV1(
  olderCheckpointValue: unknown,
  newerCheckpointValue: unknown,
  proofValue: unknown,
): boolean {
  preflightCheckpoint(olderCheckpointValue);
  preflightCheckpoint(newerCheckpointValue);
  preflightConsistencyProof(proofValue);
  return verifyConsistencyBase(
    olderCheckpointValue,
    newerCheckpointValue,
    proofValue,
  );
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
  const length = descriptors.length?.value;
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
