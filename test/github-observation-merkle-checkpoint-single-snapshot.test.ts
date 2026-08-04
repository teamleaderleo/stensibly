import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationInclusionProofV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
} from "../src/github-observation-merkle-checkpoint.ts";

const publicRoute = "github.com/example/project/issues/12";

describe("GitHub observation Merkle single-snapshot admission", () => {
  test("rejects a changing top-level identity without a second caller read", () => {
    const reads = { value: 0 };
    const input = alternatingDataRecord(
      {
        version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
        ledgerId: "workspace/internal-observations",
        compilerId: "github-observation-merkle/v1",
        createdAt: "2026-08-05T00:00:00Z",
        leaves: [],
      },
      "ledgerId",
      "workspace/internal-observations",
      publicRoute,
      reads,
    );

    expect(() => compileGitHubObservationMerkleCheckpointV1(input)).toThrow(
      "Observation ledger ID is invalid",
    );
    expect(reads.value).toBe(1);
  });

  test("cannot retain a route revealed only during the base leaf read", () => {
    const compileReads = { value: 0 };
    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId: "workspace/internal-observations",
      compilerId: "github-observation-merkle/v1",
      createdAt: "2026-08-05T00:00:00Z",
      leaves: [alternatingLeaf(compileReads)],
    });
    expect(compileReads.value).toBe(1);

    const proofReads = { value: 0 };
    expect(() => createGitHubObservationInclusionProofV1({
      checkpoint,
      leaves: [alternatingLeaf(proofReads)],
      leafIndex: 0,
    })).toThrow("Observation Merkle leaf 0 ID is invalid");
    expect(proofReads.value).toBe(1);
  });
});

function alternatingLeaf(reads: { value: number }) {
  return alternatingDataRecord(
    {
      sequence: 1,
      observationId: "internal-observation-1",
      semanticFingerprint: sha256("single-snapshot-semantic"),
    },
    "observationId",
    "internal-observation-1",
    publicRoute,
    reads,
  );
}

function alternatingDataRecord<T extends Record<string, unknown>>(
  value: T,
  changingKey: keyof T,
  first: unknown,
  later: unknown,
  reads: { value: number },
): T {
  return new Proxy(value, {
    getPrototypeOf() {
      return Object.prototype;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor || property !== changingKey) return descriptor;
      reads.value += 1;
      return {
        ...descriptor,
        value: reads.value === 1 ? first : later,
      };
    },
  });
}
