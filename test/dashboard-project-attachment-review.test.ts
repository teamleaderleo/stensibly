import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  admitProjectAttachmentReviewSource,
} from "../site/project-attachment-review-entry.js";

const actionPath = "site/project-attachment-review-entry.js";

describe("dashboard project attachment review action", () => {
  test("installs after hosted-session fetch rewriting and setup-status card", async () => {
    const [bridge, action, assets] = await Promise.all([
      readFile("site/hosted-session-bridge.js", "utf8"),
      readFile(actionPath, "utf8"),
      readFile("src/dashboard-assets.ts", "utf8"),
    ]);

    const fetchBridge = bridge.indexOf("window.fetch = installHostedSessionFetchBridge");
    const setupCard = bridge.indexOf("installProjectSetupStatusCard();");
    const reviewAction = bridge.indexOf("installProjectAttachmentReviewAction();");
    expect(fetchBridge).toBeGreaterThanOrEqual(0);
    expect(setupCard).toBeGreaterThan(fetchBridge);
    expect(reviewAction).toBeGreaterThan(setupCard);
    expect(bridge).toContain("./project-attachment-review-entry.js");
    expect(action).toContain("installProjectAttachmentReviewAction");
    expect(assets).toContain('path: "/project-attachment-review-entry.js"');
  });

  test("keeps preview effect-free and rechecks the exact decision before the sole attachment PUT", async () => {
    const action = await readFile(actionPath, "utf8");
    const previewPath = "/attachment/review`";
    const attachmentPath = "/attachment`";
    const previewIndex = action.indexOf(previewPath);
    const putIndex = action.indexOf("method: 'PUT'");
    const rereadIndex = action.indexOf("method: 'GET'", putIndex);

    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(action.indexOf("method: 'POST'", previewIndex)).toBeGreaterThan(previewIndex);
    expect(action.match(/\/attachment\/review`/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(action.match(/method: 'PUT'/g)?.length ?? 0).toBe(1);
    expect(action.indexOf(attachmentPath, previewIndex + previewPath.length)).toBeGreaterThan(previewIndex);
    expect(putIndex).toBeGreaterThan(previewIndex);
    expect(rereadIndex).toBeGreaterThan(putIndex);
    expect(action).toContain("Rechecking the reviewed attachment before acceptance");
    expect(action).toContain("freshReview.decisionFingerprint !== review.decisionFingerprint");
    expect(action).toContain("proposalSemanticFingerprint: proposal.semanticFingerprint");
    expect(action).toContain("acceptAuthorityWidening: freshReview.requiresAuthorityWidening");
    expect(action).toContain("readAcceptedAttachment(payload");
    expect(action).toContain("Accepted snapshot reread successfully");
  });

  test("invalidates stale previews, exposes cancel, and gates widening acknowledgement", async () => {
    const action = await readFile(actionPath, "utf8");
    expect(action).toContain("source.addEventListener('input', invalidateReview)");
    expect(action).toContain("revision.addEventListener('input', invalidateReview)");
    expect(action).toContain("project-attachment-review-cancel");
    expect(action).toContain("project-attachment-review-acknowledge");
    expect(action).toContain("acceptButton.disabled = review.requiresAuthorityWidening");
    expect(action).toContain("review.requiresAuthorityWidening && !checkbox.checked");
    expect(action).toContain("authorizesAttachmentAcceptance !== false");
    expect(action).toContain("authorizesProviderEffect !== false");
  });

  test("rejects realistic credential material before preview", () => {
    const ordinary = "# Stensibly project contract\n\nNo credentials are retained here.";
    const authWord = ["Author", "ization"].join("");
    const bearerWord = ["Bear", "er"].join("");
    expect(admitProjectAttachmentReviewSource(ordinary)).toBe(ordinary);
    expect(() => admitProjectAttachmentReviewSource(
      `# Stensibly project contract\n\n${bearerWord} ${"a".repeat(24)}`,
    )).toThrow("credential-shaped material");
    expect(() => admitProjectAttachmentReviewSource(
      `${authWord}: ${bearerWord} ${"b".repeat(24)}`,
    )).toThrow("credential-shaped material");
  });

  test("leaves repository verification visibly incomplete after accepted reread", async () => {
    const action = await readFile(actionPath, "utf8");
    expect(action).toContain("accepted · verification pending");
    expect(action).toContain("Guarded repository verification remains pending: get_repo, then fetch_file at an exact commit SHA.");
    expect(action).not.toContain("method: 'DELETE'");
  });
});