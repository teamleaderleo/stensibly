import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import {
  CONTINUATION_CARD_MIME_TYPE,
  CONTINUATION_CARD_URI,
} from "../src/continuation-card-widget.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const agent = { id: "agent", name: "Agent", kind: "agent" as const };
const leo = { id: "leo", name: "Leo", kind: "human" as const };

describe("ChatGPT continuation card app", () => {
  test("renders one durable proposal with editing and fresh-turn interaction contracts", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const item = await ledger.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Finish the card integration",
      summary: "The server contract is ready for human review.",
      nextAction: "Ask the human whether to continue.",
      priority: 75,
      actor: agent,
    });
    const proposal = await ledger.proposeContinuation({
      sourceItemId: item.id,
      title: "Review and continue the card work",
      rationale: "A human should authorize the next implementation step.",
      instruction: "Review the card output and continue in this conversation.",
      action: { kind: "resume_item", itemId: item.id },
      evidence: [{
        kind: "commit",
        label: "Card implementation",
        uri: "git:teamleaderleo/stensibly@card123",
      }],
      actor: agent,
      approvalMode: "human",
      deliveryMode: "current_conversation",
    });

    const server = createChatGptMcpServer(ledger);
    const client = new Client(
      { name: "continuation-card-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("show_continuation_card");
      expect(names).toContain("list_continuation_inbox");
      expect(names).toContain("edit_continuation");
      const cardTool = tools.tools.find((tool) => tool.name === "show_continuation_card");
      expect(cardTool).toMatchObject({
        title: "Show continuation decision card",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        _meta: {
          ui: { resourceUri: CONTINUATION_CARD_URI },
          "openai/outputTemplate": CONTINUATION_CARD_URI,
        },
      });
      expect(cardTool?.outputSchema).toBeDefined();

      const result = await client.callTool({
        name: "show_continuation_card",
        arguments: { id: proposal.id, actor: leo },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        kind: "stensibly.continuation-card",
        continuation: {
          id: proposal.id,
          status: "proposed",
          generation: 1,
        },
        sourceItem: {
          id: item.id,
          project: "scrapbook",
          title: "Finish the card integration",
          priority: 75,
        },
        actor: leo,
      });

      const resource = await client.readResource({ uri: CONTINUATION_CARD_URI });
      expect(resource.contents).toHaveLength(1);
      const content = resource.contents[0];
      expect(content?.mimeType).toBe(CONTINUATION_CARD_MIME_TYPE);
      expect(content?._meta).toMatchObject({
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
          prefersBorder: true,
        },
        "openai/widgetDescription": expect.any(String),
      });
      const html = content && "text" in content ? content.text : "";
      expect(html).toContain("window.openai.sendFollowUpMessage");
      expect(html).toContain("window.openai.callTool");
      expect(html).toContain('method: "ui/message"');
      expect(html).toContain('bridgeRequest("tools/call"');
      expect(html).toContain('callServerTool("edit_continuation"');
      expect(html).toContain("updated?.generation !== currentGeneration + 1");
      expect(html).toContain("verify it is still at generation");
      expect(html).toContain("Edit instruction");
      expect(html).toContain("Save instruction");
      expect(html).toContain("Continue here");
      expect(html).toContain("Later");
      expect(html).toContain("Reject");
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
