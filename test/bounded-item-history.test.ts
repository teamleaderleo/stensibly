import { describe, expect, test } from "bun:test";
import type { QueryContext } from "../convex/lib/domain.ts";
import {
  ARTIFACT_HISTORY_OVERFLOW_CODE,
  assertCompleteArtifactWindow,
  MAX_ITEM_EVENT_SCAN_BYTES,
  MAX_ITEM_EVENT_SCAN_ROWS,
  readBoundedVisibleItemEvents,
} from "../convex/lib/itemHistory.ts";

describe("bounded hosted item history reader", () => {
  test("applies the physical row and byte limits before private filtering", async () => {
    let paginateOptions: unknown = null;
    const page = {
      page: Array.from({ length: MAX_ITEM_EVENT_SCAN_ROWS + 1 }, (_, index) => ({
        _id: `event_${index}`,
        _creationTime: index,
        itemId: "item_internal",
        workspaceId: "workspace_internal",
        projectId: "project_internal",
        externalId: `evt_private_${index}`,
        type: `run.execution_actual:private-${index}`,
        payload: { private: true, index },
        createdAt: index,
      })),
      isDone: false,
      continueCursor: "next",
    };
    const query = {
      withIndex: () => query,
      order: () => query,
      paginate: async (options: unknown) => {
        paginateOptions = options;
        return page;
      },
    };
    const ctx = {
      db: {
        query: (table: string) => {
          expect(table).toBe("events");
          return query;
        },
      },
    } as unknown as QueryContext;

    const result = await readBoundedVisibleItemEvents(
      ctx,
      { _id: "item_internal" } as never,
      [],
      100,
    );

    expect(paginateOptions).toEqual({
      numItems: MAX_ITEM_EVENT_SCAN_ROWS + 1,
      cursor: null,
      maximumRowsRead: MAX_ITEM_EVENT_SCAN_ROWS + 1,
      maximumBytesRead: MAX_ITEM_EVENT_SCAN_BYTES,
    });
    expect(result.scannedRows).toBe(MAX_ITEM_EVENT_SCAN_ROWS);
    expect(result.events).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-5000");
  });

  test("treats artifact row 101 as explicit completeness overflow", () => {
    expect(() => assertCompleteArtifactWindow(100)).not.toThrow();
    expect(() => assertCompleteArtifactWindow(101)).toThrow(
      ARTIFACT_HISTORY_OVERFLOW_CODE,
    );
  });
});
