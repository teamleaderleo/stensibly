import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  compileGitHubObservationMerkleCheckpointV1,
  GITHUB_OBSERVATION_MERKLE_CHECKPOINT_V1,
} from "../src/github-observation-merkle-checkpoint.ts";

const safeLedgerId = "workspace/oauth-dogfood/github-observations";
const safeCompilerId = "github-observation-merkle/v1";
const safeObservationId = "github:issues:delivery-1";
const semanticFingerprint = sha256("credential-boundary-observation");

const credentialShapes = [
  `github_pat_${"a".repeat(24)}`,
  `ghp_${"b".repeat(24)}`,
  `Bearer ${"c".repeat(16)}`,
  `sk-proj-${"d".repeat(24)}`,
  `stn.tok_${"e".repeat(24)}`,
  `xoxb-${"f".repeat(24)}`,
  "secret://github/app-private-key",
  `eyJ${"g".repeat(12)}.eyJ${"h".repeat(12)}.${"i".repeat(12)}`,
] as const;

describe("GitHub observation Merkle retained identity privacy", () => {
  test("rejects credential-shaped ledger identities without echoing them", () => {
    for (const secret of credentialShapes) {
      expectRejectedWithoutEcho(() => compile({
        ledgerId: `workspace/${secret}/observations`,
        compilerId: safeCompilerId,
        observationId: safeObservationId,
      }), secret);
    }
  });

  test("rejects credential-shaped compiler identities without echoing them", () => {
    for (const secret of credentialShapes) {
      expectRejectedWithoutEcho(() => compile({
        ledgerId: safeLedgerId,
        compilerId: `compiler/${secret}`,
        observationId: safeObservationId,
      }), secret);
    }
  });

  test("rejects credential-shaped observation identities without echoing them", () => {
    for (const secret of credentialShapes) {
      expectRejectedWithoutEcho(() => compile({
        ledgerId: safeLedgerId,
        compilerId: safeCompilerId,
        observationId: `github:delivery:${secret}`,
      }), secret);
    }
  });

  test("admits benign short token-like identity text", () => {
    const checkpoint = compile({
      ledgerId: "workspace/github_pat_short/observations",
      compilerId: "compiler/Bearer-demo",
      observationId: "github:delivery:sk-test-fixture",
    });

    expect(checkpoint.ledgerId).toBe("workspace/github_pat_short/observations");
    expect(checkpoint.compilerId).toBe("compiler/Bearer-demo");
    expect(checkpoint.treeSize).toBe(1);
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
    createdAt: "2026-08-03T02:30:00Z",
    leaves: [{
      sequence: 1,
      observationId: input.observationId,
      semanticFingerprint,
    }],
  });
}

function expectRejectedWithoutEcho(
  operation: () => unknown,
  secret: string,
): void {
  try {
    operation();
    throw new Error("Expected retained identity rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toContain("is invalid");
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  }
}
