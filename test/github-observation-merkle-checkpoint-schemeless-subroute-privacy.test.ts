import { describe, expect, test } from "bun:test";
import {
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  compileGitHubObservationMerkleCheckpointV1 as compileBase,
  createGitHubObservationInclusionProofV1 as createBaseInclusionProof,
} from "../src/github-observation-merkle-checkpoint-base.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  verifyGitHubObservationInclusionProofV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const createdAt = "2026-08-03T20:05:00.000Z";
const semanticFingerprint = `sha256:${"a".repeat(64)}`;
const safeLedgerId = "workspace/oauth-dogfood/github-observations";
const safeCompilerId = "github:observation-checkpoint:v1";
const safeObservationId = "github:issues:delivery-1";

const schemelessSubroutes = [
  "github.com/example/project/issues/123/comments",
  "www.github.com/example/project/pull/123/files",
  "github.com/example/project/discussions/123/comments",
  "github.com/example/project/commit/abcdef0/checks",
  "github.com/example/project/issues/123.patch",
  "github.com/example/project/pull/123#discussion_r123",
] as const;

describe("GitHub observation Merkle schemeless subroute privacy", () => {
  test("rejects complete GitHub subroutes in every compiled retained identity", () => {
    for (const route of schemelessSubroutes) {
      expectFixedRejection(
        () => compilePublic({ ledgerId: route }),
        "Observation ledger ID is invalid",
        route,
      );
      expectFixedRejection(
        () => compilePublic({ compilerId: route }),
        "Observation checkpoint compiler ID is invalid",
        route,
      );
      expectFixedRejection(
        () => compilePublic({ observationId: route }),
        "Observation Merkle leaf 0 ID is invalid",
        route,
      );
    }
  });

  test("rejects self-consistent base checkpoints carrying subroute ledger or compiler identity", () => {
    for (const route of schemelessSubroutes) {
      const ledgerCheckpoint = compileUnsafeBase({ ledgerId: route });
      expectFixedRejection(
        () => verifyGitHubObservationInclusionProofV1(
          ledgerCheckpoint,
          createBaseInclusionProof({
            checkpoint: ledgerCheckpoint,
            leaves: leaves(safeObservationId),
            leafIndex: 0,
          }),
        ),
        "Observation ledger ID is invalid",
        route,
      );

      const compilerCheckpoint = compileUnsafeBase({ compilerId: route });
      expectFixedRejection(
        () => verifyGitHubObservationInclusionProofV1(
          compilerCheckpoint,
          createBaseInclusionProof({
            checkpoint: compilerCheckpoint,
            leaves: leaves(safeObservationId),
            leafIndex: 0,
          }),
        ),
        "Observation checkpoint compiler ID is invalid",
        route,
      );
    }
  });

  test("rejects self-consistent base inclusion proofs carrying a subroute observation identity", () => {
    for (const route of schemelessSubroutes) {
      const unsafeLeaves = leaves(route);
      const checkpoint = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: safeLedgerId,
        compilerId: safeCompilerId,
        createdAt,
        leaves: unsafeLeaves,
      });
      const proof = createBaseInclusionProof({
        checkpoint,
        leaves: unsafeLeaves,
        leafIndex: 0,
      });

      expectFixedRejection(
        () => verifyGitHubObservationInclusionProofV1(checkpoint, proof),
        "Observation inclusion proof ID is invalid",
        route,
      );
    }
  });

  test("preserves internal host-like namespaces without recognized GitHub routes", () => {
    const checkpoint = compilePublic({
      ledgerId: "github.com/internal/ledger/checkpoints",
      compilerId: "www.github.com/internal/compiler/v1",
      observationId: "github.com/internal/delivery/observation-1",
    });

    expect(checkpoint).toMatchObject({
      ledgerId: "github.com/internal/ledger/checkpoints",
      compilerId: "www.github.com/internal/compiler/v1",
      treeSize: 1,
    });
  });
});

function compilePublic(overrides: {
  ledgerId?: string;
  compilerId?: string;
  observationId?: string;
} = {}) {
  return compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: overrides.ledgerId ?? safeLedgerId,
    compilerId: overrides.compilerId ?? safeCompilerId,
    createdAt,
    leaves: leaves(overrides.observationId ?? safeObservationId),
  });
}

function compileUnsafeBase(overrides: {
  ledgerId?: string;
  compilerId?: string;
}) {
  return compileBase({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: overrides.ledgerId ?? safeLedgerId,
    compilerId: overrides.compilerId ?? safeCompilerId,
    createdAt,
    leaves: leaves(safeObservationId),
  });
}

function leaves(observationId: string) {
  return [{ sequence: 1, observationId, semanticFingerprint }];
}

function expectFixedRejection(
  run: () => unknown,
  message: string,
  rejectedText: string,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toBe(message);
  expect((thrown as Error).message).not.toContain(rejectedText);
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}
