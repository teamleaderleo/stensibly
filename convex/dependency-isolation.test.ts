import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "dependency-isolation-secret";
const workspace = "test";
const actor = { id: "leo", name: "Leo", kind: "human" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("dependency project isolation", () => {
  test("returns enriched same-project relations and their events", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "scrapbook", "Document the API");
    const target = await createItem(t, "scrapbook", "Change the API");

    const created = await t.mutation(convexApi.dependencies.add, {
      serviceSecret,
      workspace,
      fromItemId: source.id,
      toItemId: target.id,
      kind: "depends_on",
      actor,
    }) as any;

    const listed = await t.query(convexApi.dependencies.list, {
      serviceSecret,
      workspace,
      itemId: source.id,
    }) as any[];
    expect(listed).toEqual([
      {
        id: created.id,
        direction: "outgoing",
        kind: "depends_on",
        itemId: target.id,
        title: target.title,
        status: "ready",
        createdAt: created.createdAt,
      },
    ]);

    const detail = await t.query(convexApi.items.get, {
      serviceSecret,
      workspace,
      id: source.id,
    }) as any;
    expect(detail.dependencies).toEqual(listed);
    expect(detail.events.filter((event: any) => event.type === "dependency.added")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          dependencyId: created.id,
          toItemId: target.id,
        }),
      }),
    ]);
  });

  test("rejects new cross-project dependencies", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "scrapbook", "Visible source");
    const target = await createItem(t, "private-project", "Private target");

    await expect(t.mutation(convexApi.dependencies.add, {
      serviceSecret,
      workspace,
      fromItemId: source.id,
      toItemId: target.id,
      kind: "related_to",
      actor,
    })).rejects.toThrow("Dependencies must stay within one project");
  });

  test("suppresses legacy cross-project rows and preserves safe old-format events", async () => {
    const t = convexTest(schema, modules);
    const source = await createItem(t, "scrapbook", "Visible source");
    const safeTarget = await createItem(t, "scrapbook", "Visible target");
    const privateTarget = await createItem(t, "private-project", "Private target");

    const safeDependency = await t.mutation(convexApi.dependencies.add, {
      serviceSecret,
      workspace,
      fromItemId: source.id,
      toItemId: safeTarget.id,
      kind: "depends_on",
      actor,
    }) as any;

    const legacy = await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const sourceDoc = items.find((item) => item.externalId === source.id);
      const safeDoc = items.find((item) => item.externalId === safeTarget.id);
      const privateDoc = items.find((item) => item.externalId === privateTarget.id);
      const actors = await ctx.db.query("actors").collect();
      const actorDoc = actors.find((candidate) => candidate.externalId === actor.id);
      if (!sourceDoc || !safeDoc || !privateDoc || !actorDoc) {
        throw new Error("Legacy dependency fixture setup failed");
      }

      const createdAt = Date.now() + 1;
      const crossDependencyId = await ctx.db.insert("dependencies", {
        workspaceId: sourceDoc.workspaceId,
        projectId: sourceDoc.projectId,
        fromItemId: sourceDoc._id,
        toItemId: privateDoc._id,
        kind: "related_to",
        createdByActorId: actorDoc._id,
        createdAt,
      });
      await ctx.db.insert("events", {
        workspaceId: sourceDoc.workspaceId,
        projectId: sourceDoc.projectId,
        itemId: sourceDoc._id,
        externalId: "evt_legacy_cross_dependency_id",
        actorId: actorDoc._id,
        actorExternalId: actorDoc.externalId,
        type: "dependency.added",
        payload: {
          dependencyId: String(crossDependencyId),
          kind: "related_to",
          toItemId: privateDoc.externalId,
        },
        createdAt,
      });
      await ctx.db.insert("events", {
        workspaceId: sourceDoc.workspaceId,
        projectId: sourceDoc.projectId,
        itemId: sourceDoc._id,
        externalId: "evt_legacy_cross_without_id",
        actorId: actorDoc._id,
        actorExternalId: actorDoc.externalId,
        type: "dependency.added",
        payload: {
          kind: "related_to",
          toItemId: privateDoc.externalId,
        },
        createdAt: createdAt + 1,
      });
      await ctx.db.insert("events", {
        workspaceId: sourceDoc.workspaceId,
        projectId: sourceDoc.projectId,
        itemId: sourceDoc._id,
        externalId: "evt_legacy_safe_without_id",
        actorId: actorDoc._id,
        actorExternalId: actorDoc.externalId,
        type: "dependency.added",
        payload: {
          kind: "related_to",
          toItemId: safeDoc.externalId,
        },
        createdAt: createdAt + 2,
      });
      return { crossDependencyId: String(crossDependencyId) };
    });

    const listed = await t.query(convexApi.dependencies.list, {
      serviceSecret,
      workspace,
      itemId: source.id,
    }) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: safeDependency.id, itemId: safeTarget.id });

    const detail = await t.query(convexApi.items.get, {
      serviceSecret,
      workspace,
      id: source.id,
    }) as any;
    expect(detail.dependencies).toEqual(listed);

    const dependencyEvents = detail.events.filter(
      (event: any) => event.type === "dependency.added",
    );
    expect(dependencyEvents).toHaveLength(2);
    expect(dependencyEvents.map((event: any) => event.payload.toItemId)).toEqual([
      safeTarget.id,
      safeTarget.id,
    ]);

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(privateTarget.id);
    expect(serialized).not.toContain(legacy.crossDependencyId);
    expect(serialized).not.toContain("evt_legacy_cross_dependency_id");
    expect(serialized).not.toContain("evt_legacy_cross_without_id");
    expect(serialized).toContain("evt_legacy_safe_without_id");
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  project: string,
  title: string,
) {
  return await t.mutation(convexApi.items.create, {
    serviceSecret,
    workspace,
    project,
    kind: "task",
    title,
    nextAction: "Continue safely.",
    priority: 50,
    actor,
  }) as any;
}
