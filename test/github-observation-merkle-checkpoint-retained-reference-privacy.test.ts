import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
} from "../src/github-observation-merkle-checkpoint.ts";

const safeLedgerId = "workspace/oauth-dogfood/github-observations";
const safeCompilerId = "github-observation-merkle/v1";
const safeObservationId = "github:issues:delivery-1";
const semanticFingerprint = sha256("retained-reference-privacy-observation");

const backlinkCapableIdentities = [
  "https://github.com/example/project/issues/123",
  "example/project#123",
  "example/project@abcdef0",
  "github:example/project#123",
] as const;

const embeddedCredentialIdentities = [
  `identityxgithub_pat_${"a".repeat(20)}`,
  `identityxghp_${"b".repeat(20)}`,
  `identityxsk-proj-${"c".repeat(20)}`,
  `identityxstn.tok_${"d".repeat(20)}`,
  `identityxxoxb-${"e".repeat(16)}`,
  "identityxsecret://github/app-private-key",
  `identityxeyJ${"f".repeat(8)}.eyJ${"g".repeat(8)}.${"h".repeat(8)}`,
] as const;

const rejectedIdentities = [
  ...backlinkCapableIdentities,
  ...embeddedCredentialIdentities,
] as const;

describe("GitHub observation Merkle retained reference privacy", () => {
  test("rejects backlink-capable and embedded credential ledger identities", () => {
    for (const identity of rejectedIdentities) {
      expectRejectedWithoutEcho(() => compile({
        ledgerId: identity,
        compilerId: safeCompilerId,
        observationId: safeObservationId,
      }), identity);
    }
  });

  test("rejects backlink-capable and embedded credential compiler identities", () => {
    for (const identity of rejectedIdentities) {
      expectRejectedWithoutEcho(() => compile({
        ledgerId: safeLedgerId,
        compilerId: identity,
        observationId: safeObservationId,
      }), identity);
    }
  });

  test("rejects backlink-capable and embedded credential observation identities", () => {
    for (const identity of rejectedIdentities) {
      expectRejectedWithoutEcho(() => compile({
        ledgerId: safeLedgerId,
        compilerId: safeCompilerId,
        observationId: identity,
      }), identity);
    }
  });

  test("preserves representative internal identities and benign short aliases", () => {
    const checkpoint = compile({
      ledgerId: safeLedgerId,
      compilerId: "compiler/github_pat_review/v1",
      observationId: "github:delivery:xoxb-review",
    });

    expect(checkpoint).toMatchObject({
      ledgerId: safeLedgerId,
      compilerId: "compiler/github_pat_review/v1",
      treeSize: 1,
      firstSequence: 1,
      lastSequence: 1,
    });
  });
});

function compile(input: {
  ledgerId: string;
  compilerId: string;
  observationId: string;
}) {
  return compileGitHubObservationMerkleCheckpointV1({
    version: GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
    ledgerId: input.ledgerId,
    compilerId: input.compilerId,
    createdAt: "2026-08-03T08:45:00Z",
    leaves: [{
      sequence: 1,
      observationId: input.observationId,
      semanticFingerprint,
    }],
  });
}

function expectRejectedWithoutEcho(
  operation: () => unknown,
  identity: string,
): void {
  try {
    operation();
    throw new Error("Expected retained identity rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toContain("is invalid");
    expect((error as Error).message).not.toContain(identity);
    expect(JSON.stringify(error)).not.toContain(identity);
  }
}
