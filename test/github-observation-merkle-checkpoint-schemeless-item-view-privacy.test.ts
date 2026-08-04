import { describe, expect, test } from "bun:test";
import {
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  compileGitHubObservationMerkleCheckpointV1 as compileBase,
  createGitHubObservationConsistencyProofV1 as createBaseConsistencyProof,
  createGitHubObservationInclusionProofV1 as createBaseInclusionProof,
} from "../src/github-observation-merkle-checkpoint-base.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  verifyGitHubObservationConsistencyProofV1,
  verifyGitHubObservationInclusionProofV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const createdAt = "2026-08-03T21:25:00.000Z";
const laterCreatedAt = "2026-08-03T21:26:00.000Z";
const semanticFingerprint = `sha256:${"a".repeat(64)}`;
const safeLedgerId = "workspace/oauth-dogfood/github-observations";
const safeCompilerId = "github:observation-checkpoint:v1";
const safeObservationId = "github:issues:delivery-1";

const itemViewRoutes = [
  "github.com/example/project/issues/123.patch",
  "www.github.com/example/project/issues/123.diff",
  "github.com/example/project/pull/456.patch",
  "www.github.com/example/project/pull/456.diff",
  "github.com/example/project/discussions/789.patch",
  "www.github.com/example/project/discussions/789.diff",
] as const;

describe("GitHub observation Merkle schemeless item-view privacy", () => {
  test("rejects item patch and diff routes in every compiled retained identity", () => {
    for (const route of itemViewRoutes) {
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

  test("rejects self-consistent inclusion evidence carrying an item view", () => {
    for (const observationId of itemViewRoutes) {
      const unsafeLeaves = leaves(observationId);
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
        observationId,
      );
    }
  });

  test("rejects self-consistent consistency evidence carrying an item view", () => {
    for (const identity of itemViewRoutes) {
      const history = [
        leaf(1, safeObservationId),
        leaf(2, "github:issues:delivery-2"),
      ];
      const older = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: identity,
        compilerId: safeCompilerId,
        createdAt,
        leaves: history.slice(0, 1),
      });
      const newer = compileBase({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: identity,
        compilerId: safeCompilerId,
        createdAt: laterCreatedAt,
        leaves: history,
      });
      const proof = createBaseConsistencyProof({
        olderCheckpoint: older,
        newerCheckpoint: newer,
        newerLeaves: history,
      });

      expectFixedRejection(
        () => verifyGitHubObservationConsistencyProofV1(older, newer, proof),
        "Observation ledger ID is invalid",
        identity,
      );
    }
  });

  test("preserves internal dotted namespaces that are not public item routes", () => {
    const checkpoint = compilePublic({
      ledgerId: "internal/github.com/project/issues/archive.patch",
      compilerId: "compiler.github.com/project/pull/diff/v1",
      observationId: "delivery/github.com/project/discussions/patch/internal",
    });

    expect(checkpoint).toMatchObject({
      ledgerId: "internal/github.com/project/issues/archive.patch",
      compilerId: "compiler.github.com/project/pull/diff/v1",
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

function leaves(observationId: string) {
  return [leaf(1, observationId)];
}

function leaf(sequence: number, observationId: string) {
  return { sequence, observationId, semanticFingerprint };
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
