import { describe, expect, test } from "bun:test";
import {
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  compileGitHubObservationMerkleCheckpointV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const createdAt = "2026-08-03T09:30:00.000Z";
const semanticFingerprint = `sha256:${"a".repeat(64)}`;
const schemelessRoutes = [
  "github.com/example/project/issues/123",
  "www.github.com/example/project/pull/123",
  "github.com/example/project/discussions/123",
  "github.com/example/project/commit/abcdef0",
];

describe("GitHub observation Merkle schemeless route privacy", () => {
  test("rejects schemeless GitHub routes in ledger identity", () => {
    for (const route of schemelessRoutes) {
      expectFixedRejection(
        () => compile({ ledgerId: route }),
        "Observation ledger ID is invalid",
        route,
      );
    }
  });

  test("rejects schemeless GitHub routes in compiler identity", () => {
    for (const route of schemelessRoutes) {
      expectFixedRejection(
        () => compile({ compilerId: route }),
        "Observation checkpoint compiler ID is invalid",
        route,
      );
    }
  });

  test("rejects schemeless GitHub routes in observation identity", () => {
    for (const route of schemelessRoutes) {
      expectFixedRejection(
        () => compile({ observationId: route }),
        "Observation Merkle leaf 0 ID is invalid",
        route,
      );
    }
  });

  test("preserves internal dotted and slashed namespaces that are not GitHub routes", () => {
    const checkpoint = compile({
      ledgerId: "github.com/internal/ledger/checkpoints",
      compilerId: "internal.github.com/compiler/v1",
      observationId: "github.com/internal/delivery/observation-1",
    });

    expect(checkpoint).toMatchObject({
      ledgerId: "github.com/internal/ledger/checkpoints",
      compilerId: "internal.github.com/compiler/v1",
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
    ledgerId: overrides.ledgerId ?? "workspace/oauth-dogfood/github-observations",
    compilerId: overrides.compilerId ?? "github:observation-checkpoint:v1",
    createdAt,
    leaves: [{
      sequence: 1,
      observationId: overrides.observationId ?? "github:issues:delivery-1",
      semanticFingerprint,
    }],
  });
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
