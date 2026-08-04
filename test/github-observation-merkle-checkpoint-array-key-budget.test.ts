import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationInclusionProofV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  verifyGitHubObservationInclusionProofV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const ledgerId = "workspace/oauth-dogfood/github-observations";
const compilerId = "github-observation-merkle/v1";
const createdAt = "2026-08-05T18:20:00.000Z";

const leaf = {
  sequence: 1,
  observationId: "github:issues:delivery-1",
  semanticFingerprint: sha256("accepted array key budget"),
};

describe("GitHub observation Merkle accepted-array key budget", () => {
  test("detaches declared leaf indices without enumerating caller decorations", () => {
    const hostile = decoratedArray([leaf]);

    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId,
      compilerId,
      createdAt,
      leaves: hostile.value,
    });

    expect(checkpoint).toMatchObject({
      ledgerId,
      compilerId,
      treeSize: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    expect(hostile.ownKeysCalls()).toBe(0);
  });

  test("detaches a bounded audit path without enumerating caller decorations", () => {
    const leaves = [leaf];
    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId,
      compilerId,
      createdAt,
      leaves,
    });
    const proof = createGitHubObservationInclusionProofV1({
      checkpoint,
      leaves,
      leafIndex: 0,
    });
    const hostile = decoratedArray([...proof.auditPath]);

    expect(verifyGitHubObservationInclusionProofV1(checkpoint, {
      ...proof,
      auditPath: hostile.value,
    })).toBe(true);
    expect(hostile.ownKeysCalls()).toBe(0);
  });
});

function decoratedArray<T>(entries: readonly T[]): {
  value: T[];
  ownKeysCalls: () => number;
} {
  let calls = 0;
  const target = [...entries];
  Object.defineProperty(target, "callerDecoration", {
    value: "must be discarded during detachment",
    enumerable: true,
    configurable: true,
  });
  const value = new Proxy(target, {
    ownKeys() {
      calls += 1;
      throw new Error("Accepted-length array ownKeys must not be enumerated");
    },
  });
  return {
    value,
    ownKeysCalls: () => calls,
  };
}
