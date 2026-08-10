import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("System attachment acceptance preflight", () => {
  test("rechecks the exact review immediately before the sole attachment PUT", async () => {
    const entry = await readFile("site/project-setup-status-entry.js", "utf8");
    expect(entry).toContain("Rechecking the reviewed attachment before acceptance");
    expect(entry).toContain("sameAttachmentReviewDecision(review, freshReview)");
    expect(entry).toContain("The repository proposal changed before acceptance");
    expect(entry).toContain("The attachment decision changed before acceptance");
    expect(entry.match(/\/attachment\/review/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(entry.match(/method: 'PUT'/g)?.length ?? 0).toBe(1);
  });
});
