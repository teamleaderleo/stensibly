import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { admitProjectAttachmentReviewDiff } from "../site/project-attachment-review-entry.js";

const from = `sha256:${"a".repeat(64)}`;
const to = `sha256:${"b".repeat(64)}`;

describe("dashboard project attachment review diff", () => {
  test("retains only field, kind, and authority effect from the server-owned diff", () => {
    const credentialShapedBefore = "github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const admitted = admitProjectAttachmentReviewDiff({
      from,
      to,
      widensAuthority: true,
      changes: [
        {
          field: "autonomousActions",
          kind: "added",
          before: credentialShapedBefore,
          after: ["create_draft_pr"],
          authorityEffect: "widens",
        },
        {
          field: "context.goal",
          kind: "changed",
          before: "old narrative",
          after: "new narrative",
          authorityEffect: "neutral",
        },
      ],
    }, to);

    expect(admitted).toEqual({
      from,
      to,
      widensAuthority: true,
      changes: [
        { field: "autonomousActions", kind: "added", authorityEffect: "widens" },
        { field: "context.goal", kind: "changed", authorityEffect: "neutral" },
      ],
    });
    expect(JSON.stringify(admitted)).not.toContain(credentialShapedBefore);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted?.changes)).toBe(true);
    expect(admitted?.changes.every(Object.isFrozen)).toBe(true);
  });

  test("fails closed for malformed structural metadata and contradictory widening", () => {
    const base = {
      from,
      to,
      widensAuthority: false,
      changes: [{
        field: "context.goal",
        kind: "changed",
        before: "old",
        after: "new",
        authorityEffect: "neutral",
      }],
    };
    expect(() => admitProjectAttachmentReviewDiff({
      ...base,
      changes: [{ ...base.changes[0], field: "context.goal.more" }],
    }, to)).toThrow("review diff field is invalid");
    expect(() => admitProjectAttachmentReviewDiff({
      ...base,
      changes: [{ ...base.changes[0], kind: "rewritten" }],
    }, to)).toThrow("review diff change is invalid");
    expect(() => admitProjectAttachmentReviewDiff({
      ...base,
      changes: [base.changes[0], base.changes[0]],
    }, to)).toThrow("review diff change is invalid");
    expect(() => admitProjectAttachmentReviewDiff({
      ...base,
      widensAuthority: false,
      changes: [{ ...base.changes[0], authorityEffect: "widens" }],
    }, to)).toThrow("review diff authority summary is invalid");
    expect(() => admitProjectAttachmentReviewDiff({
      ...base,
      changes: Array.from({ length: 33 }, (_, index) => ({
        field: `field${index}`,
        kind: "changed",
        authorityEffect: "neutral",
      })),
    }, to)).toThrow("review diff changes are invalid");
  });

  test("keeps first acceptance and exact replay representable without invented changes", () => {
    expect(admitProjectAttachmentReviewDiff(null, to)).toBeNull();
    expect(() => admitProjectAttachmentReviewDiff({
      from,
      to,
      widensAuthority: true,
      changes: [{ field: "repositories", kind: "added", authorityEffect: "widens" }],
    }, to, true)).toThrow("review replay diff is invalid");
  });

  test("renders admitted change identity and binds it into the freshness decision without before/after values", async () => {
    const action = await readFile("site/project-attachment-review-entry.js", "utf8");
    expect(action).toContain("Reviewed changes");
    expect(action).toContain("renderReviewedChanges(review.diffIdentity, review.exactReplay)");
    expect(action).toContain("diffIdentity,");
    expect(action).toContain("change.field");
    expect(action).toContain("change.kind");
    expect(action).toContain("change.authorityEffect");
    expect(action).not.toContain("change.before");
    expect(action).not.toContain("change.after");
  });
});
