import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexCaller } from "../src/convex-ledger";
import {
  ConvexApplicationLaneBindingStore,
  withConvexApplicationLaneBindingStore,
} from "../src/application-lane-binding-convex-store";
import {
  canonicalApplicationWorkBindingInputJson,
  parseApplicationWorkBindingInputJson,
} from "../src/application-lane-binding-store";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "application-lane-binding-service-secret";
const bindRef = makeFunctionReference<"mutation">("applicationLaneBindings:bind");
const getRef = makeFunctionReference<"query">("applicationLaneBindings:get");
const listCurrentRef = makeFunctionReference<"query">("applicationLaneBindings:listCurrent");
const historyRef = makeFunctionReference<"query">("applicationLaneBindings:history");
const retireRef = makeFunctionReference<"mutation">("applicationLaneBindings:retire");
const eventsListRef = makeFunctionReference<"query">("events:list");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted application lane bindings", () => {
  test("persists one direct current binding and survives a fresh adapter", async () => {
    const t = convexTest(schema, modules);
    const itemId = await seedProjectItem(t, "stensibly", "item_app_work");
    const client = convexCaller(t);
    const first = new ConvexApplicationLaneBindingStore({ client, serviceSecret });
    const input = binding(itemId);

    const created = await first.bindApplicationLane({
      binding: input,
      idempotencyKey: "bind-app-lane-1",
    });
    expect(created).toMatchObject({
      id: input.id,
      project: "stensibly",
      itemId,
      generation: 1,
      laneRef: input.laneRef,
      laneGeneration: 7,
      retiredAt: null,
    });

    const second = new ConvexApplicationLaneBindingStore({ client, serviceSecret });
    expect(await second.getApplicationLaneBinding("stensibly", input.id)).toEqual(created);
    expect(await second.listCurrentApplicationLaneBindings("stensibly", itemId)).toEqual([created]);
    expect(await second.listApplicationLaneBindingHistory("stensibly", input.id)).toEqual([created]);

    const target = { kind: "ledger" };
    const composed = withConvexApplicationLaneBindingStore(target, { client, serviceSecret });
    expect(Object.is(composed, target)).toBe(true);
    expect(await composed.getApplicationLaneBinding("stensibly", input.id)).toEqual(created);
  });

  test("replays an exact bind and conflicts changed idempotency or binding-id reuse", async () => {
    const t = convexTest(schema, modules);
    const itemId = await seedProjectItem(t, "stensibly", "item_app_work");
    const input = binding(itemId);
    const args = bindArgs(input, "bind-app-lane-1");

    const first = await t.mutation(bindRef, args) as string;
    const replay = await t.mutation(bindRef, args) as string;
    expect(replay).toBe(first);

    await expect(t.mutation(bindRef, bindArgs({
      ...input,
      laneRef: "elatura:lane:other",
    }, "bind-app-lane-1"))).rejects.toThrow(
      "APPLICATION_LANE_BINDING_IDEMPOTENCY_CONFLICT",
    );

    await expect(t.mutation(bindRef, bindArgs(
      input,
      "bind-app-lane-1-second-command",
    ))).rejects.toThrow("APPLICATION_LANE_BINDING_ID_ALREADY_EXISTS");
  });

  test("isolates work item and project identity", async () => {
    const t = convexTest(schema, modules);
    const otherItem = await seedProjectItem(t, "other-project", "item_other");
    const input = binding(otherItem);

    await expect(t.mutation(bindRef, bindArgs(input, "wrong-project"))).rejects.toThrow(
      "APPLICATION_LANE_BINDING_ITEM_PROJECT_MISMATCH",
    );

    const other = binding(otherItem, {
      project: "other-project",
      laneRef: "elatura:lane:other-project",
    });
    await t.mutation(bindRef, bindArgs(other, "other-project-bind"));
    expect(await t.query(getRef, queryArgs({
      project: "stensibly",
      bindingId: other.id,
    }))).toBeNull();
    expect(parseApplicationWorkBindingInputJson(await t.query(getRef, queryArgs({
      project: "other-project",
      bindingId: other.id,
    })) as string)).toMatchObject({ project: "other-project", itemId: otherItem });
  });

  test("retires only the exact generation and preserves complete history", async () => {
    const t = convexTest(schema, modules);
    const itemId = await seedProjectItem(t, "stensibly", "item_app_work");
    const input = binding(itemId);
    await t.mutation(bindRef, bindArgs(input, "bind-app-lane-1"));
    const command = retireArgs({
      project: "stensibly",
      bindingId: input.id,
      expectedGeneration: 1,
      retiredAt: "2026-08-27T01:00:00.000Z",
      idempotencyKey: "retire-app-lane-1",
    });

    const retiredJson = await t.mutation(retireRef, command) as string;
    expect(await t.mutation(retireRef, command)).toBe(retiredJson);
    const retired = parseApplicationWorkBindingInputJson(retiredJson);
    expect(retired).toMatchObject({ generation: 2, retiredAt: "2026-08-27T01:00:00.000Z" });
    expect(await t.query(listCurrentRef, queryArgs({
      project: "stensibly",
      itemId,
    }))).toEqual([]);
    const history = (await t.query(historyRef, queryArgs({
      project: "stensibly",
      bindingId: input.id,
    })) as string[]).map(parseApplicationWorkBindingInputJson);
    expect(history.map((entry) => entry.generation)).toEqual([1, 2]);
    expect(history[0]?.retiredAt).toBeNull();
    expect(history[1]).toEqual(retired);

    await expect(t.mutation(retireRef, retireArgs({
      project: "stensibly",
      bindingId: input.id,
      expectedGeneration: 1,
      retiredAt: "2026-08-27T02:00:00.000Z",
      idempotencyKey: "retire-stale-generation",
    }))).rejects.toThrow("APPLICATION_LANE_BINDING_CONFLICT");
  });

  test("direct binding lookup survives truncation of ordinary item event history", async () => {
    const t = convexTest(schema, modules);
    const itemId = await seedProjectItem(t, "stensibly", "item_app_work");
    const input = binding(itemId);
    await t.mutation(bindRef, bindArgs(input, "bind-app-lane-1"));

    await t.run(async (ctx: any) => {
      const item = await ctx.db
        .query("items")
        .withIndex("by_workspace_external", (q: any) =>
          q.eq("workspaceId", await workspaceId(ctx)).eq("externalId", itemId)
        )
        .unique();
      for (let index = 0; index < 1_050; index += 1) {
        await ctx.db.insert("events", {
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          itemId: item._id,
          externalId: `evt_noise_${index}`,
          type: "diagnostic.noise",
          payload: { index },
          createdAt: index + 10,
        });
      }
    });

    const visible = await t.query(eventsListRef, queryArgs({
      id: itemId,
      limit: 1_000,
    })) as any;
    expect(visible.events).toHaveLength(1_000);
    expect(visible.eventsTruncated).toBe(true);

    const direct = await t.query(getRef, queryArgs({
      project: "stensibly",
      bindingId: input.id,
    })) as string;
    expect(parseApplicationWorkBindingInputJson(direct)).toMatchObject({
      id: input.id,
      itemId,
      laneRef: input.laneRef,
    });
  });

  test("fails closed when a stored durable field or fingerprint is corrupted", async () => {
    const t = convexTest(schema, modules);
    const itemId = await seedProjectItem(t, "stensibly", "item_app_work");
    const input = binding(itemId);
    await t.mutation(bindRef, bindArgs(input, "bind-app-lane-1"));

    await t.run(async (ctx: any) => {
      const project = await projectRow(ctx, "stensibly");
      const row = await ctx.db
        .query("applicationLaneBindings")
        .withIndex("by_project_id_and_external_id_and_is_current", (q: any) =>
          q.eq("projectId", project._id)
            .eq("externalId", input.id)
            .eq("isCurrent", true)
        )
        .unique();
      await ctx.db.patch(row._id, {
        bindingFingerprint: `sha256:${"f".repeat(64)}`,
      });
    });

    await expect(t.query(getRef, queryArgs({
      project: "stensibly",
      bindingId: input.id,
    }))).rejects.toThrow("Application lane binding storage failed");
  });
});

