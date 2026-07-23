import { describe, expect, test } from "bun:test";
import { attachArtifact } from "../src/artifacts.ts";
import { createApiToken } from "../src/auth.ts";
import { exportSqliteSnapshot, parseSnapshot } from "../src/snapshot.ts";
import { StensiblyStore } from "../src/store.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

describe("SQLite snapshots", () => {
  test("exports coordination state and token hashes without raw secrets", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = store.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Carry this into Convex",
        summary: "A small useful history.",
        nextAction: "Export it.",
        priority: 72,
        actor: leo,
      }, "snapshot-create");
      store.claimItem(item.id, agent, 900, "snapshot-claim");
      store.recordEvent({
        itemId: item.id,
        actor: agent,
        type: "progress.recorded",
        payload: { summary: "Snapshot is being assembled." },
      });
      const artifact = attachArtifact(store, {
        itemId: item.id,
        actor: agent,
        kind: "commit",
        label: "Snapshot commit",
        uri: "git:repo@snapshot",
        metadata: { sha: "snapshot" },
      });
      const token = createApiToken(store, {
        name: "Snapshot reader",
        scopes: ["read"],
        projects: ["scrapbook"],
      });

      const snapshot = exportSqliteSnapshot(store);
      expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
      expect(snapshot).toMatchObject({ version: 1 });
      expect(snapshot.projects).toEqual([
        expect.objectContaining({ id: "scrapbook" }),
      ]);
      expect(snapshot.actors.map((entry) => entry.id).sort()).toEqual(["agent", "leo"]);
      expect(snapshot.items).toEqual([
        expect.objectContaining({
          id: item.id,
          status: "active",
          claimedBy: "agent",
          priority: 72,
        }),
      ]);
      expect(snapshot.events.map((entry) => entry.type)).toEqual(expect.arrayContaining([
        "item.created",
        "claim.created",
        "progress.recorded",
        "artifact.attached",
      ]));
      expect(snapshot.artifacts).toEqual([
        expect.objectContaining({ id: artifact.id, uri: "git:repo@snapshot" }),
      ]);
      expect(snapshot.tokens).toEqual([
        expect.objectContaining({
          id: token.id,
          name: "Snapshot reader",
          scopes: ["read"],
          projects: ["scrapbook"],
        }),
      ]);
      expect(snapshot.tokens[0]?.secretHash).toMatch(/^[a-f0-9]{64}$/);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(token.token);
      expect(serialized).not.toContain(token.token.split(".").at(-1) ?? "impossible");
    } finally {
      store.close();
    }
  });
});
