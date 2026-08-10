import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import { ConvexMcpSetupEvidenceService } from "../src/mcp-setup-evidence-convex.ts";

class RecordingCaller implements ConvexCaller {
  readonly mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  fail = false;

  async query(): Promise<unknown> {
    throw new Error("unused query");
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.mutations.push({ name: getFunctionName(reference), args: { ...args } });
    if (this.fail) throw new Error("private first-read backend failure");
    return null;
  }
}

describe("Convex MCP first-read evidence adapter", () => {
  test("sends only service scope, account, and project to the first-read mutation", async () => {
    const client = new RecordingCaller();
    const service = new ConvexMcpSetupEvidenceService({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    await service.recordSetupFirstRead({
      accountId: "acct_test",
      project: "scrapbook",
    });
    expect(client.mutations).toEqual([{
      name: "mcpSetupEvidence:recordFirstRead",
      args: {
        serviceSecret: "private-service-secret",
        workspace: "default",
        accountId: "acct_test",
        project: "scrapbook",
      },
    }]);
    expect(client.mutations[0]?.args).not.toHaveProperty("toolName");
    expect(client.mutations[0]?.args).not.toHaveProperty("arguments");
    expect(client.mutations[0]?.args).not.toHaveProperty("result");
  });

  test("maps a first-read backend failure to the fixed evidence storage error", async () => {
    const client = new RecordingCaller();
    client.fail = true;
    const service = new ConvexMcpSetupEvidenceService({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    await expect(service.recordSetupFirstRead({
      accountId: "acct_test",
      project: "scrapbook",
    })).rejects.toThrow("MCP setup evidence storage failed");
  });
});
