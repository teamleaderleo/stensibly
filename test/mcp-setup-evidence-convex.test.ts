import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import { ConvexMcpSetupEvidenceService } from "../src/mcp-setup-evidence-convex.ts";

const evidence = {
  version: 1 as const,
  accountId: "acct_test",
  project: "scrapbook",
  connectedAt: "2026-08-10T05:30:00.000Z",
  firstReadAt: null,
  containsSecrets: false as const,
};

class EvidenceCaller implements ConvexCaller {
  readonly calls: string[] = [];
  readonly args: Record<string, unknown>[] = [];
  queryResult: unknown = evidence;
  failQuery = false;
  failMutation = false;

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push(`query:${getFunctionName(reference)}`);
    this.args.push({ ...args });
    if (this.failQuery) throw new Error("private query failure with secret://backend");
    return this.queryResult;
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push(`mutation:${getFunctionName(reference)}`);
    this.args.push({ ...args });
    if (this.failMutation) throw new Error("private mutation failure with secret://backend");
    return null;
  }
}

describe("Convex MCP setup evidence service", () => {
  test("writes issuance-time project scope and reads an admitted account/project projection", async () => {
    const client = new EvidenceCaller();
    const service = new ConvexMcpSetupEvidenceService({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });

    await service.recordSetupConnection({
      accountId: "acct_test",
      clientId: "oauth_client_abcdefghijkl",
      resource: "https://api.stensibly.com/mcp",
      projects: ["scrapbook"],
    });
    expect(client.calls[0]).toBe("mutation:mcpSetupEvidence:recordConnection");
    expect(client.args[0]).toEqual({
      serviceSecret: "private-service-secret",
      workspace: "default",
      accountId: "acct_test",
      clientId: "oauth_client_abcdefghijkl",
      resource: "https://api.stensibly.com/mcp",
      projects: ["scrapbook"],
    });
    expect(client.args[0]).not.toHaveProperty("accessToken");
    expect(client.args[0]).not.toHaveProperty("refreshToken");

    expect(await service.getMcpSetupEvidence({
      accountId: "acct_test",
      project: "scrapbook",
    })).toEqual(evidence);
    expect(client.calls[1]).toBe("query:mcpSetupEvidence:getEvidence");
  });

  test("forwards workspace-wide issuance scope explicitly", async () => {
    const client = new EvidenceCaller();
    const service = new ConvexMcpSetupEvidenceService({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    await service.recordSetupConnection({
      accountId: "acct_test",
      clientId: "oauth_client_abcdefghijkl",
      resource: "https://api.stensibly.com/mcp",
      projects: null,
    });
    expect(client.args[0]).toMatchObject({ projects: null });
  });

  test("collapses backend and malformed-response failures to one fixed storage error", async () => {
    const writerClient = new EvidenceCaller();
    writerClient.failMutation = true;
    const writer = new ConvexMcpSetupEvidenceService({
      client: writerClient,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    await expect(writer.recordSetupConnection({
      accountId: "acct_test",
      clientId: "oauth_client_abcdefghijkl",
      resource: "https://api.stensibly.com/mcp",
      projects: ["scrapbook"],
    })).rejects.toThrow("MCP setup evidence storage failed");

    const readerClient = new EvidenceCaller();
    readerClient.failQuery = true;
    const reader = new ConvexMcpSetupEvidenceService({
      client: readerClient,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    await expect(reader.getMcpSetupEvidence({
      accountId: "acct_test",
      project: "scrapbook",
    })).rejects.toThrow("MCP setup evidence storage failed");

    const malformedClient = new EvidenceCaller();
    malformedClient.queryResult = { ...evidence, accountId: "acct_other" };
    const malformed = new ConvexMcpSetupEvidenceService({
      client: malformedClient,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    await expect(malformed.getMcpSetupEvidence({
      accountId: "acct_test",
      project: "scrapbook",
    })).rejects.toThrow("MCP setup evidence storage failed");
  });

  test("requires exact lowercase workspace configuration", () => {
    const client = new EvidenceCaller();
    expect(() => new ConvexMcpSetupEvidenceService({
      client,
      serviceSecret: "private-service-secret",
      workspace: " Default ",
    })).toThrow("Workspace must be a lowercase slug");
  });
});
