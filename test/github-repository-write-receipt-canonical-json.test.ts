import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  parseGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission.ts";

describe("repository write receipt canonical JSON parsing", () => {
  test("rejects whitespace and reordered encodings of an otherwise valid receipt", () => {
    const canonical = canonicalGitHubRepositoryWriteReceiptJson(receipt());
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const pretty = JSON.stringify(parsed, null, 2);
    const reordered = JSON.stringify({ state: parsed.state, ...parsed });

    expect(pretty).not.toBe(canonical);
    expect(reordered).not.toBe(canonical);
    expect(() => parseGitHubRepositoryWriteReceiptJson(pretty)).toThrow(
      "GitHub repository write receipt JSON must be canonical",
    );
    expect(() => parseGitHubRepositoryWriteReceiptJson(reordered)).toThrow(
      "GitHub repository write receipt JSON must be canonical",
    );
  });

  test("rejects duplicate keys even when the final parsed value is canonical", () => {
    const canonical = canonicalGitHubRepositoryWriteReceiptJson(receipt());
    const hidden = `github_pat_${"a".repeat(24)}`;
    const duplicate = canonical.replace(
      '{"actorId":',
      `{"actorId":"${hidden}","actorId":`,
    );

    expect(duplicate).not.toBe(canonical);
    expect(JSON.parse(duplicate)).toEqual(JSON.parse(canonical));
    expect(() => parseGitHubRepositoryWriteReceiptJson(duplicate)).toThrow(
      "GitHub repository write receipt JSON must be canonical",
    );
  });

  test("continues to accept the exact canonical encoding", () => {
    const admitted = receipt();
    const canonical = canonicalGitHubRepositoryWriteReceiptJson(admitted);
    expect(parseGitHubRepositoryWriteReceiptJson(canonical)).toEqual(admitted);
  });
});

function receipt() {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_canonical_json",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/canonical-json",
    path: "docs/canonical-json.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: hash("b"),
    payloadSha256: hash("c"),
    actorId: "actor_plover",
    clientId: "client_github_only",
    idempotencyKey: "canonical-receipt-json",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T18:10:00.000Z",
    updatedAt: "2026-08-03T18:10:00.000Z",
    verified: null,
    error: null,
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
