import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildApplicationWorkBindingV1 } from "../src/application-lane-binding";
import { ConvexApplicationLaneBindingStore } from "../src/application-lane-binding-convex-store";
import {
  canonicalApplicationWorkBindingInputJson,
  parseApplicationWorkBindingInputJson,
} from "../src/application-lane-binding-store";
import type { ConvexCaller } from "../src/convex-ledger";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "application-lane-binding-service-secret";
const bindRef = makeFunctionReference<"mutation">("applicationLaneBindings:bind");
const listProjectCurrentRef = makeFunctionReference<"query">(
  "applicationLaneBindings:listProjectCurrent",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted project application binding index", () => {
  test("uses one indexed bounded project read with deterministic item/binding order", async () => {
    const t = convexTest(schema, modules);
    await seedProjectItem(t, "stensibly", "item_z");
    await seedProjectItem(t, "stensibly", "item_a");
    await seedProjectItem(t, "other-project", "item_foreign");

    await t.mutation(bindRef, bindArgs(binding("item_z", "binding:z"), "bind-z"));
    await t.mutation(bindRef, bindArgs(binding("item_a", "binding:a"), "bind-a"));
    await t.mutation(bindRef, bindArgs(
      binding("item_foreign", "binding:foreign", "other-project"),
      "bind-foreign",
    ));

    const raw = await t.query(listProjectCurrentRef, queryArgs({
      project: "stensibly",
      limit: 1,
    })) as string[];
    expect(raw).toHaveLength(2);
    expect(raw.map((entry) => {
      const parsed = parseApplicationWorkBindingInputJson(entry);
      return `${parsed.itemId}/${parsed.id}`;
    })).toEqual([
      "item_a/binding:a",
      "item_z/binding:z",
    ]);

    const store = new ConvexApplicationLaneBindingStore({
      client: convexCaller(t),
      serviceSecret,
    });
    const bounded = await store.listProjectCurrentApplicationLaneBindings("stensibly", 1);
    expect(bounded).toMatchObject({
      version: 1,
      project: "stensibly",
      truncated: true,
    });
    expect(bounded.bindings.map((entry) => entry.id)).toEqual(["binding:a"]);

    const full = await store.listProjectCurrentApplicationLaneBindings("stensibly", 10);
    expect(full.bindings.map((entry) => entry.id)).toEqual(["binding:a", "binding:z"]);
    expect(full.truncated).toBe(false);

    const foreign = await store.listProjectCurrentApplicationLaneBindings("other-project", 10);
    expect(foreign.bindings.map((entry) => entry.id)).toEqual(["binding:foreign"]);
    expect(foreign.truncated).toBe(false);
  });

  test("rejects an invalid read budget before hosted activity", async () => {
    let queryCalls = 0;
    const client: ConvexCaller = {
      query: async () => {
        queryCalls += 1;
        return [];
      },
      mutation: async () => {
        throw new Error("unexpected mutation");
      },
    };
    const store = new ConvexApplicationLaneBindingStore({ client, serviceSecret });

    await expect(store.listProjectCurrentApplicationLaneBindings("stensibly", 0))
      .rejects.toThrow();
    expect(queryCalls).toBe(0);
  });
});

function binding(itemId: string, id: string, project = "stensibly") {
  return {
    version: 1,
    id,
    generation: 1,
    project,
    itemId,
    provider: "elatura",
    laneRef: `elatura:${id}`,
    laneGeneration: 1,
    capabilities: ["events", "observe"],
    createdAt: "2026-08-27T00:00:00.000Z",
    retiredAt: null,
  };
}

function bindArgs(value: Record<string, unknown>, idempotencyKey: string) {
  const admitted = buildApplicationWorkBindingV1(value);
  return queryArgs({
    project: admitted.project,
    bindingJson: canonicalApplicationWorkBindingInputJson(admitted),
    idempotencyKey,
  });
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
): Promise<void> {
  await t.run(async (ctx: any) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q: any) => q.eq("slug", "default"))
      .unique();
    const workspaceId = workspace?._id ?? await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: 1,
      updatedAt: 1,
    });
    let project = await ctx.db
      .query("projects")
      .withIndex("by_workspace_slug", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("slug", projectSlug)
      )
      .unique();
    if (!project) {
      const projectId = await ctx.db.insert("projects", {
        workspaceId,
        externalId: `project_${projectSlug}`,
        slug: projectSlug,
        name: projectSlug,
        createdAt: 1,
        updatedAt: 1,
      });
      project = await ctx.db.get("projects", projectId);
    }
    const existing = await ctx.db
      .query("items")
      .withIndex("by_workspace_external", (q: any) =>
        q.eq("workspaceId", workspaceId).eq("externalId", itemExternalId)
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("items", {
        workspaceId,
        projectId: project._id,
        externalId: itemExternalId,
        kind: "task",
        title: "Application-backed work",
        status: "ready",
        priority: 50,
        claimGeneration: 0,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}
