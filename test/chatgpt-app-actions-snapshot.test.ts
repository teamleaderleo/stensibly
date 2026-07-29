import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_VERSION,
  MCP_TOOL_NAMES,
} from "../src/mcp-diagnostics.ts";

interface FrozenToolInputs {
  properties: string[];
  required: string[];
}

interface ChatGptAppActionSnapshot {
  snapshotVersion: number;
  compatibilityEpoch: number;
  manifestVersion: number;
  toolCount: number;
  toolManifestFingerprint: string;
  tools: string[];
  compatibilityPolicy: string;
  newToolNamesAllowedDuringIncident: boolean;
  legacySnapshot: {
    toolCount: number;
    tools: string[];
    topLevelInputs: Record<string, FrozenToolInputs>;
  };
  requiredAdminActionAfterBackwardCompatibleChange: string;
  requiredAdminActionAfterBreakingChange: string;
  reviewedOn: string;
}

const snapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);
const recoveryPath = new URL("../docs/chatgpt-app-recovery.md", import.meta.url);

function readSnapshot(): ChatGptAppActionSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as ChatGptAppActionSnapshot;
}

describe("ChatGPT app action snapshot", () => {
  test("freezes the approved 26-action compatibility epoch while #490 is open", () => {
    const snapshot = readSnapshot();

    expect(snapshot.snapshotVersion).toBe(2);
    expect(snapshot.compatibilityEpoch).toBe(1);
    expect(snapshot.manifestVersion).toBe(MCP_TOOL_MANIFEST_VERSION);
    expect(snapshot.toolCount).toBe(26);
    expect(MCP_TOOL_NAMES).toHaveLength(26);
    expect(snapshot.toolCount).toBe(MCP_TOOL_NAMES.length);
    expect(snapshot.toolManifestFingerprint).toBe(MCP_TOOL_MANIFEST_FINGERPRINT);
    expect(snapshot.tools).toEqual([...MCP_TOOL_NAMES]);
    expect(snapshot.compatibilityPolicy).toBe(
      "preserve_approved_tool_names_and_frozen_inputs",
    );
    expect(snapshot.newToolNamesAllowedDuringIncident).toBe(false);
    expect(snapshot.requiredAdminActionAfterBackwardCompatibleChange).toBe("none");
    expect(snapshot.requiredAdminActionAfterBreakingChange).toBe(
      "refresh_or_recreate_chatgpt_app",
    );
    expect(snapshot.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("keeps the pre-receipt 25-action snapshot as an explicit compatibility target", () => {
    const snapshot = readSnapshot();

    expect(snapshot.legacySnapshot.toolCount).toBe(25);
    expect(snapshot.legacySnapshot.tools).toHaveLength(25);
    expect(snapshot.legacySnapshot.tools).not.toContain("get_operation_receipt");
    expect(new Set(snapshot.legacySnapshot.tools).size).toBe(25);
    expect(Object.keys(snapshot.legacySnapshot.topLevelInputs).sort()).toEqual(
      [...snapshot.legacySnapshot.tools].sort(),
    );
    for (const tool of snapshot.legacySnapshot.tools) {
      expect(snapshot.tools).toContain(tool);
      const input = snapshot.legacySnapshot.topLevelInputs[tool];
      expect(input).toBeDefined();
      expect(new Set(input.properties).size).toBe(input.properties.length);
      expect(new Set(input.required).size).toBe(input.required.length);
      for (const required of input.required) expect(input.properties).toContain(required);
    }
  });

  test("keeps the host-side recovery and coexistence procedure attached to the snapshot", () => {
    const snapshot = readSnapshot();
    const recovery = readFileSync(recoveryPath, "utf8");

    expect(recovery).toContain(String(snapshot.toolCount));
    expect(recovery).toContain(String(snapshot.legacySnapshot.toolCount));
    expect(recovery).toContain(snapshot.toolManifestFingerprint);
    expect(recovery).toContain("backward-compatible");
    expect(recovery).toContain("GitHub read → Stensibly read → GitHub read");
    expect(recovery).toContain("before network dispatch");
    expect(recovery).toContain("HAR");
  });
});
