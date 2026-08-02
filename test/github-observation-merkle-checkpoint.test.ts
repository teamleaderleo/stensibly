import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationConsistencyProofV1,
  createGitHubObservationInclusionProofV1,
  GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  type GitHubObservationConsistencyProofV1,
  type GitHubObservationInclusionProofV1,
  type GitHubObservationMerkleCheckpointV1,
  type GitHubObservationMerkleLeafInputV1,
  verifyGitHubObservationConsistencyProofV1,
  verifyGitHubObservationInclusionProofV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const ledgerId = "workspace/oauth-dogfood/github-observations";
const compilerId = "github-observation-merkle/v1";
const createdAt = "2026-08-03T00:30:00Z";
const leafDomain = "stensibly.github-observation-merkle.leaf/v1";
const nodeDomain = "stensibly.github-observation-merkle.node/v1";
const emptyDomain = "stensibly.github-observation-merkle.empty/v1";

describe("GitHub observation Merkle checkpoints", () => {
  test("compiles deterministic ledger-bound roots for empty, singleton, and odd trees", () => {
    const empty = checkpoint([]);
    const singleton = checkpoint(leaves(1, 10));
    const oddLeaves = leaves(5, 10);
    const odd = checkpoint(oddLeaves);

    expect(empty).toMatchObject({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      algorithm: GITHUB_OBSERVATION_MERKLE_ALGORITHM_V1,
      ledgerId,
      compilerId,
      treeSize: 0,
      firstSequence: null,
      lastSequence: null,
      rootDigest: referenceRoot(ledgerId, []),
    });
    expect(singleton.rootDigest).toBe(referenceRoot(ledgerId, leaves(1, 10)));
    expect(odd).toMatchObject({
      treeSize: 5,
      firstSequence: 10,
      lastSequence: 14,
      rootDigest: referenceRoot(ledgerId, oddLeaves),
    });
    expect(odd.checkpointFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(odd)).toBe(true);
    const serialized = JSON.stringify(odd);
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("bodyText");
    expect(serialized).not.toContain("comment body");
  });

  test("proves every exact leaf in an odd tree and rejects substitution", () => {
    const source = leaves(7, 30);
    const compiled = checkpoint(source);

    for (let leafIndex = 0; leafIndex < source.length; leafIndex += 1) {
      const proof = inclusion(compiled, source, leafIndex);
      expect(verifyGitHubObservationInclusionProofV1(compiled, proof)).toBe(true);
      expect(proof.auditPath.length).toBeLessThanOrEqual(3);
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.auditPath)).toBe(true);
    }

    const proof = inclusion(compiled, source, 3);
    const changed = refingerprintInclusion({
      ...proof,
      semanticFingerprint: sha256("changed semantic observation"),
    });
    expect(verifyGitHubObservationInclusionProofV1(compiled, changed)).toBe(false);

    const shifted = refingerprintInclusion({ ...proof, leafIndex: 4 });
    expect(verifyGitHubObservationInclusionProofV1(compiled, shifted)).toBe(false);

    const foreign = checkpoint(source, {
      ledgerId: "workspace/other/github-observations",
    });
    expect(verifyGitHubObservationInclusionProofV1(foreign, proof)).toBe(false);
  });

  test("proves append-only extension across empty, balanced, and odd prefixes", () => {
    const source = leaves(9, 100);
    const sizes = [0, 1, 2, 3, 5, 9];
    const checkpoints = sizes.map((size, index) => checkpoint(
      source.slice(0, size),
      { createdAt: `2026-08-03T00:${String(30 + index).padStart(2, "0")}:00Z` },
    ));

    for (let index = 1; index < checkpoints.length; index += 1) {
      const older = checkpoints[index - 1]!;
      const newer = checkpoints[index]!;
      const proof = consistency(older, newer, source.slice(0, newer.treeSize));
      expect(verifyGitHubObservationConsistencyProofV1(older, newer, proof)).toBe(true);
      expect(proof.auditPath.length).toBeLessThanOrEqual(4);
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.auditPath)).toBe(true);
    }

    const first = checkpoint(source.slice(0, 5), {
      createdAt: "2026-08-03T01:00:00Z",
    });
    const repeated = checkpoint(source.slice(0, 5), {
      createdAt: "2026-08-03T01:01:00Z",
    });
    const replayProof = consistency(first, repeated, source.slice(0, 5));
    expect(replayProof.auditPath).toEqual([]);
    expect(verifyGitHubObservationConsistencyProofV1(first, repeated, replayProof)).toBe(true);
  });

  test("rejects rewrite, truncation, compiler drift, and cross-ledger substitution", () => {
    const source = leaves(6, 200);
    const older = checkpoint(source.slice(0, 3), {
      createdAt: "2026-08-03T02:00:00Z",
    });
    const newer = checkpoint(source, {
      createdAt: "2026-08-03T02:01:00Z",
    });
    const proof = consistency(older, newer, source);

    const rewrittenLeaves = source.map((leaf) => ({ ...leaf }));
    rewrittenLeaves[1]!.semanticFingerprint = sha256("rewritten observation");
    const rewritten = checkpoint(rewrittenLeaves, {
      createdAt: "2026-08-03T02:01:00Z",
    });
    expect(() => consistency(older, rewritten, rewrittenLeaves)).toThrow(
      "not a prefix",
    );
    expect(verifyGitHubObservationConsistencyProofV1(older, rewritten, proof)).toBe(false);

    expect(() => consistency(newer, older, source.slice(0, 3))).toThrow(
      "append-only ledger progression",
    );

    const foreignLedger = checkpoint(source, {
      ledgerId: "workspace/other/github-observations",
      createdAt: "2026-08-03T02:01:00Z",
    });
    expect(verifyGitHubObservationConsistencyProofV1(older, foreignLedger, proof)).toBe(false);

    const foreignCompiler = checkpoint(source, {
      compilerId: "github-observation-merkle/v2-experiment",
      createdAt: "2026-08-03T02:01:00Z",
    });
    expect(verifyGitHubObservationConsistencyProofV1(older, foreignCompiler, proof)).toBe(false);
  });

  test("admits descriptor-safe contiguous leaves and detaches producer mutation", () => {
    let getterCalls = 0;
    const hostile = {
      sequence: 1,
      get observationId() {
        getterCalls += 1;
        return "github:issues:hostile";
      },
      semanticFingerprint: sha256("hostile"),
    };
    expect(() => checkpoint([hostile as unknown as GitHubObservationMerkleLeafInputV1]))
      .toThrow("data properties");
    expect(getterCalls).toBe(0);

    expect(() => checkpoint([
      leaf(1),
      leaf(3),
    ])).toThrow("contiguous and ordered");

    const decorated = [leaf(1)] as GitHubObservationMerkleLeafInputV1[] & {
      extra?: boolean;
    };
    decorated.extra = true;
    expect(() => checkpoint(decorated)).toThrow("unsupported fields");

    const producer = leaves(3, 300);
    const compiled = checkpoint(producer);
    const root = compiled.rootDigest;
    producer[0]!.observationId = "github:issues:mutated-after-compilation";
    expect(compiled.rootDigest).toBe(root);
    expect(() => inclusion(compiled, producer, 0)).toThrow(
      "do not match the checkpoint",
    );
  });
});

