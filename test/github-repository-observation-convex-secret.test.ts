import { describe, expect, test } from "bun:test";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexGitHubRepositoryObservationService,
} from "../src/github-repository-observation-convex.ts";

describe("Convex repository observation credential privacy", () => {
  test("keeps credential dependencies and argument builder runtime-private", async () => {
    const secret = "repository-observation-service-secret";
    let observedSecret: unknown;
    let observedWorkspace: unknown;
    let originalCalls = 0;
    let substitutedCalls = 0;
    const client = {
      async mutation() {
        throw new Error("not used");
      },
      async query(_reference: unknown, args: Record<string, unknown>) {
        originalCalls += 1;
        observedSecret = args.serviceSecret;
        observedWorkspace = args.workspace;
        return [];
      },
    } as unknown as ConvexCaller;

    const service = new ConvexGitHubRepositoryObservationService({
      client,
      serviceSecret: secret,
      workspace: "default",
    });
    const publicView = service as unknown as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(service) as Record<PropertyKey, unknown>;

    for (const key of ["serviceSecret", "client", "workspace", "args"]) {
      expect(key in service).toBe(false);
      expect(publicView[key]).toBeUndefined();
      expect(Reflect.ownKeys(service)).not.toContain(key);
      expect(Reflect.ownKeys(prototype)).not.toContain(key);
      expect({ ...publicView }).not.toHaveProperty(key);
    }
    expect(JSON.stringify(service)).not.toContain(secret);

    publicView.client = {
      async mutation() {
        substitutedCalls += 1;
        throw new Error("substituted client must not receive credentials");
      },
      async query() {
        substitutedCalls += 1;
        return [];
      },
    };
    publicView.workspace = "other";
    publicView.serviceSecret = "substituted-secret";
    publicView.args = () => ({
      serviceSecret: "substituted-secret",
      workspace: "other",
    });

    expect(await service.listRecentRepositoryObservations(
      "teamleaderleo/stensibly",
      1,
    )).toEqual([]);
    expect(originalCalls).toBe(1);
    expect(substitutedCalls).toBe(0);
    expect(observedSecret).toBe(secret);
    expect(observedWorkspace).toBe("default");
    expect(JSON.stringify(service)).not.toContain(secret);
  });
});
