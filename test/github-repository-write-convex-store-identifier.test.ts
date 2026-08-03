import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubRepositoryWriteStore,
  GitHubRepositoryWriteStorageError,
} from "../src/github-repository-write-convex-store.ts";

class FakeClient implements ConvexCaller {
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];

  async mutation(): Promise<unknown> {
    throw new Error("unexpected mutation");
  }

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: getFunctionName(reference), args });
    return null;
  }
}

describe("Convex repository-write lookup identifier admission", () => {
  test.each([
    "bad?key",
    `ghp_${"a".repeat(40)}`,
  ])("rejects hostile idempotency key %s before the Convex query", async (idempotencyKey) => {
    const client = new FakeClient();
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });

    await expect(store.getRepositoryWriteReceipt(
      "stensibly",
      idempotencyKey,
    )).rejects.toBeInstanceOf(GitHubRepositoryWriteStorageError);
    expect(client.queries).toEqual([]);
  });

  test("uses a fixed non-echoing client error", async () => {
    const client = new FakeClient();
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
    });
    const hostile = `ghp_${"z".repeat(40)}`;

    try {
      await store.getRepositoryWriteReceipt("stensibly", hostile);
      throw new Error("expected identifier rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubRepositoryWriteStorageError);
      expect(String(error)).toBe("GitHubRepositoryWriteStorageError: GitHub repository write storage failed");
      expect(String(error)).not.toContain(hostile);
    }
    expect(client.queries).toEqual([]);
  });
});
