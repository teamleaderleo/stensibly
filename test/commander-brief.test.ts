import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compileCommanderBrief, renderCommanderBrief } from "../src/commander-brief.ts";
import { getProjectBrief } from "../src/briefs.ts";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { commanderScenario } from "./support/commander-scenarios.ts";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { mcpRequest, toolCall } from "./support/mcp-http.ts";

function fixture(state: Parameters<typeof commanderScenario>[0] = "overview") {
  const { store, item } = commanderScenario(state);
  try { return { source: getProjectBrief(store, "commander", 100), item }; }
  finally { store.close(); }
}
const read = (source: unknown, previousFingerprint?: string, now = Date.now(), limit = 10) =>
  compileCommanderBrief(source, { project: "commander", limit, previousFingerprint, now });

describe("commander brief", () => {
  test("a blocker backlog leaves room for a candidate and a dated result", () => {
    const { source, item } = fixture();
    const candidate = source.ready.find((row) => row.id === item.id)!;
    source.blocked = Array.from({ length: 10 }, (_, i) => ({ ...candidate, id: `block-${i}`, status: "blocked" as const, priority: 100, updatedAt: "2026-08-10T00:00:00.000Z" }));
    source.recentlyCompleted = [{ ...candidate, id: "result", status: "done" }];
    source.counts.byStatus.blocked = 10;
    const result = read(source, undefined, Date.now(), 3);
    expect(result.attention).toHaveLength(1);
    expect(result.ready).toHaveLength(1);
    expect(result.recentlyCompleted).toHaveLength(1);
    expect(result.omitted?.actionable).toBe(10);
    source.ready = source.ready.filter((row) => row.kind !== "decision");
    source.knowledge = source.knowledge.filter((row) => row.kind !== "decision");
    source.counts.byStatus.ready--;
    const noDecision = read(source, undefined, Date.now(), 3);
    expect(noDecision.blocked).toHaveLength(1);
    expect(noDecision.ready).toHaveLength(1);
    expect(noDecision.recentlyCompleted).toHaveLength(1);
    expect(renderCommanderBrief(noDecision)).toContain("record updated 2026-08-10T00:00:00.000Z");
    for (const limit of [1, 2, 3]) {
      const small = read(source, undefined, Date.now(), limit);
      expect((small.attention?.length ?? 0) + small.blocked.length + small.active.length + small.ready.length + (small.recentlyCompleted?.length ?? 0)).toBeLessThanOrEqual(limit);
      expect(small.blocked).toHaveLength(1);
    }
  });

  test("a complete scan can compact output omissions but refreshes hidden changes", () => {
    const { source, item } = fixture();
    const candidate = source.ready.find((row) => row.id === item.id)!;
    source.blocked = Array.from({ length: 5 }, (_, i) => ({ ...candidate, id: `blocked-${i}`, status: "blocked" as const }));
    source.counts.byStatus.blocked = 5;
    const first = read(source, undefined, Date.now(), 3);
    const repeat = read(source, first.fingerprint, Date.now(), 3);
    expect(repeat.status).toBe("unchanged");
    expect(repeat.omitted?.actionable).toBeGreaterThan(0);
    expect(repeat.expansion?.omitted.arguments).toEqual({ project: "commander" });
    expect(renderCommanderBrief(repeat)).toContain("other actionable records remain omitted");
    const hidden = source.blocked.find((row) => !first.blocked.some((shown) => shown.id === row.id))!;
    hidden.summary = "A different intervention is required";
    expect(read(source, first.fingerprint, Date.now(), 3).status).toBe("current");
    const changed = read(source, undefined, Date.now(), 3);
    source.blocked = source.blocked.filter((row) => row.id !== hidden.id);
    source.counts.byStatus.blocked--; source.counts.byStatus.ready++;
    source.ready.push({ ...hidden, status: "ready" });
    expect(read(source, changed.fingerprint, Date.now(), 3).status).toBe("current");
  });

  test("overview separates decisions, candidates and history and suppresses healthy workers", () => {
    const { source, item } = fixture();
    const result = read(source);
    expect(result.attention).toHaveLength(1);
    expect(result.ready).toMatchObject([{ id: item.id, reason: "ready_with_next_action;priority=80" }]);
    expect(result.active).toEqual([]);
    expect(result.omitted).toMatchObject({ activeWithLiveClaims: 5, history: 1, actionable: 0 });
    expect(result.coverage).toMatchObject({ provider: "unavailable_in_brief", capacity: "unknown", execution: "requires_current_admission" });
    expect(result.expansion?.item).toMatchObject({ tool: "get_runner_context", argument: "id" });
    expect(renderCommanderBrief(result)).toContain(`get_runner_context id=${item.id}`);
    expect(JSON.stringify(result).match(new RegExp(item.id, "g"))).toHaveLength(1);
  });

  test("new result, blocker and clearing replace the prior snapshot without inventing events", () => {
    const { source, item } = fixture();
    const before = read(source);
    const candidate = source.ready.find((entry) => entry.id === item.id)!;
    source.ready = source.ready.filter((entry) => entry.id !== item.id);
    source.counts.byStatus.ready--; source.counts.byStatus.blocked++;
    source.blocked.push({ ...candidate, status: "blocked", summary: "Target unavailable", nextAction: "Restore target" });
    const blocked = read(source, before.fingerprint);
    expect(blocked.status).toBe("current"); expect(blocked.blocked[0]?.summary).toBe("Target unavailable");
    source.blocked = []; source.counts.byStatus.blocked--; source.counts.byStatus.ready++;
    source.ready.push({ ...candidate, summary: "Target recovered", nextAction: "Retry acceptance" });
    const cleared = read(source, blocked.fingerprint);
    expect(cleared.blocked).toEqual([]); expect(cleared.ready[0]?.summary).toBe("Target recovered");
    source.ready = source.ready.filter((entry) => entry.id !== item.id);
    source.counts.byStatus.ready--; source.counts.byStatus.done++;
    source.recentlyCompleted.push({ ...candidate, status: "done", summary: "Acceptance passed" });
    const done = read(source, cleared.fingerprint);
    expect(done.recentlyCompleted).toMatchObject([{ id: item.id, summary: "Acceptance passed" }]);
    expect(done.coverage.changes).toBe("snapshot_replacement_not_event_history");
  });

  test("unchanged means fresh covered ledger state, even as wall time changes", () => {
    const { source } = fixture();
    const first = read(source);
    const repeat = read({ ...source, generatedAt: new Date(Date.now() + 1000).toISOString() }, first.fingerprint, Date.now() + 1000);
    expect(repeat.status).toBe("unchanged"); expect(repeat.ready).toEqual([]);
    expect(JSON.stringify(repeat).length).toBeLessThan(JSON.stringify(first).length);
    expect(repeat.coverage.provider).toBe("unavailable_in_brief");
    expect(repeat.expansion.omitted.arguments).toEqual({ project: "commander" });
    expect(read(source, first.fingerprint, Date.now() + 61_000).status).toBe("stale");
  });

  test("expired claim becomes attention even with the same stored snapshot", () => {
    const { source } = fixture();
    const first = read(source);
    const later = Date.now() + 901_000;
    const expired = read({ ...source, generatedAt: new Date(later).toISOString() }, first.fingerprint, later);
    expect(expired.status).toBe("current"); expect(expired.active).toHaveLength(5);
    expect(expired.active[0]?.reason).toBe("claim_expired_or_unverified");
  });

  test("superseded candidates disappear and omissions prevent a false unchanged", () => {
    const { source, item } = fixture(); const first = read(source);
    source.ready = source.ready.filter((entry) => entry.id !== item.id);
    source.counts.byStatus.ready--; source.counts.byStatus.archived++;
    const next = read(source, first.fingerprint);
    expect(next.status).toBe("current"); expect(next.ready).toEqual([]);
    const small = read(source, undefined, Date.now(), 1);
    source.counts.byStatus.ready += 100;
    const incomplete = read(source, small.fingerprint, Date.now(), 1);
    expect(incomplete.omitted?.sourceTruncated).toBe(true); expect(incomplete.status).not.toBe("unchanged");
  });

  test("truncated prose is explicit and retains the exact expansion identity", () => {
    const { source, item } = fixture(); source.ready.find((row) => row.id === item.id)!.summary = "x".repeat(1000);
    const row = read(source).ready[0]!;
    expect(row.truncated).toBe(true); expect(row.summary).toHaveLength(240); expect(row.id).toBe(item.id);
    const first = read(source);
    source.ready.find((entry) => entry.id === item.id)!.summary = "x".repeat(999) + "y";
    expect(read(source, first.fingerprint).status).toBe("current");
    expect(renderCommanderBrief(first)).toContain("text truncated");
  });

  test("historical results cannot crowd out the next useful candidate", () => {
    const { source, item } = fixture();
    const candidate = source.ready.find((row) => row.id === item.id)!;
    source.recentlyCompleted = Array.from({ length: 100 }, (_, i) => ({ ...candidate, id: `old-${i}`, status: "done" as const }));
    source.counts.byStatus.done = 100;
    const first = read(source);
    expect(first.ready[0]?.id).toBe(item.id);
    expect(first.recentlyCompleted).toHaveLength(2);
    expect(first.omitted?.completed).toBe(98);
    expect(read(source, first.fingerprint).status).toBe("unchanged");
  });

  test("unevaluated hosted run or capacity observations cannot yield unchanged", () => {
    const { source } = fixture();
    const hosted = { ...source, activeRuns: [{ id: "run-1", itemId: source.active[0]!.id, status: "waiting" }] };
    const first = read(hosted);
    expect(first.omitted?.runs).toBe(1);
    expect(read(hosted, first.fingerprint).status).toBe("current");
    expect(read({ ...hosted, activeRuns: [], activeReservations: [{ expiresAt: new Date().toISOString() }] }, first.fingerprint).status).toBe("current");
  });

  test("public MCP repeats reevaluate the ledger and return errors when it becomes unavailable", async () => {
    const { store } = commanderScenario("overview");
    const ledger = new SqliteWorkLedger(store); let reads = 0; let unavailable = false;
    const original = ledger.getBrief.bind(ledger);
    ledger.getBrief = async (project, limit) => { reads++; if (unavailable) throw new Error("Ledger unavailable"); return original(project, limit); };
    const server = createChatGptMcpServer(ledger);
    const client = new Client({ name: "commander-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      const first = await client.callTool({ name: "get_brief", arguments: { project: "commander" } });
      const data = (first.structuredContent as { data: ReturnType<typeof read> }).data;
      const expanded = await client.callTool({ name: "get_runner_context", arguments: { id: data.ready[0]!.id } });
      expect(expanded.isError).not.toBe(true);
      expect((expanded.structuredContent as { data: { item: { id: string } } }).data.item.id).toBe(data.ready[0]!.id);
      const args = { project: "commander", previousFingerprint: data.fingerprint };
      const second = await client.callTool({ name: "get_brief", arguments: args });
      expect((second.structuredContent as { data: ReturnType<typeof read> }).data.status).toBe("unchanged");
      expect(reads).toBe(2);
      unavailable = true;
      expect((await client.callTool({ name: "get_brief", arguments: args })).isError).toBe(true);
      expect(reads).toBe(3);
    } finally { await client.close(); await server.close(); store.close(); }
  });

  test("a prior fingerprint never bypasses a changed token scope or a different project", async () => {
    const { store } = commanderScenario("overview");
    try {
      const token = createApiToken(store, { name: "commander reader", scopes: ["read"], projects: ["commander"] });
      const app = createServerApp(store);
      const response = await mcpRequest(app, token.token, toolCall(1, "get_brief", { project: "commander" }));
      const first = await response.json() as any;
      const fingerprint = first.result.structuredContent.data.fingerprint;
      const denied = await mcpRequest(app, token.token, toolCall(2, "get_brief", { project: "elsewhere", previousFingerprint: fingerprint }));
      expect(JSON.stringify(await denied.json())).not.toContain('"status":"unchanged"');
      store.db.query("UPDATE api_tokens SET projects_json = ?1 WHERE id = ?2").run('["elsewhere"]', token.id);
      const narrowed = await mcpRequest(app, token.token, toolCall(3, "get_brief", { project: "commander", previousFingerprint: fingerprint }));
      const narrowedBody = JSON.stringify(await narrowed.json());
      expect(narrowedBody).not.toContain('"status":"unchanged"');
      expect(narrowedBody).not.toContain("Choose the acceptance target");
      expect(narrowedBody).toContain("error");
      expect(() => read({ ...fixture().source, project: "elsewhere" }, fingerprint)).toThrow("scope");
    } finally { store.close(); }
  });
});
