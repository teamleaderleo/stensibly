import type { Doc } from "../_generated/dataModel";
import type { QueryContext } from "./domain";
import {
  filterVisibleDependencyEvents,
  type PublicDependency,
} from "./dependencyVisibility";
import { isPrivateExecutionEventType } from "./executionEnvelope";

export const ITEM_HISTORY_CONTRACT_VERSION = 1 as const;
export const MAX_ITEM_DETAIL_VISIBLE_EVENTS = 100;
export const MAX_DIRECT_VISIBLE_EVENTS = 1_000;
export const MAX_ITEM_EVENT_SCAN_ROWS = 5_000;
export const MAX_ITEM_EVENT_SCAN_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_ITEM_ARTIFACTS = 100;
export const ARTIFACT_HISTORY_OVERFLOW_CODE = "history_window_overflow:artifacts";

export interface VisibleEventWindow {
  events: Doc<"events">[];
  truncated: boolean;
  scannedRows: number;
}

/**
 * Reads the newest physically bounded candidate page before applying private
 * execution and dependency visibility filters. Convex indexes use their final
 * implicit `_creationTime` field as the deterministic tie-breaker after
 * `itemId` and `createdAt`.
 */
export async function readBoundedVisibleItemEvents(
  ctx: QueryContext,
  item: Doc<"items">,
  dependencies: PublicDependency[],
  visibleLimit: number,
): Promise<VisibleEventWindow> {
  if (
    !Number.isInteger(visibleLimit)
    || visibleLimit < 1
    || visibleLimit > MAX_DIRECT_VISIBLE_EVENTS
  ) {
    throw new RangeError(
      `Visible item event limit must be between 1 and ${MAX_DIRECT_VISIBLE_EVENTS}`,
    );
  }

  const page = await ctx.db
    .query("events")
    .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
    .order("desc")
    .paginate({
      numItems: MAX_ITEM_EVENT_SCAN_ROWS + 1,
      cursor: null,
      maximumRowsRead: MAX_ITEM_EVENT_SCAN_ROWS + 1,
      maximumBytesRead: MAX_ITEM_EVENT_SCAN_BYTES,
    });

  const physicalRows = page.page.slice(0, MAX_ITEM_EVENT_SCAN_ROWS);
  const nonPrivateRows = physicalRows.filter((event) =>
    !isPrivateExecutionEventType(event.type)
  );
  const visibleNewestFirst = await filterVisibleDependencyEvents(
    ctx,
    item,
    nonPrivateRows,
    dependencies,
  );
  const selected = visibleNewestFirst.slice(0, visibleLimit);

  return {
    events: [...selected].reverse(),
    truncated:
      !page.isDone
      || page.page.length > MAX_ITEM_EVENT_SCAN_ROWS
      || visibleNewestFirst.length > visibleLimit,
    scannedRows: physicalRows.length,
  };
}

export function assertCompleteArtifactWindow(rowCount: number): void {
  if (rowCount > MAX_PUBLIC_ITEM_ARTIFACTS) {
    throw new Error(ARTIFACT_HISTORY_OVERFLOW_CODE);
  }
}
