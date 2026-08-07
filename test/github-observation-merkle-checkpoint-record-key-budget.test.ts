import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
} from "../src/github-observation-merkle-checkpoint.ts";

describe("GitHub observation Merkle fixed-record key budget", () => {
  test("admits the exact compile record without caller own-key enumeration", () => {
    let ownKeysCalls = 0;
    const source = {
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId: "workspace/internal-observations",
      compilerId: "github-observation-merkle/v1",
      createdAt: "2026-08-07T00:00:00.000Z",
      leaves: [{
        sequence: 1,
        observationId: "internal-observation-1",
        semanticFingerprint: sha256("record key budget"),
      }],
    };
    const value = new Proxy(source, {
      getPrototypeOf() {
        return Object.prototype;
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must not run for a fixed-schema record");
      },
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const checkpoint = compileGitHubObservationMerkleCheckpointV1(value);

    expect(checkpoint).toMatchObject({
      ledgerId: "workspace/internal-observations",
      compilerId: "github-observation-merkle/v1",
      treeSize: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
    expect(ownKeysCalls).toBe(0);
  });
});
