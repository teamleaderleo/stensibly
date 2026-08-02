import { describe, expect, test } from "bun:test";
import { sha256, stableJson } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationConsistencyProofV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  type GitHubObservationMerkleCheckpointV1,
} from "../src/github-observation-merkle-checkpoint.ts";

const ledgerId = "workspace/oauth-dogfood/github-observations";
const compilerId = "github-observation-merkle/v1";

describe("GitHub observation Merkle checkpoint admission", () => {
  test("rejects a self-consistent empty checkpoint with the wrong ledger root", () => {
    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId,
      compilerId,
      createdAt: "2026-08-03T01:10:00Z",
      leaves: [],
    });
    const { checkpointFingerprint: _discarded, ...changed } = {
      ...checkpoint,
      rootDigest: sha256("caller-selected empty root"),
    };
    const malformed: GitHubObservationMerkleCheckpointV1 = {
      ...changed,
      checkpointFingerprint: sha256(stableJson(changed)),
    };
    const newer = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId,
      compilerId,
      createdAt: "2026-08-03T01:11:00Z",
      leaves: [{
        sequence: 1,
        observationId: "github:issues:delivery-1",
        semanticFingerprint: sha256("observation-1"),
      }],
    });

    expect(() => createGitHubObservationConsistencyProofV1({
      olderCheckpoint: malformed,
      newerCheckpoint: newer,
      newerLeaves: [{
        sequence: 1,
        observationId: "github:issues:delivery-1",
        semanticFingerprint: sha256("observation-1"),
      }],
    })).toThrow("empty checkpoint root");
  });

  test("rejects hidden checkpoint fields without reading accessors", () => {
    let getterCalls = 0;
    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId,
      compilerId,
      createdAt: "2026-08-03T01:12:00Z",
      leaves: [],
    });
    const hostile = Object.defineProperty({ ...checkpoint }, "hidden", {
      enumerable: false,
      get() {
        getterCalls += 1;
        return "private";
      },
    });

    expect(() => createGitHubObservationConsistencyProofV1({
      olderCheckpoint: hostile,
      newerCheckpoint: checkpoint,
      newerLeaves: [],
    })).toThrow("unknown fields");
    expect(getterCalls).toBe(0);
  });
});
