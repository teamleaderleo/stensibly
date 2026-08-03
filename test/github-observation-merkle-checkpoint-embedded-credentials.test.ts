import { describe, expect, test } from "bun:test";
import {
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
  compileGitHubObservationMerkleCheckpointV1,
} from "../src/github-observation-merkle-checkpoint.ts";

describe("GitHub observation Merkle retained-identity privacy", () => {
  test("rejects realistic credential families embedded after alphanumeric prefixes", () => {
    const variants: Array<{
      field: "ledgerId" | "compilerId" | "observationId";
      value: string;
      message: string;
    }> = [
      {
        field: "ledgerId",
        value: `ledgerxgithub_pat_${"a".repeat(20)}`,
        message: "Observation ledger ID is invalid",
      },
      {
        field: "compilerId",
        value: `compilerxsk-proj-${"a".repeat(20)}`,
        message: "Observation checkpoint compiler ID is invalid",
      },
      {
        field: "observationId",
        value: `observationxstn.tok_${"a".repeat(20)}`,
        message: "Observation Merkle leaf 0 ID is invalid",
      },
      {
        field: "observationId",
        value: `observationxxoxb-${"a".repeat(16)}`,
        message: "Observation Merkle leaf 0 ID is invalid",
      },
      {
        field: "ledgerId",
        value: "ledgerxsecret://github/observation-ledger",
        message: "Observation ledger ID is invalid",
      },
      {
        field: "compilerId",
        value:
          `compilerxeyJ${"a".repeat(8)}.eyJ${"b".repeat(8)}.${"c".repeat(8)}`,
        message: "Observation checkpoint compiler ID is invalid",
      },
    ];

    for (const variant of variants) {
      expectFixedRejection(
        () => checkpoint(variant.field, variant.value),
        variant.message,
        variant.value,
      );
    }
  });

  test("preserves benign short token-like aliases below realistic thresholds", () => {
    const admitted = compileGitHubObservationMerkleCheckpointV1({
      version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
      ledgerId: "ledgerxgithub_pat_review",
      compilerId: "compilerxsk-review",
      createdAt: "2026-08-03T08:45:00.000Z",
      leaves: [{
        sequence: 1,
        observationId: "observationxxoxb-review",
        semanticFingerprint: hash("d"),
      }],
    });

    expect(admitted).toMatchObject({
      ledgerId: "ledgerxgithub_pat_review",
      compilerId: "compilerxsk-review",
      treeSize: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
  });
});

function checkpoint(
  field: "ledgerId" | "compilerId" | "observationId",
  value: string,
) {
  return compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: field === "ledgerId" ? value : "ledger_merkle_privacy",
    compilerId: field === "compilerId" ? value : "compiler_merkle_privacy",
    createdAt: "2026-08-03T08:45:00.000Z",
    leaves: [{
      sequence: 1,
      observationId: field === "observationId"
        ? value
        : "observation_merkle_privacy_1",
      semanticFingerprint: hash("a"),
    }],
  });
}

function expectFixedRejection(
  run: () => unknown,
  expectedMessage: string,
  rejectedText: string,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toBe(expectedMessage);
  expect((thrown as Error).message).not.toContain(rejectedText);
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
