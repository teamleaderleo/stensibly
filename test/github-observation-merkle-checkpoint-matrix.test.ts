import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationConsistencyProofV1,
  createGitHubObservationInclusionProofV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  type GitHubObservationConsistencyProofV1,
  type GitHubObservationInclusionProofV1,
  type GitHubObservationMerkleLeafInputV1,
  verifyGitHubObservationConsistencyProofV1,
  verifyGitHubObservationInclusionProofV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const ledgerId = "workspace/merkle-matrix/github-observations";
const compilerId = "github-observation-merkle/v1";
const firstSequence = 701;

describe("GitHub observation Merkle proof matrix", () => {
  test("verifies inclusion for every index across tree sizes one through sixteen", () => {
    for (let treeSize = 1; treeSize <= 16; treeSize += 1) {
      const source = leaves(treeSize);
      const checkpoint = compile(source, timestamp(treeSize));
      for (let leafIndex = 0; leafIndex < treeSize; leafIndex += 1) {
        const proof = createGitHubObservationInclusionProofV1({
          checkpoint,
          leaves: source,
          leafIndex,
        });
        expect(
          verifyGitHubObservationInclusionProofV1(checkpoint, proof),
          `treeSize=${treeSize} leafIndex=${leafIndex}`,
        ).toBe(true);
        expect(proof.auditPath.length).toBeLessThanOrEqual(
          Math.ceil(Math.log2(treeSize)),
        );
      }
    }
  });

  test("verifies every append-only prefix pair through tree size sixteen", () => {
    const source = leaves(16);
    for (let newerSize = 0; newerSize <= source.length; newerSize += 1) {
      const newer = compile(source.slice(0, newerSize), timestamp(40 + newerSize));
      for (let olderSize = 0; olderSize <= newerSize; olderSize += 1) {
        const older = compile(source.slice(0, olderSize), timestamp(olderSize));
        const proof = createGitHubObservationConsistencyProofV1({
          olderCheckpoint: older,
          newerCheckpoint: newer,
          newerLeaves: source.slice(0, newerSize),
        });
        expect(
          verifyGitHubObservationConsistencyProofV1(older, newer, proof),
          `olderSize=${olderSize} newerSize=${newerSize}`,
        ).toBe(true);
        expect(proof.auditPath.length).toBeLessThanOrEqual(8);
      }
    }
  });

  test("rejects one-bit-equivalent path substitution after proof refingerprinting", () => {
    const source = leaves(13);
    const newer = compile(source, timestamp(50));
    const older = compile(source.slice(0, 6), timestamp(6));
    const consistency = createGitHubObservationConsistencyProofV1({
      olderCheckpoint: older,
      newerCheckpoint: newer,
      newerLeaves: source,
    });
    const inclusion = createGitHubObservationInclusionProofV1({
      checkpoint: newer,
      leaves: source,
      leafIndex: 9,
    });

    const changedConsistency = refingerprintConsistency({
      ...consistency,
      auditPath: replaceFirst(consistency.auditPath),
    });
    const changedInclusion = refingerprintInclusion({
      ...inclusion,
      auditPath: replaceFirst(inclusion.auditPath),
    });

    expect(
      verifyGitHubObservationConsistencyProofV1(
        older,
        newer,
        changedConsistency,
      ),
    ).toBe(false);
    expect(
      verifyGitHubObservationInclusionProofV1(newer, changedInclusion),
    ).toBe(false);
  });
});

function compile(
  source: readonly GitHubObservationMerkleLeafInputV1[],
  createdAt: string,
) {
  return compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId,
    compilerId,
    createdAt,
    leaves: source,
  });
}

function leaves(count: number): GitHubObservationMerkleLeafInputV1[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: firstSequence + index,
    observationId: `github:matrix:delivery-${index + 1}`,
    semanticFingerprint: sha256(stableJson({
      repository: "teamleaderleo/stensibly",
      sequence: firstSequence + index,
      state: index % 3 === 0 ? "open" : "closed",
    })),
  }));
}

function timestamp(offsetMinutes: number): string {
  return new Date(Date.parse("2026-08-03T02:00:00Z") + offsetMinutes * 60_000)
    .toISOString();
}

function replaceFirst(path: readonly string[]): readonly string[] {
  if (path.length === 0) throw new Error("Expected a non-empty proof path");
  return [sha256("substituted Merkle sibling"), ...path.slice(1)];
}

function refingerprintConsistency(
  proof: GitHubObservationConsistencyProofV1,
): GitHubObservationConsistencyProofV1 {
  const { proofFingerprint: _discarded, ...body } = proof;
  return {
    ...body,
    auditPath: [...body.auditPath],
    proofFingerprint: sha256(stableJson(body)),
  };
}

function refingerprintInclusion(
  proof: GitHubObservationInclusionProofV1,
): GitHubObservationInclusionProofV1 {
  const { proofFingerprint: _discarded, ...body } = proof;
  return {
    ...body,
    auditPath: [...body.auditPath],
    proofFingerprint: sha256(stableJson(body)),
  };
}
