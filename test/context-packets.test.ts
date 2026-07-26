import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachArtifact } from "../src/artifacts.ts";
import {
  buildRunnerContextPacket,
  getRunnerContextPacket,
} from "../src/context-packets.ts";
import { buildItemControlView } from "../src/item-control.ts";
import { createWorkRun } from "../src/runs.ts";
import { createApiToken } from "../src/auth.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const runner = { id: "runner", name: "Runner", kind: "agent" as const };
const generatedAt = new Date("2026-07-25T12:00:00.000Z");

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => store.close());

describe("runner context packets", () => {
  test("preserves protected context, redacts credentials, and enforces tight bounds", async () => {
    const item = store.createItem({
      project: "studio",
      kind: "task",
      title: "Ship the runner handoff",
      summary: `Use Bearer very-secret-token and ${"context ".repeat(900)}`,
      nextAction: "Resolve the product decision before launch.",
      priority: 80,
      actor: leo,
    });
    const decision = store.recordEvent({
      itemId: item.id,
      actor: leo,
      type: "decision.requested",
      payload: {
        question: "Which launch profile should the runner use?",
        apiKey: "sk-proj-this-must-not-leak",
      },
    });
    for (let index = 0; index < 5; index += 1) {
      store.recordEvent({
        itemId: item.id,
        actor: runner,
        type: "progress.recorded",
        payload: { index, note: "ordinary progress" },
      });
    }
    attachArtifact(store, {
      itemId: item.id,
      actor: runner,
      kind: "url",
      label: "Protected preview",
      uri: "https://user:password@example.test/preview",
      metadata: { token: "ghp_this_must_not_leak" },
    });
    createWorkRun(store, {
      itemId: item.id,
      actor: runner,
      runnerType: "generic-mcp",
      runnerProfile: "default",
    }, generatedAt);

    const ledger = new SqliteWorkLedger(store);
    const packet = await getRunnerContextPacket(ledger, item.id, {
      maxEvents: 2,
      maxCharacters: 5_000,
      now: generatedAt,
    });

    expect(packet.generatedAt).toBe(generatedAt.toISOString());
    expect(packet.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: decision.id, protected: true }),
    ]));
    expect(packet.events.filter((event) => !event.protected)).toHaveLength(1);
    expect(packet.runs).toEqual([
      expect.objectContaining({ runnerType: "generic-mcp", runnerProfile: "default" }),
    ]);
    expect(JSON.stringify(packet)).not.toContain("very-secret-token");
    expect(JSON.stringify(packet)).not.toContain("sk-proj-this-must-not-leak");
    expect(JSON.stringify(packet)).not.toContain("ghp_this_must_not_leak");
    expect(packet.artifacts[0]?.uri).toContain("[REDACTED]");
    expect(packet.sourceReferences).toContain(`event:${decision.id}`);
    expect(packet.characterCount).toBeLessThanOrEqual(5_000);
    expect(JSON.stringify(packet).length).toBe(packet.characterCount);

    const tightPacket = await getRunnerContextPacket(ledger, item.id, {
      maxEvents: 2,
      maxCharacters: 2_000,
      now: generatedAt,
    });
    expect(tightPacket.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: decision.id, protected: true }),
    ]));
    expect(tightPacket.characterCount).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(tightPacket).length).toBe(tightPacket.characterCount);
    expect(Object.values(tightPacket.omitted).some((count) => count > 0)).toBe(true);
  });

  test("builds deterministic packets from the same canonical detail", () => {
    const item = store.createItem({
      project: "studio",
      kind: "handoff",
      title: "Continue from canonical state",
      summary: "The durable state is authoritative.",
      nextAction: "Read the packet and continue.",
      priority: 50,
      actor: leo,
    });
    const sourceDetail = {
      item,
      events: store.listEvents(item.id),
      artifacts: [],
      runs: [],
      dependencies: [{
        direction: "outgoing",
        kind: "blocks",
        itemId: "item_dependency",
        createdAt: "2026-07-25T10:00:00.000Z",
      }],
    };
    const detail = {
      ...sourceDetail,
      control: buildItemControlView(sourceDetail, { now: generatedAt }),
    };

    const first = buildRunnerContextPacket(detail, { now: generatedAt });
    const second = buildRunnerContextPacket(detail, { now: generatedAt });
    expect(second).toEqual(first);
    expect(first.sourceReferences).toContain("dependency:item_dependency");
  });

  test("serves scoped packets over REST and validates limits", async () => {
    const visible = store.createItem({
      project: "studio",
      kind: "task",
      title: "Visible context",
      priority: 50,
      actor: leo,
    });
    const hidden = store.createItem({
      project: "secret",
      kind: "task",
      title: "Hidden context",
      priority: 50,
      actor: leo,
    });
    const token = createApiToken(store, {
      name: "Studio reader",
      scopes: ["read"],
      projects: ["studio"],
    });
    const app = createServerApp(store, { httpAuth: { required: true } });

    const visibleResponse = await app.request(
      `/api/v1/items/${visible.id}/context?maxEvents=5&maxCharacters=3000`,
      { headers: bearer(token.token) },
    );
    expect(visibleResponse.status).toBe(200);
    const visibleBody = await visibleResponse.json() as { packet: { item: { id: string } } };
    expect(visibleBody.packet.item.id).toBe(visible.id);

    const denied = await app.request(`/api/v1/items/${hidden.id}/context`, {
      headers: bearer(token.token),
    });
    expect(denied.status).toBe(403);

    const invalid = await app.request(`/api/v1/items/${visible.id}/context?maxCharacters=100`, {
      headers: bearer(token.token),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
  });
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
