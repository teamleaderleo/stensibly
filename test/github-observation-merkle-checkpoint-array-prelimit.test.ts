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

describe("GitHub observation Merkle array pre-limit admission", () => {
  test("rejects oversized leaf arrays before own-key enumeration", () => {
    const hostile = oversizedArray(4_097);
    let observed: unknown;

    try {
      compileGitHubObservationMerkleCheckpointV1({
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId,
        compilerId,
        createdAt: "2026-08-05T00:00:00.000Z",
        leaves: hostile.value as never,
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(RangeError);
    expect((observed as Error).message).toBe(
      "Observation Merkle leaves length is outside the accepted range",
    );
    expect(hostile.ownKeysCalls()).toBe(0);
  });

  test("rejects oversized inclusion paths before own-key enumeration", () => {
    const leaves = [{
      sequence: 1,
      observationId: "github:issues:delivery-1",
      semanticFingerprint: sha256("observation-1"),
    }];
    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId,
      compilerId,
      createdAt: "2026-08-05T00:01:00.000Z",
      leaves,
    });
    const proof = createGitHubObservationInclusionProofV1({
      checkpoint,
      leaves,
      leafIndex: 0,
    });
    const hostile = oversizedArray(65);
    let observed: unknown;

    try {
      verifyGitHubObservationInclusionProofV1(checkpoint, {
        ...proof,
        auditPath: hostile.value,
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(RangeError);
    expect((observed as Error).message).toBe(
      "Observation inclusion audit path length is outside the accepted range",
    );
    expect(hostile.ownKeysCalls()).toBe(0);
  });
});

function oversizedArray(length: number): {
  value: unknown[];
  ownKeysCalls: () => number;
} {
  let calls = 0;
  const target = new Array(length);
  const value = new Proxy(target, {
    ownKeys() {
      calls += 1;
      throw new Error("Array ownKeys must not run before length admission");
    },
  });
  return {
    value,
    ownKeysCalls: () => calls,
  };
}
