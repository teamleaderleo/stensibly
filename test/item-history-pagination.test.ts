import { describe, expect, test } from "bun:test";
import { paginationRequiresFurtherInspection } from "../convex/lib/itemHistory.ts";

describe("bounded item history pagination status", () => {
  test("treats Convex split statuses as partial even when isDone is true", () => {
    for (const pageStatus of ["SplitRecommended", "SplitRequired"] as const) {
      expect(paginationRequiresFurtherInspection({
        isDone: true,
        pageStatus,
        splitCursor: null,
      })).toBe(true);
    }
  });

  test("treats an explicit split cursor as partial", () => {
    expect(paginationRequiresFurtherInspection({
      isDone: true,
      pageStatus: null,
      splitCursor: "bounded-split-cursor",
    })).toBe(true);
  });

  test("accepts only an ordinary completed page as complete", () => {
    expect(paginationRequiresFurtherInspection({
      isDone: true,
      pageStatus: null,
      splitCursor: null,
    })).toBe(false);
    expect(paginationRequiresFurtherInspection({
      isDone: false,
      pageStatus: null,
      splitCursor: null,
    })).toBe(true);
  });
});
