import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import { getProjectBrief } from "../src/briefs.ts";
import { asToolResult } from "../src/mcp-tool-result.ts";
import { compactPublicMcpResult } from "../src/public-mcp-result.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { commanderScenario } from "../test/support/commander-scenarios.ts";

// The old ledger brief and renderer remain available, so compare identical source
// facts without retaining a second implementation or a copied historical result.
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const results = [];
for (const state of ["overview", "completed", "blocked", "cleared"] as const) {
  const { store } = commanderScenario(state);
  const source = getProjectBrief(store, "commander", 100);
  const before = compactPublicMcpResult(await asToolResult(async () => source));
  const ledger = new SqliteWorkLedger(store);
  ledger.getBrief = async () => source;
  const server = createChatGptMcpServer(ledger);
  const client = new Client({ name: "commander-measure", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const after = await client.callTool({ name: "get_brief", arguments: { project: "commander" } });
    const data = (after.structuredContent as { data: { fingerprint: string } }).data;
    const repeat = await client.callTool({ name: "get_brief", arguments: { project: "commander", previousFingerprint: data.fingerprint } });
    results.push({ state, beforeBytes: bytes(before), afterBytes: bytes(after), repeatBytes: bytes(repeat),
      readsBeforeDecision: { before: 1, after: 1 },
      decision: state === "blocked" ? "Restore or replace the acceptance target." : state === "completed" ? "Inspect the recorded acceptance result before reuse." : "Choose the internal acceptance target, then inspect the exact candidate.",
      before, after, repeat });
  } finally { await client.close(); await server.close(); store.close(); }
}
await Bun.write(new URL("../artifacts/commander/comparison.json", import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ before, after, repeat, ...metrics }) => metrics), null, 2));
