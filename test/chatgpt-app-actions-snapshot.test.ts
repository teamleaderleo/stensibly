import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  MCP_TOOL_MANIFEST_FINGERPRINT,
  MCP_TOOL_MANIFEST_VERSION,
  MCP_TOOL_NAMES,
} from "../src/mcp-diagnostics.ts";

interface LegacyToolInputs {
  properties: string[];
  required: string[];
}

interface ChatGptAppActionSnapshot {
  snapshotVersion: number;
  manifestVersion: number;
  toolCount: number;
  toolManifestFingerprint: string;
  tools: string[];
  compatibilityPolicy: string;
  additiveToolNamesAllowed: boolean;
  legacySnapshot: {
    toolCount: number;
    tools: string[];
    topLevelInputs: Record<string, LegacyToolInputs>;
  };
  requiredAdminActionAfterCompatibleExistingActionChange: string;
  requiredAdminActionToUseNewActions: string;
  requiredAdminActionAfterBreakingChange: string;
  reviewedOn: string;
}

const snapshotPath = new URL("../docs/chatgpt-app-actions.json", import.meta.url);
const recoveryPath = new URL("../docs/chatgpt-app-recovery.md", import.meta.url);

function readSnapshot(): ChatGptAppActionSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as ChatGptAppActionSnapshot;
}

describe("ChatGPT app action snapshot", () => {
  test("tracks the current manifest without blocking additive tool growth", () => {
    const snapshot = readSnapshot();

    expect(snapshot.snapshotVersion).toBe(3);
    expect(snapshot.manifestVersion).toBe(MCP_TOOL_MANIFEST_VERSION);
    expect(snapshot.toolCount).toBe(MCP_TOOL_NAMES.length);
    expect(snapshot.toolManifestFingerprint).toBe(MCP_TOOL_MANIFEST_FINGERPRINT);
    expect(snapshot.tools).toEqual([...MCP_TOOL_NAMES]);
    expect(snapshot.compatibilityPolicy).toBe(
      "allow_additive_tool_growth_preserve_existing_inputs",
    );
    expect(snapshot.additiveToolNamesAllowed).toBe(true);
    expect(snapshot.requiredAdminActionAfterCompatibleExistingActionChange).toBe("none");
    expect(snapshot.requiredAdminActionToUseNewActions).toBe(
      "refresh_or_recreate_chatgpt_app",
    );
    expect(snapshot.requiredAdminActionAfterBreakingChange).toBe(
      "refresh_or_recreate_chatgpt_app",
    );
    expect(snapshot.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("keeps the pre-receipt 25-action snapshot as a compatibility target", () => {
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
      if (!input) throw new Error(`Missing legacy input checkpoint for ${tool}`);
      expect(new Set(input.properties).size).toBe(input.properties.length);
      expect(new Set(input.required).size).toBe(input.required.length);
      for (const required of input.required) expect(input.properties).toContain(required);
    }
  });

  test("keeps recovery guidance attached without prescribing a tool freeze", () => {
    const snapshot = readSnapshot();
    const recovery = readFileSync(recoveryPath, "utf8");

    expect(recovery).toContain(String(snapshot.toolCount));
    expect(recovery).toContain(snapshot.toolManifestFingerprint);
    expect(recovery).toContain("additive tool growth is allowed");
    expect(recovery).toContain("GitHub read → Stensibly read → GitHub read");
    expect(recovery).toContain("before network dispatch");
    expect(recovery).toContain("HAR");
    expect(recovery).not.toContain("public action list stays at 26");
    expect(recovery).not.toContain("proposed 27th public tool should be reworked");
  });
});
