import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1 as compileBase,
  createGitHubObservationConsistencyProofV1 as createConsistencyBase,
  createGitHubObservationInclusionProofV1 as createInclusionBase,
} from "../src/github-observation-merkle-checkpoint-base.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  verifyGitHubObservationConsistencyProofV1,
  verifyGitHubObservationInclusionProofV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const createdAt = "2026-08-03T10:45:00Z";
const laterCreatedAt = "2026-08-03T10:46:00Z";
const safeLedgerId = "workspace/oauth-dogfood/github-observations";
const safeCompilerId = "github-observation-merkle/v1";
const safeObservationId = "github:issues:delivery-1";
const semanticFingerprint = sha256("complete schemeless route privacy");

const retainedPublicRoutes = [
  `github.com/example/project/commit/${"a".repeat(64)}`,
  "github.com/example/project/issues/123/",
  "github.com/example/project/issues/123#issuecomment-456",
  "github.com/example/project/pull/123/files",
  "github.com/example/project/discussions/123#discussioncomment-456",
  "github.com:443/example/project/issues/123",
  "www.github.com:443/example/project/pull/123/files",
] as const;

describe("GitHub observation Merkle complete schemeless route privacy", () => {
  test("rejects every retained route prefix in ledger identity", () => {
    for (const identity of retainedPublicRoutes) {
      expectFixedRejection(
        () => compile({ ledgerId: identity }),
        "Observation ledger ID is invalid",
        identity,
      );
    }
  });

  test("rejects every retained route prefix in compiler identity", () => {
    for (const identity of retainedPublicRoutes) {
      expectFixedRejection(
        () => compile({ compilerId: identity }),
        "Observation checkpoint compiler ID is invalid",
        identity,
      );
    }
  });

  test("rejects every retained route prefix in observation identity", () => {
    for (const identity of retainedPublicRoutes) {
      expectFixedRejection(
        () => compile({ observationId: identity }),
        "Observation Merkle leaf 0 ID is invalid",
        identity,
      );
    }
  });

  test("rejects self-consistent caller-supplied inclusion proofs", () => {
    for (const observationId of [
      retainedPublicRoutes[0],
      retainedPublicRoutes[2],
      retainedPublicRoutes[3],
    ]) {
      const leaves = [leaf(1, observationId)];
      const checkpoint = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: safeLedgerId,
        compilerId: safeCompilerId,
        createdAt,
        leaves,
      });
      const proof = createInclusionBase({
        checkpoint,
        leaves,
        leafIndex: 0,
      });

      expectFixedRejection(
        () => verifyGitHubObservationInclusionProofV1(checkpoint, proof),
        "Observation inclusion proof ID is invalid",
        observationId,
      );
    }
  });

  test("rejects self-consistent caller-supplied consistency checkpoints and proofs", () => {
    for (const identity of [
      retainedPublicRoutes[0],
      retainedPublicRoutes[4],
      retainedPublicRoutes[5],
    ]) {
      const ledgerLeaves = [leaf(1, safeObservationId), leaf(2, "github:issues:delivery-2")];

      const olderLedger = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: identity,
        compilerId: safeCompilerId,
        createdAt,
        leaves: ledgerLeaves.slice(0, 1),
      });
      const newerLedger = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: identity,
        compilerId: safeCompilerId,
        createdAt: laterCreatedAt,
        leaves: ledgerLeaves,
      });
      const ledgerProof = createConsistencyBase({
        olderCheckpoint: olderLedger,
        newerCheckpoint: newerLedger,
        newerLeaves: ledgerLeaves,
      });
      expectFixedRejection(
        () => verifyGitHubObservationConsistencyProofV1(
          olderLedger,
          newerLedger,
          ledgerProof,
        ),
        "Observation ledger ID is invalid",
        identity,
      );

      const compilerLeaves = [leaf(1, safeObservationId), leaf(2, "github:issues:delivery-2")];
      const olderCompiler = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: safeLedgerId,
        compilerId: identity,
        createdAt,
        leaves: compilerLeaves.slice(0, 1),
      });
      const newerCompiler = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: safeLedgerId,
        compilerId: identity,
        createdAt: laterCreatedAt,
        leaves: compilerLeaves,
      });
      const compilerProof = createConsistencyBase({
        olderCheckpoint: olderCompiler,
        newerCheckpoint: newerCompiler,
        newerLeaves: compilerLeaves,
      });
      expectFixedRejection(
        () => verifyGitHubObservationConsistencyProofV1(
          olderCompiler,
          newerCompiler,
          compilerProof,
        ),
        "Observation checkpoint compiler ID is invalid",
        identity,
      );
    }
  });

  test("preserves internal dotted and slashed namespaces with suffix-like text", () => {
    const checkpoint = compile({
      ledgerId: "internal/github.com/project/issues/123/archive",
      compilerId: "compiler.github.com/project/commit/abcdef0/v1",
      observationId: "delivery/github.com/project/pull/123/files/internal",
    });

    expect(checkpoint).toMatchObject({
      ledgerId: "internal/github.com/project/issues/123/archive",
      compilerId: "compiler.github.com/project/commit/abcdef0/v1",
      treeSize: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
  });
});

function compile(overrides: {
  ledgerId?: string;
  compilerId?: string;
  observationId?: string;
} = {}) {
  return compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: overrides.ledgerId ?? safeLedgerId,
    compilerId: overrides.compilerId ?? safeCompilerId,
    createdAt,
    leaves: [leaf(1, overrides.observationId ?? safeObservationId)],
  });
}

function leaf(sequence: number, observationId: string) {
  return {
    sequence,
    observationId,
    semanticFingerprint,
  };
}

function expectFixedRejection(
  operation: () => unknown,
  message: string,
  identity: string,
): void {
  try {
    operation();
    throw new Error("Expected retained route rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(message);
    expect((error as Error).message).not.toContain(identity);
    expect(JSON.stringify(error)).not.toContain(identity);
  }
}
