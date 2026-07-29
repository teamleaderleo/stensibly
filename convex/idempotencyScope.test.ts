import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "scope-test";
const actor = { id: "scope-agent", name: "Scope Agent", kind: "agent" as const };

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted idempotency scope", () => {
  test("rejects create replay across projects", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "alpha", kind: "task",
      title: "Alpha item", priority: 50, actor, idempotencyKey: "shared-create-key",
    });
    await expect(t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "beta", kind: "task",
      title: "Beta item", priority: 50, actor, idempotencyKey: "shared-create-key",
    })).rejects.toThrow("another operation");
  });

  test("rejects cross-item event, claim, and artifact replay", async () => {
    const t = convexTest(schema, modules);
    const alpha = await t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "alpha", kind: "task",
      title: "Alpha", priority: 50, actor, idempotencyKey: "alpha-create",
    }) as any;
    const beta = await t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "beta", kind: "task",
      title: "Beta", priority: 50, actor, idempotencyKey: "beta-create",
    }) as any;

    await t.mutation(convexApi.events.record, {
      serviceSecret: secret, workspace, id: alpha.id, actor,
      type: "progress.scope", payload: { step: 1 }, idempotencyKey: "event-scope-key",
    });
    await expect(t.mutation(convexApi.events.record, {
      serviceSecret: secret, workspace, id: beta.id, actor,
      type: "progress.scope", payload: { step: 1 }, idempotencyKey: "event-scope-key",
    })).rejects.toThrow("another operation");

    await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret, workspace, id: alpha.id, actor,
      leaseSeconds: 300, idempotencyKey: "claim-scope-key",
    });
    await expect(t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret, workspace, id: beta.id, actor,
      leaseSeconds: 300, idempotencyKey: "claim-scope-key",
    })).rejects.toThrow("another operation");

    await t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret, workspace, id: alpha.id, actor, kind: "commit",
      label: "Alpha commit", uri: "git:alpha", metadata: {},
      idempotencyKey: "artifact-scope-key",
    });
    await expect(t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret, workspace, id: beta.id, actor, kind: "commit",
      label: "Alpha commit", uri: "git:alpha", metadata: {},
      idempotencyKey: "artifact-scope-key",
    })).rejects.toThrow("another operation");
  });
});
