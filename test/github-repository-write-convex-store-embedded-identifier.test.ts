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

describe("Convex repository-write embedded lookup credential admission", () => {
  test.each(hostileKeys())(
    "rejects embedded credential-shaped key %s before the Convex query",
    async (idempotencyKey) => {
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
    },
  );

  test("preserves a benign short embedded token-like alias", async () => {
    const client = new FakeClient();
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });
    const idempotencyKey = "keyxgithub_pat_review-xoxb-review";

    await expect(store.getRepositoryWriteReceipt(
      "stensibly",
      idempotencyKey,
    )).resolves.toBeNull();
    expect(client.queries).toEqual([{
      name: "githubRepositoryWrites:get",
      args: {
        project: "stensibly",
        idempotencyKey,
        serviceSecret: "service-secret",
        workspace: "default",
      },
    }]);
  });

  test("uses the fixed non-echoing storage error", async () => {
    const client = new FakeClient();
    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: "service-secret",
    });
    const hostile = `keyxxoxb-${"z".repeat(16)}`;

    try {
      await store.getRepositoryWriteReceipt("stensibly", hostile);
      throw new Error("expected embedded identifier rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubRepositoryWriteStorageError);
      expect(String(error)).toBe(
        "GitHubRepositoryWriteStorageError: GitHub repository write storage failed",
      );
      expect(String(error)).not.toContain(hostile);
    }
    expect(client.queries).toEqual([]);
  });
});

function hostileKeys(): string[] {
  const jwt = `eyJ${"d".repeat(8)}.eyJ${"e".repeat(8)}.${"f".repeat(8)}`;
  return [
    `keyxgithub_pat_${"a".repeat(20)}`,
    `keyxghp_${"b".repeat(20)}`,
    `keyxxoxb-${"c".repeat(16)}`,
    "keyxsecret://github/app-private-key",
    `keyx${jwt}`,
  ];
}
