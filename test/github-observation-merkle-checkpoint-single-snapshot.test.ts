import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  createGitHubObservationInclusionProofV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
} from "../src/github-observation-merkle-checkpoint.ts";

const benignLedger = "workspace/internal-observations";
const benignObservation = "internal-observation-1";
const publicRoute = "github.com/example/project/issues/12";

describe("GitHub observation Merkle single-snapshot admission", () => {
  test("retains the first top-level identity snapshot without a second caller read", () => {
    const reads = { value: 0 };
    const checkpoint = compileGitHubObservationMerkleCheckpointV1(
      alternatingDataRecord(
        {
          version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
          ledgerId: benignLedger,
          compilerId: "github-observation-merkle/v1",
          createdAt: "2026-08-05T00:00:00Z",
          leaves: [],
        },
        "ledgerId",
        benignLedger,
        publicRoute,
        reads,
      ),
    );

    expect(checkpoint.ledgerId).toBe(benignLedger);
    expect(JSON.stringify(checkpoint)).not.toContain(publicRoute);
    expect(reads.value).toBe(1);
  });

  test("cannot retain a route revealed only by a later leaf descriptor read", () => {
    const compileReads = { value: 0 };
    const checkpoint = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId: benignLedger,
      compilerId: "github-observation-merkle/v1",
      createdAt: "2026-08-05T00:00:00Z",
      leaves: [alternatingLeaf(compileReads)],
    });
    expect(compileReads.value).toBe(1);

    const proofReads = { value: 0 };
    const proof = createGitHubObservationInclusionProofV1({
      checkpoint,
      leaves: [alternatingLeaf(proofReads)],
      leafIndex: 0,
    });
    expect(proof.observationId).toBe(benignObservation);
    expect(JSON.stringify(proof)).not.toContain(publicRoute);
    expect(proofReads.value).toBe(1);
  });
});

function alternatingLeaf(reads: { value: number }) {
  return alternatingDataRecord(
    {
      sequence: 1,
      observationId: benignObservation,
      semanticFingerprint: sha256("single-snapshot-semantic"),
    },
    "observationId",
    benignObservation,
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
