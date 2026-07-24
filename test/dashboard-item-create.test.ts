import { describe, expect, test } from "bun:test";
import {
  createIdempotencyTracker,
  formatValidationIssues,
  itemKinds,
  readCreatedItem,
  validateCreateItem,
} from "../site/item-create.js";

const actor = { id: "leo", name: "Leo", kind: "human" as const };

describe("dashboard create-item input", () => {
  test("normalizes the existing server create contract", () => {
    expect(validateCreateItem({
      project: " scrapbook ",
      kind: "task",
      title: " Ship it ",
      summary: " Useful context ",
      nextAction: " Open a PR ",
      priority: "75",
    }, actor)).toEqual({
      project: "scrapbook",
      kind: "task",
      title: "Ship it",
      summary: "Useful context",
      nextAction: "Open a PR",
      priority: 75,
      actor,
    });
  });

  test("uses priority 50 and omits empty optional fields", () => {
    expect(validateCreateItem({
      project: "release",
      kind: "decision",
      title: "Choose a host",
      summary: " ",
      nextAction: "",
      priority: "",
    }, actor)).toEqual({
      project: "release",
      kind: "decision",
      title: "Choose a host",
      priority: 50,
      actor,
    });
  });

  test("matches server item kinds and field limits", () => {
    expect(itemKinds()).toEqual(["task", "finding", "question", "decision", "tip", "handoff", "note"]);
    expect(() => validateCreateItem({ project: "Bad Project", kind: "task", title: "x" }, actor))
      .toThrow("lowercase project slug");
    expect(() => validateCreateItem({ project: "x".repeat(81), kind: "task", title: "x" }, actor))
      .toThrow("maximum 80");
    expect(() => validateCreateItem({ project: "p", kind: "unknown", title: "x" }, actor))
      .toThrow("supported item kind");
    expect(() => validateCreateItem({ project: "p", kind: "task", title: "x".repeat(241) }, actor))
      .toThrow("maximum 240");
    expect(() => validateCreateItem({ project: "p", kind: "task", title: "x", priority: 101 }, actor))
      .toThrow("0 to 100");
    expect(() => validateCreateItem({ project: "p", kind: "task", title: "stn.tok_secret.value" }, actor))
      .toThrow("Credential-shaped");
    expect(() => validateCreateItem({ project: "p", kind: "task", title: "x" }, null))
      .toThrow("active session actor");
  });
});

describe("dashboard created-item response", () => {
  test("returns only the fields needed by the browser continuation", () => {
    expect(readCreatedItem({
      item: {
        id: " item_1 ",
        project: " scrapbook ",
        title: " Created item ",
        tokenId: "tok_private",
        rawToken: "stn.tok_secret.value",
        internal: { secret: true },
      },
    })).toEqual({ id: "item_1", project: "scrapbook", title: "Created item" });
  });

  test("rejects malformed and credential-shaped responses", () => {
    expect(() => readCreatedItem(null)).toThrow("incompatible created-item");
    expect(() => readCreatedItem({ item: { id: "", project: "p", title: "x" } })).toThrow("missing id");
    expect(() => readCreatedItem({ item: { id: "item_1", project: "Bad Project", title: "x" } }))
      .toThrow("invalid project slug");
    expect(() => readCreatedItem({ item: { id: "item_1", project: "p", title: "stn.tok_secret.value" } }))
      .toThrow("Credential-shaped");
  });
});

describe("dashboard create idempotency", () => {
  test("reuses a key for an unchanged validated submission", () => {
    const keys = ["web_first", "web_second", "web_third"];
    const tracker = createIdempotencyTracker(() => keys.shift()!);
    const first = { project: "p", title: "one", priority: 50 };
    expect(tracker.keyFor(first)).toBe("web_first");
    expect(tracker.keyFor({ ...first })).toBe("web_first");
    expect(tracker.current()).toBe("web_first");
    expect(tracker.keyFor({ ...first, priority: 51 })).toBe("web_second");
    tracker.reset();
    expect(tracker.current()).toBe("");
    expect(tracker.keyFor(first)).toBe("web_third");
  });
});

describe("dashboard create validation issues", () => {
  test("formats a bounded set of server issues", () => {
    const issues = Array.from({ length: 12 }, (_, index) => ({
      path: `field-${index}`,
      message: `message-${index}`,
    }));
    const output = formatValidationIssues({ issues });
    expect(output).toContain("field-0: message-0");
    expect(output).toContain("field-7: message-7");
    expect(output).not.toContain("field-8");
    expect(output.length).toBeLessThanOrEqual(1_200);
  });
});
