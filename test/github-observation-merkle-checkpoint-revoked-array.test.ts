import { expect, test } from "bun:test";
import {
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  compileGitHubObservationMerkleCheckpointV1,
} from "../src/github-observation-merkle-checkpoint.ts";

test("normalizes a revoked Merkle leaves array before proof compilation", () => {
  const revoked = Proxy.revocable([], {});
  revoked.revoke();

  expect(() => compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: "ledger:revoked-array-control",
    compilerId: "compiler:revoked-array-control",
    createdAt: "2026-08-08T00:00:00Z",
    leaves: revoked.proxy,
  })).toThrow("Observation Merkle leaves could not be inspected");
});