function checkpoint(
  inputLeaves: readonly GitHubObservationMerkleLeafInputV1[],
  overrides: Partial<{
    ledgerId: string;
    compilerId: string;
    createdAt: string;
  }> = {},
): GitHubObservationMerkleCheckpointV1 {
  return compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: overrides.ledgerId ?? ledgerId,
    compilerId: overrides.compilerId ?? compilerId,
    createdAt: overrides.createdAt ?? createdAt,
    leaves: inputLeaves,
  });
}

function inclusion(
  compiled: GitHubObservationMerkleCheckpointV1,
  inputLeaves: readonly GitHubObservationMerkleLeafInputV1[],
  leafIndex: number,
): GitHubObservationInclusionProofV1 {
  return createGitHubObservationInclusionProofV1({
    checkpoint: compiled,
    leaves: inputLeaves,
    leafIndex,
  });
}

function consistency(
  olderCheckpoint: GitHubObservationMerkleCheckpointV1,
  newerCheckpoint: GitHubObservationMerkleCheckpointV1,
  newerLeaves: readonly GitHubObservationMerkleLeafInputV1[],
): GitHubObservationConsistencyProofV1 {
  return createGitHubObservationConsistencyProofV1({
    olderCheckpoint,
    newerCheckpoint,
    newerLeaves,
  });
}

function leaves(
  count: number,
  firstSequence = 1,
): GitHubObservationMerkleLeafInputV1[] {
  return Array.from({ length: count }, (_, index) => leaf(firstSequence + index));
}

function leaf(sequence: number): GitHubObservationMerkleLeafInputV1 {
  return {
    sequence,
    observationId: `github:issues:delivery-${sequence}`,
    semanticFingerprint: sha256(stableJson({
      subject: `github:teamleaderleo/stensibly#${sequence}`,
      state: sequence % 2 === 0 ? "open" : "closed",
      sequence,
    })),
  };
}

function referenceRoot(
  referenceLedgerId: string,
  inputLeaves: readonly GitHubObservationMerkleLeafInputV1[],
): string {
  if (inputLeaves.length === 0) {
    return sha256(stableJson({ domain: emptyDomain, ledgerId: referenceLedgerId }));
  }
  const hashes = inputLeaves.map((entry) => sha256(stableJson({
    domain: leafDomain,
    ledgerId: referenceLedgerId,
    sequence: entry.sequence,
    observationId: entry.observationId,
    semanticFingerprint: entry.semanticFingerprint,
  })));
  return referenceTree(hashes);
}

function referenceTree(hashes: readonly string[]): string {
  if (hashes.length === 1) return hashes[0]!;
  let split = 1;
  while (split * 2 < hashes.length) split *= 2;
  return sha256(stableJson({
    domain: nodeDomain,
    left: referenceTree(hashes.slice(0, split)),
    right: referenceTree(hashes.slice(split)),
  }));
}

function refingerprintInclusion(
  proof: GitHubObservationInclusionProofV1,
): GitHubObservationInclusionProofV1 {
  const { proofFingerprint: _discarded, ...data } = proof;
  return {
    ...data,
    auditPath: [...data.auditPath],
    proofFingerprint: sha256(stableJson(data)),
  };
}
