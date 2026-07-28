import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ARTIFACT_HISTORY_OVERFLOW_CODE,
  ITEM_HISTORY_CONTRACT_VERSION,
  MAX_DIRECT_VISIBLE_EVENTS,
  MAX_ITEM_DETAIL_VISIBLE_EVENTS,
  MAX_ITEM_EVENT_SCAN_BYTES,
  MAX_ITEM_EVENT_SCAN_ROWS,
  MAX_PUBLIC_ITEM_ARTIFACTS,
} from "./lib/itemHistory";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "bounded-history-contract-secret";
const workspace = "test";
const actor = {
  id: "agent:bounded-history",
  name: "Bounded History",
  kind: "agent" as const,
};

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret));

describe("bounded hosted history contract", () => {
  test("advertises the exact versioned capability", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(convexApi.historyCapabilities.get, {
      serviceSecret,
      workspace,
    })).resolves.toEqual({
      version: ITEM_HISTORY_CONTRACT_VERSION,
      itemDetailVisibleEventLimit: MAX_ITEM_DETAIL_VISIBLE_EVENTS,
      directVisibleEventLimit: MAX_DIRECT_VISIBLE_EVENTS,
      physicalEventRowLimit: MAX_ITEM_EVENT_SCAN_ROWS,
      physicalEventByteLimit: MAX_ITEM_EVENT_SCAN_BYTES,
      artifactLimit: MAX_PUBLIC_ITEM_ARTIFACTS,
      artifactOverflowCode: ARTIFACT_HISTORY_OVERFLOW_CODE,
      boundedItemControl: true,
      boundedDirectEvents: true,
      boundedArtifacts: true,
    });
  });

  test("returns complete 100-artifact windows and fails explicitly on row 101", async () => {
    const t = convexTest(schema, modules);
    const completeItem = await createItem(t, "complete-artifacts");
    const overflowItem = await createItem(t, "overflow-artifacts");

    await t.run(async (ctx) => {
      const items = await ctx.db.query("items").collect();
      const completeRow = items.find((entry) => entry.externalId === completeItem.id);
      const overflowRow = items.find((entry) => entry.externalId === overflowItem.id);
      const actorRow = (await ctx.db.query("actors").collect())
        .find((entry) => entry.externalId === actor.id);
      if (!completeRow || !overflowRow || !actorRow) {
        throw new Error("Bounded history test setup disappeared");
      }

      for (let index = 0; index < MAX_PUBLIC_ITEM_ARTIFACTS; index += 1) {
        await insertArtifact(ctx, completeRow, actorRow, index);
      }
      for (let index = 0; index < MAX_PUBLIC_ITEM_ARTIFACTS + 1; index += 1) {
        await insertArtifact(ctx, overflowRow, actorRow, index);
      }
    });

    const complete = await t.query(convexApi.artifacts.list, {
      serviceSecret,
      workspace,
      id: completeItem.id,
    }) as Array<{ id: string }>;
    expect(complete).toHaveLength(MAX_PUBLIC_ITEM_ARTIFACTS);
    expect(complete[0]?.id).toBe("art_complete-artifacts_0");
    expect(complete.at(-1)?.id).toBe("art_complete-artifacts_99");

    await expect(t.query(convexApi.artifacts.list, {
      serviceSecret,
      workspace,
      id: overflowItem.id,
    })).rejects.toThrow(ARTIFACT_HISTORY_OVERFLOW_CODE);
    await expect(t.query(convexApi.itemControl.get, {
      serviceSecret,
      workspace,
      id: overflowItem.id,
      now: Date.now(),
    })).rejects.toThrow(ARTIFACT_HISTORY_OVERFLOW_CODE);
  });
});

async function createItem(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<{ id: string }> {
  return await t.mutation(convexApi.items.create, {
    serviceSecret,
    workspace,
    project: "bounds",
    kind: "task",
    title: slug,
    nextAction: "Prove the bounded history contract.",
    priority: 50,
    actor,
  }) as { id: string };
}

async function insertArtifact(
  ctx: any,
  item: any,
  actorRow: any,
  index: number,
): Promise<void> {
  await ctx.db.insert("artifacts", {
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    itemId: item._id,
    externalId: `art_${item.title}_${index}`,
    actorId: actorRow._id,
    actorExternalId: actorRow.externalId,
    kind: "file",
    label: `Artifact ${index}`,
    uri: `file:///bounded/${index}`,
    metadata: { index },
    createdAt: index,
  });
}
