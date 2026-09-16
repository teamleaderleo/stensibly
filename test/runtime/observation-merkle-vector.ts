import { sha256, stableJson } from "../../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationConsistencyProofV1,
  createGitHubObservationInclusionProofV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  verifyGitHubObservationConsistencyProofV1,
  verifyGitHubObservationInclusionProofV1,
} from "../../src/github-observation-merkle-checkpoint.ts";

const ledgerId = "workspace/runtime-parity/github-observations";
const compilerId = "github-observation-merkle/v1";
const leaves = Array.from({ length: 7 }, (_, index) => ({
  sequence: index + 41,
  observationId: `github:runtime-parity:delivery-${index + 1}`,
  semanticFingerprint: sha256(stableJson({
    repository: "teamleaderleo/stensibly",
    sequence: index + 41,
    state: index % 2 === 0 ? "open" : "closed",
  })),
}));

const older = compileGitHubObservationMerkleCheckpointV1({
  version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  ledgerId,
  compilerId,
  createdAt: "2026-08-03T01:20:00Z",
  leaves: leaves.slice(0, 3),
});
const newer = compileGitHubObservationMerkleCheckpointV1({
  version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  ledgerId,
  compilerId,
  createdAt: "2026-08-03T01:21:00Z",
  leaves,
});
const inclusion = createGitHubObservationInclusionProofV1({
  checkpoint: newer,
  leaves,
  leafIndex: 5,
});
const consistency = createGitHubObservationConsistencyProofV1({
  olderCheckpoint: older,
  newerCheckpoint: newer,
  newerLeaves: leaves,
});

if (!verifyGitHubObservationInclusionProofV1(newer, inclusion)) {
  throw new Error("Observation Merkle inclusion vector did not verify");
}
if (!verifyGitHubObservationConsistencyProofV1(older, newer, consistency)) {
  throw new Error("Observation Merkle consistency vector did not verify");
}

console.log(JSON.stringify({
  olderRootDigest: older.rootDigest,
  newerRootDigest: newer.rootDigest,
  olderCheckpointFingerprint: older.checkpointFingerprint,
  newerCheckpointFingerprint: newer.checkpointFingerprint,
  inclusionProofFingerprint: inclusion.proofFingerprint,
  consistencyProofFingerprint: consistency.proofFingerprint,
}));
