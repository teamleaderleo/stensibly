import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_VERSION,
  MCP_TOOL_NAMES,
} from "../src/mcp-diagnostics.ts";

interface ChatGptAppActionSnapshot {
  snapshotVersion: number;
  manifestVersion: number;
  toolCount: number;
  toolManifestFingerprint: string;
  tools: string[];
  requiredAdminActionAfterChange: string;
  reviewedOn: string;
}

const snapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);
const recoveryPath = new URL("../docs/chatgpt-app-recovery.md", import.meta.url);

function readSnapshot(): ChatGptAppActionSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as ChatGptAppActionSnapshot;
}

describe("ChatGPT app action snapshot", () => {
  test("requires an explicit checked-in refresh checkpoint for every MCP tool-manifest change", () => {
    const snapshot = readSnapshot();

    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.manifestVersion).toBe(MCP_TOOL_MANIFEST_VERSION);
    expect(snapshot.toolCount).toBe(MCP_TOOL_NAMES.length);
    expect(snapshot.toolManifestFingerprint).toBe(MCP_TOOL_MANIFEST_FINGERPRINT);
    expect(snapshot.tools).toEqual([...MCP_TOOL_NAMES]);
    expect(snapshot.requiredAdminActionAfterChange).toBe(
      "refresh_or_recreate_chatgpt_app",
    );
    expect(snapshot.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("keeps the host-side recovery and coexistence procedure attached to the snapshot", () => {
    const snapshot = readSnapshot();
    const recovery = readFileSync(recoveryPath, "utf8");

    expect(recovery).toContain(String(snapshot.toolCount));
    expect(recovery).toContain(snapshot.toolManifestFingerprint);
    expect(recovery).toContain("Refresh or recreate the ChatGPT app");
    expect(recovery).toContain("GitHub read → Stensibly read → GitHub read");
    expect(recovery).toContain("before network dispatch");
    expect(recovery).toContain("HAR");
  });
});
