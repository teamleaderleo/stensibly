import { describe, expect, test } from "bun:test";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubRepositoryWriteStore,
} from "../src/github-repository-write-convex-store.ts";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission.ts";

describe("Convex repository write store credential privacy", () => {
  test("keeps credential dependencies and the argument builder runtime-private", async () => {
    const secret = "repository-write-store-service-secret";
    let observedSecret: unknown;
    let observedWorkspace: unknown;
    let originalCalls = 0;
    let substitutedCalls = 0;
    const requested = receipt();
    const client = {
      async mutation(_reference: unknown, args: Record<string, unknown>) {
        originalCalls += 1;
        observedSecret = args.serviceSecret;
        observedWorkspace = args.workspace;
        return {
          outcome: "reserved",
          receiptJson: canonicalGitHubRepositoryWriteReceiptJson(requested),
        };
      },
      async query() {
        return null;
      },
    } as unknown as ConvexCaller;

    const store = new ConvexGitHubRepositoryWriteStore({
      client,
      serviceSecret: secret,
      workspace: "default",
    });
    const publicView = store as unknown as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(store) as Record<PropertyKey, unknown>;

    for (const key of ["serviceSecret", "client", "workspace", "args"]) {
      expect(key in store).toBe(false);
      expect(publicView[key]).toBeUndefined();
      expect(Reflect.ownKeys(store)).not.toContain(key);
      expect(Reflect.ownKeys(prototype)).not.toContain(key);
      expect({ ...publicView }).not.toHaveProperty(key);
    }
    expect(JSON.stringify(store)).not.toContain(secret);

    publicView.client = {
      async mutation() {
        substitutedCalls += 1;
        throw new Error("substituted client must not receive credentials");
      },
      async query() {
        substitutedCalls += 1;
        return null;
      },
    };
    publicView.workspace = "other";
    publicView.serviceSecret = "substituted-secret";
    publicView.args = () => ({
      serviceSecret: "substituted-secret",
      workspace: "other",
    });

    const result = await store.reserveRepositoryWrite(requested);
    expect(result.outcome).toBe("reserved");
    expect(originalCalls).toBe(1);
    expect(substitutedCalls).toBe(0);
    expect(observedSecret).toBe(secret);
    expect(observedWorkspace).toBe("default");
    expect(JSON.stringify(store)).not.toContain(secret);
  });
});

function receipt() {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_private_store_secret",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    targetRef: "feature/private-store-secret",
    path: "docs/private-store-secret.md",
    operation: "create_file",
    expectedParentSha: "a".repeat(40),
    requestSha256: hash("b"),
    payloadSha256: hash("c"),
    actorId: "actor_morrow",
    clientId: "client_github_only",
    idempotencyKey: "private-store-secret",
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-08-03T18:20:00.000Z",
    updatedAt: "2026-08-03T18:20:00.000Z",
    verified: null,
    error: null,
  });
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
