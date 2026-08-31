import { describe, expect, test } from "bun:test";
import { runChatGptPluginPreflight } from "../scripts/chatgpt-plugin-preflight.ts";

describe("ChatGPT plugin publication preflight", () => {
  test("emits one bounded candidate receipt with actionable metadata gaps", async () => {
    const report = await runChatGptPluginPreflight();

    expect(report).toMatchObject({
      version: 1,
      status: "ready_for_portal_scan",
      snapshotVersion: 23,
      profile: "published_default",
      toolCount: 21,
      outputSchemaCount: 0,
      titleCount: 0,
      positiveTestCaseCount: 5,
      negativeTestCaseCount: 3,
      blockers: [],
    });
    expect(report.toolContractFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.serverInstructionsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.reviewedMetadataFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.warnings).toEqual([
      expect.stringContaining("21 public tools omit outputSchema"),
      expect.stringContaining("21 public tools omit a human-readable title"),
    ]);
    expect(JSON.stringify(report)).not.toContain("Use the reviewed public tools");
  });
});
