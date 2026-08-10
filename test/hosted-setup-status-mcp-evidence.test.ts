import { describe, expect, test } from "bun:test";
import { createHostedSetupStatusObserver } from "../src/hosted-setup-status.ts";
import type {
  McpSetupEvidence,
  McpSetupEvidenceReader,
} from "../src/mcp-setup-evidence.ts";

const observedAtMillis = Date.parse("2026-08-10T04:05:00.000Z");

class EvidenceReader implements McpSetupEvidenceReader {
  readonly evidence: McpSetupEvidence;
  calls: Array<{ accountId: string; project: string }> = [];

  constructor(evidence: McpSetupEvidence) {
    this.evidence = evidence;
  }

  async getMcpSetupEvidence(input: { accountId: string; project: string }) {
    this.calls.push(input);
    return this.evidence;
  }
}

describe("hosted setup MCP evidence projection", () => {
  test("advances connection only from exact account/project evidence", async () => {
    const reader = new EvidenceReader({
      version: 1,
      accountId: "acct_owner",
      project: "scrapbook",
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: null,
      containsSecrets: false,
    });
    const observer = createHostedSetupStatusObserver({
      serviceOrigin: "https://api.stensibly.com",
      workspaceConfigured: true,
      oauthConfigured: true,
      mcpSetupEvidence: reader,
      now: () => observedAtMillis,
    });
    const observation = await observer.observe({
      project: "scrapbook",
      principalKind: "account",
      accountId: "acct_owner",
      hasAcceptedAttachment: false,
    });
    expect(reader.calls).toEqual([{ accountId: "acct_owner", project: "scrapbook" }]);
    expect(observation.setup.steps.mcp_connection).toBe("ready");
    expect(observation.setup.steps.first_read).toBe("missing");
    expect(observation.setup.lastVerifiedStep).toBe("mcp_connection");
  });

  test("advances first read only after coherent later evidence", async () => {
    const reader = new EvidenceReader({
      version: 1,
      accountId: "acct_owner",
      project: "scrapbook",
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: "2026-08-10T04:01:00.000Z",
      containsSecrets: false,
    });
    const observer = createHostedSetupStatusObserver({
      serviceOrigin: "https://api.stensibly.com",
      workspaceConfigured: true,
      oauthConfigured: true,
      mcpSetupEvidence: reader,
      now: () => observedAtMillis,
    });
    const observation = await observer.observe({
      project: "scrapbook",
      principalKind: "account",
      accountId: "acct_owner",
      hasAcceptedAttachment: false,
    });
    expect(observation.setup.steps.mcp_connection).toBe("ready");
    expect(observation.setup.steps.first_read).toBe("ready");
    expect(observation.setup.lastVerifiedStep).toBe("first_read");
  });

  test("never reads account-scoped evidence for API tokens or anonymous setup", async () => {
    const reader = new EvidenceReader({
      version: 1,
      accountId: "acct_owner",
      project: "scrapbook",
      connectedAt: "2026-08-10T04:00:00.000Z",
      firstReadAt: "2026-08-10T04:01:00.000Z",
      containsSecrets: false,
    });
    const observer = createHostedSetupStatusObserver({
      serviceOrigin: "https://api.stensibly.com",
      workspaceConfigured: true,
      oauthConfigured: true,
      mcpSetupEvidence: reader,
      now: () => observedAtMillis,
    });
    for (const principalKind of ["api_token", "anonymous"] as const) {
      const observation = await observer.observe({
        project: "scrapbook",
        principalKind,
        accountId: null,
        hasAcceptedAttachment: false,
      });
      expect(observation.setup.steps.mcp_connection).toBe("missing");
      expect(observation.setup.steps.first_read).toBe("missing");
    }
    expect(reader.calls).toEqual([]);
  });

  test("fails closed on cross-account or cross-project backend substitution", async () => {
    for (const evidence of [
      {
        version: 1,
        accountId: "acct_other",
        project: "scrapbook",
        connectedAt: "2026-08-10T04:00:00.000Z",
        firstReadAt: null,
        containsSecrets: false,
      },
      {
        version: 1,
        accountId: "acct_owner",
        project: "other",
        connectedAt: "2026-08-10T04:00:00.000Z",
        firstReadAt: null,
        containsSecrets: false,
      },
    ] as McpSetupEvidence[]) {
      const observer = createHostedSetupStatusObserver({
        serviceOrigin: "https://api.stensibly.com",
        workspaceConfigured: true,
        oauthConfigured: true,
        mcpSetupEvidence: new EvidenceReader(evidence),
        now: () => observedAtMillis,
      });
      await expect(observer.observe({
        project: "scrapbook",
        principalKind: "account",
        accountId: "acct_owner",
        hasAcceptedAttachment: false,
      })).rejects.toThrow("scope is invalid");
    }
  });
});
