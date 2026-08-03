import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  parseGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission.ts";

describe("repository write receipt canonical JSON parsing", () => {
  test("rejects whitespace, trailing bytes, and reordered encodings", () => {
    const canonical = canonicalGitHubRepositoryWriteReceiptJson(receipt());
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const pretty = JSON.stringify(parsed, null, 2);
    const trailing = `${canonical}\n`;
    const reordered = JSON.stringify({ state: parsed.state, ...parsed });

    for (const candidate of [pretty, trailing, reordered]) {
      expect(candidate).not.toBe(canonical);
      expect(() => parseGitHubRepositoryWriteReceiptJson(candidate)).toThrow(
        "GitHub repository write receipt JSON must be canonical",
      );
    }
  });

  test("rejects duplicate keys without echoing hidden credential text", () => {
    const canonical = canonicalGitHubRepositoryWriteReceiptJson(receipt());
    const hidden = `github_pat_${"a".repeat(24)}`;
    const duplicate = canonical.replace(
      '{"actorId":',
      `{"actorId":"${hidden}","actorId":`,
    );

    expect(duplicate).not.toBe(canonical);
    expect(JSON.parse(duplicate)).toEqual(JSON.parse(canonical));
    let observed: unknown;
    try {
      parseGitHubRepositoryWriteReceiptJson(duplicate);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toBe(
      "GitHub repository write receipt JSON must be canonical",
    );
    expect((observed as Error).message).not.toContain(hidden);
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
