import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "alpha", name: "Alpha", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("Convex item activity", () => {
  test("events and artifacts advance item freshness exactly once", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "scrapbook",
      kind: "task",
      title: "Leave resumable evidence",
      nextAction: "Record progress.",
      priority: 60,
      actor,
    }) as any;

    const eventInput = {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor,
      type: "item.progress",
      payload: { summary: "Mapped the current path." },
      idempotencyKey: "progress-1",
    };
    await t.mutation(convexApi.events.record, eventInput);
    const afterEvent = await itemDetail(t, created.id);
    expect(afterEvent).toMatchObject({
      status: created.status,
      claimedBy: created.claimedBy,
      claimExpiresAt: created.claimExpiresAt,
      summary: created.summary,
      nextAction: created.nextAction,
      version: created.version + 1,
    });

    await t.mutation(convexApi.events.record, eventInput);
    const afterEventReplay = await itemDetail(t, created.id);
    expect(afterEventReplay.version).toBe(afterEvent.version);

    const artifactInput = {
      serviceSecret: secret,
      workspace,
      id: created.id,
      actor,
      kind: "commit" as const,
      label: "Implementation commit",
      uri: "git:teamleaderleo/stensibly@deadbeef",
      metadata: { sha: "deadbeef" },
      idempotencyKey: "artifact-1",
    };
    await t.mutation(convexApi.artifacts.attach, artifactInput);
    const afterArtifact = await itemDetail(t, created.id);
    expect(afterArtifact).toMatchObject({
      status: created.status,
      claimedBy: created.claimedBy,
      claimExpiresAt: created.claimExpiresAt,
      summary: created.summary,
      nextAction: created.nextAction,
      version: afterEvent.version + 1,
    });

    await t.mutation(convexApi.artifacts.attach, artifactInput);
    const afterArtifactReplay = await itemDetail(t, created.id);
    expect(afterArtifactReplay.version).toBe(afterArtifact.version);
  });
});

async function itemDetail(t: ReturnType<typeof convexTest>, id: string) {
  const detail = await t.query(convexApi.items.get, {
    serviceSecret: secret,
    workspace,
    id,
  }) as any;
  return detail.item;
}
