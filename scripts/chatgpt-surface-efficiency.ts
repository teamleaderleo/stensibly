import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.js";
import {
  assertCompactPublishedSurface,
  measureMcpSurface,
} from "../src/mcp-surface-efficiency.js";
import { SqliteWorkLedger } from "../src/sqlite-ledger.js";
import { StensiblyStore } from "../src/store.js";

const store = new StensiblyStore(":memory:");
const server = createChatGptMcpServer(new SqliteWorkLedger(store));
const client = new Client(
  { name: "chatgpt-surface-efficiency", version: "1" },
  { capabilities: {} },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const receipt = measureMcpSurface(
    listed.tools,
    client.getInstructions() ?? "",
  );
  assertCompactPublishedSurface(receipt);
  console.log(JSON.stringify(receipt));
} finally {
  await client.close();
  await server.close();
  store.close();
}
