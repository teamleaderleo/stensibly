import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "exact-agent", name: "Exact Agent", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex exact idempotency fingerprints", () => {
  test("binds every durable item creation field", async () => {
    const t = convexTest(schema, modules);
    const request = createRequest("exact-create-key");
    const created = await t.mutation(convexApi.items.create, request) as any;
    expect((await t.mutation(convexApi.items.create, request) as any).id).toBe(created.id);

    await expect(t.mutation(convexApi.items.create, { ...request, summary: "Changed" }))
      .rejects.toThrow(/another operation/);
    await expect(t.mutation(convexApi.items.create, { ...request, nextAction: "Changed" }))
      .rejects.toThrow(/another operation/);
    await expect(t.mutation(convexApi.items.create, { ...request, priority: 62 }))
      .rejects.toThrow(/another operation/);
    await expect(t.mutation(convexApi.items.create, {
      ...request,
      actor: { id: "other-agent", name: "Other", kind: "agent" as const },
    })).rejects.toThrow(/another operation/);

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: created.id,
    }) as any;
    const event = detail.events.find((candidate: any) => candidate.type === "item.created");
    expect(event.payload.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.payload).not.toHaveProperty("summary");
    expect(event.payload).not.toHaveProperty("nextAction");
  });

  test("canonicalizes artifact metadata and binds MIME type", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, createRequest()) as any;
    const request = {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor,
      kind: "document" as const,
      label: "Evidence",
      uri: "https://example.test/evidence",
      mimeType: "application/json",
      metadata: { nested: { z: 3, a: 1 }, alpha: true },
      idempotencyKey: "exact-artifact-key",
    };
    const artifact = await t.mutation(convexApi.artifacts.attach, request) as any;
    const replayed = await t.mutation(convexApi.artifacts.attach, {
      ...request,
      metadata: { alpha: true, nested: { a: 1, z: 3 } },
    }) as any;
    expect(replayed.id).toBe(artifact.id);

    await expect(t.mutation(convexApi.artifacts.attach, {
      ...request,
      mimeType: "text/plain",
    })).rejects.toThrow(/another operation/);
    await expect(t.mutation(convexApi.artifacts.attach, {
      ...request,
      metadata: { nested: { z: 4, a: 1 }, alpha: true },
    })).rejects.toThrow(/another operation/);

    const detail = await t.query(convexApi.items.get, {
      serviceSecret: secret,
      workspace,
      id: item.id,
    }) as any;
    expect(detail.artifacts).toHaveLength(1);
    const event = detail.events.find((candidate: any) => candidate.type === "artifact.attached");
    expect(event.payload.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.payload).not.toHaveProperty("metadata");
    expect(event.payload).not.toHaveProperty("mimeType");
  });

  test("fails closed for legacy events without a request fingerprint", async () => {
    const t = convexTest(schema, modules);
    const create = createRequest("legacy-create-key");
    const item = await t.mutation(convexApi.items.create, create) as any;
    await stripFingerprint(t, "legacy-create-key");
    await expect(t.mutation(convexApi.items.create, create)).rejects.toThrow(/another operation/);

    const artifact = {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor,
      kind: "commit" as const,
      label: "Legacy evidence",
      uri: "git:legacy",
      metadata: { sha: "deadbeef" },
      idempotencyKey: "legacy-artifact-key",
    };
    await t.mutation(convexApi.artifacts.attach, artifact);
    await stripFingerprint(t, "legacy-artifact-key");
    await expect(t.mutation(convexApi.artifacts.attach, artifact))
      .rejects.toThrow(/another operation/);
  });
});

function createRequest(idempotencyKey?: string) {
  return {
    serviceSecret: secret,
    workspace,
    project: "alpha",
    kind: "task" as const,
    title: "Bind the whole request",
    summary: "Original summary",
    nextAction: "Verify replay",
    priority: 61,
    actor,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function stripFingerprint(
  t: ReturnType<typeof convexTest>,
  idempotencyKey: string,
): Promise<void> {
  await t.run(async (ctx: any) => {
    const events = await ctx.db.query("events").collect();
    const event = events.find((candidate: any) => candidate.idempotencyKey === idempotencyKey);
    if (!event) throw new Error("Missing idempotency fixture");
    const payload = { ...(event.payload as Record<string, unknown>) };
    delete payload.requestFingerprint;
    await ctx.db.patch(event._id, { payload });
  });
}
