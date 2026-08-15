import { describe, expect, test } from "vitest";

describe("Gmail mailbox disposition Convex indexes", () => {
  test("exact-message lane index stays within the Convex identifier limit", () => {
    const indexName = "by_workspace_provider_account_binding_mailbox_thread_message";
    expect(indexName.length).toBe(60);
    expect(indexName.length).toBeLessThanOrEqual(64);
  });
});
