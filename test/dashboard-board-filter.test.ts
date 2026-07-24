import { describe, expect, test } from "bun:test";
import {
  boardEmptyMessage,
  boardFilterKinds,
  boardFilterStatuses,
  boardResultLabel,
  matchesBoardCard,
  normalizeBoardKind,
  normalizeBoardProject,
  normalizeBoardQuery,
  normalizeBoardStatus,
} from "../site/board-filter.js";

const card = {
  kind: "task",
  status: "active",
  project: "scrapbook",
  text: "task · scrapbook p80 Ship dashboard Next · run verifier held by agent-1 lease 14m",
};

describe("dashboard board filter contract", () => {
  test("normalizes bounded case-insensitive search text", () => {
    expect(normalizeBoardQuery("  SHIP   Dashboard  ")).toBe("ship dashboard");
    expect(normalizeBoardQuery("ＡＢＣ")).toBe("abc");
    expect(normalizeBoardQuery(null)).toBe("");
    expect(() => normalizeBoardQuery("x".repeat(201))).toThrow(/at most 200/);
    expect(() => normalizeBoardQuery("stn.tok_secret")).toThrow(/Credential-shaped/);
  });

  test("accepts only known kind, status, and lowercase project metadata", () => {
    expect(normalizeBoardKind("task")).toBe("task");
    expect(normalizeBoardKind("unknown")).toBe("");
    expect(normalizeBoardStatus("blocked")).toBe("blocked");
    expect(normalizeBoardStatus("archived")).toBe("");
    expect(normalizeBoardProject("scrapbook_2")).toBe("scrapbook_2");
    expect(normalizeBoardProject("Bad Project")).toBe("");
  });

  test("matches query, kind, and status against authorized card content", () => {
    expect(matchesBoardCard(card, { query: "ship dashboard", kind: "", status: "" })).toBe(true);
    expect(matchesBoardCard(card, { query: "AGENT-1", kind: "task", status: "active" })).toBe(true);
    expect(matchesBoardCard(card, { query: "verifier", kind: "finding", status: "active" })).toBe(false);
    expect(matchesBoardCard(card, { query: "verifier", kind: "task", status: "blocked" })).toBe(false);
    expect(matchesBoardCard({ ...card, text: `${card.text} stn.tok_server-content` }, { query: "ship", kind: "", status: "" })).toBe(true);
    expect(matchesBoardCard({ ...card, project: "Bad Project" }, { query: "", kind: "", status: "" })).toBe(false);
  });

  test("reports visible results and honest empty states", () => {
    expect(boardResultLabel(3, 3, { query: "", kind: "", status: "" })).toBe("3 items on board");
    expect(boardResultLabel(1, 3, { query: "ship", kind: "", status: "" })).toBe("1 of 3 items visible");
    expect(boardEmptyMessage(0, 0, { query: "", kind: "", status: "" })).toBe("No items are available in the selected project.");
    expect(boardEmptyMessage(0, 3, { query: "missing", kind: "", status: "" })).toBe("No items match the current board filters.");
    expect(boardEmptyMessage(2, 3, { query: "ship", kind: "", status: "" })).toBe("");
  });

  test("publishes the existing item vocabularies", () => {
    expect(boardFilterKinds()).toEqual(["task", "finding", "question", "decision", "tip", "handoff", "note"]);
    expect(boardFilterStatuses()).toEqual(["ready", "active", "blocked", "done"]);
  });
});
