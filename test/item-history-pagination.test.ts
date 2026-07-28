import { describe, expect, test } from "bun:test";
import { paginationRequiresFurtherInspection } from "../convex/lib/itemHistory.ts";

describe("bounded item history pagination status", () => {
  test("treats Convex SplitRequired as partial even when isDone is true", () => {
    expect(paginationRequiresFurtherInspection({
      isDone: true,
      pageStatus: "SplitRequired",
      splitCursor: null,
    })).toBe(true);
  });

  test("treats an explicit split cursor as partial", () => {
    expect(paginationRequiresFurtherInspection({
      isDone: true,
      pageStatus: "SplitRecommended",
      splitCursor: "bounded-split-cursor",
    })).toBe(true);
  });

  test("accepts only an ordinary completed page as complete", () => {
    expect(paginationRequiresFurtherInspection({
      isDone: true,
      pageStatus: "Done",
      splitCursor: null,
    })).toBe(false);
    expect(paginationRequiresFurtherInspection({
      isDone: false,
      pageStatus: null,
      splitCursor: null,
    })).toBe(true);
  });
});
