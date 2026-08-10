import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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

  test("keeps preview effect-free and uses the existing attachment PUT only after review", async () => {
    const action = await readFile(actionPath, "utf8");
    const previewPath = "/attachment/review`";
    const attachmentPath = "/attachment`";
    const previewIndex = action.indexOf(previewPath);
    const putIndex = action.indexOf("method: 'PUT'");
    const rereadIndex = action.indexOf("method: 'GET'", putIndex);

    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(action.indexOf("method: 'POST'", previewIndex)).toBeGreaterThan(previewIndex);
    expect(action.indexOf(attachmentPath, previewIndex + previewPath.length)).toBeGreaterThan(previewIndex);
    expect(putIndex).toBeGreaterThan(previewIndex);
    expect(rereadIndex).toBeGreaterThan(putIndex);
    expect(action).toContain("acceptAuthorityWidening: review.requiresAuthorityWidening");
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

  test("leaves repository verification visibly incomplete after accepted reread", async () => {
    const action = await readFile(actionPath, "utf8");
    expect(action).toContain("accepted · verification pending");
    expect(action).toContain("Guarded repository verification remains pending: get_repo, then fetch_file at an exact commit SHA.");
    expect(action).not.toContain("method: 'DELETE'");
  });
});