function binding(itemId: string, override: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "binding:work-a:lane-a",
    generation: 1,
    project: "stensibly",
    itemId,
    provider: "elatura",
    laneRef: "elatura:lane:chat-a",
    laneGeneration: 7,
    capabilities: ["events", "observe", "activate", "screenshot"],
    createdAt: "2026-08-27T00:00:00.000Z",
    retiredAt: null,
    ...override,
  };
}

function bindArgs(value: Record<string, unknown>, idempotencyKey: string) {
  return queryArgs({
    project: String(value.project),
    bindingJson: canonicalApplicationWorkBindingInputJson(
      parseApplicationWorkBindingInputJson(JSON.stringify(value)),
    ),
    idempotencyKey,
  });
}

function retireArgs(input: {
  project: string;
  bindingId: string;
  expectedGeneration: number;
  retiredAt: string;
  idempotencyKey: string;
}) {
  return queryArgs(input);
}

function queryArgs(input: Record<string, unknown>) {
  return {
    ...input,
    serviceSecret,
    workspace: "default",
  };
}

function convexCaller(t: ReturnType<typeof convexTest>): ConvexCaller {
  return {
    query: async (reference, args) => await t.query(reference, args),
    mutation: async (reference, args) => await t.mutation(reference, args),
  };
}

async function seedProjectItem(
  t: ReturnType<typeof convexTest>,
  projectSlug: string,
  itemExternalId: string,
): Promise<string> {
  await t.run(async (ctx: any) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
      .unique();
    const wsId = workspace?._id ?? await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: 1,
      updatedAt: 1,
    });
    let project = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q: any) =>
        q.eq("workspaceId", wsId).eq("slug", projectSlug)
      )
      .unique();
    if (!project) {
      const projectId = await ctx.db.insert("projects", {
        workspaceId: wsId,
        externalId: `project_${projectSlug}`,
        slug: projectSlug,
        name: projectSlug,
        createdAt: 1,
        updatedAt: 1,
      });
      project = await ctx.db.get("projects", projectId);
    }
    const item = await ctx.db
      .query("items")
      .withIndex("by_workspace_external", (q: any) =>
        q.eq("workspaceId", wsId).eq("externalId", itemExternalId)
      )
      .unique();
    if (!item) {
      await ctx.db.insert("items", {
        workspaceId: wsId,
        projectId: project._id,
        externalId: itemExternalId,
        kind: "task",
        title: "Application-backed work",
        status: "ready",
        priority: 70,
        claimGeneration: 0,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
  return itemExternalId;
}

async function workspaceId(ctx: any) {
  return (await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
    .unique())._id;
}

async function projectRow(ctx: any, slug: string) {
  const wsId = await workspaceId(ctx);
  return await ctx.db
    .query("projects")
    .withIndex("by_workspace_slug", (q: any) =>
      q.eq("workspaceId", wsId).eq("slug", slug)
    )
    .unique();
}
