import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StensiblyStore } from "../src/store.ts";

const legacyAgent = {
  id: "legacy-agent",
  name: "Legacy Agent",
  kind: "agent" as const,
};

describe("SQLite store migrations", () => {
  test("adds claim generation to an existing database without losing claim state", () => {
    const directory = mkdtempSync(join(tmpdir(), "stensibly-store-migration-"));
    const path = join(directory, "legacy.sqlite");

    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE actors (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('task', 'finding', 'question', 'decision', 'tip', 'handoff', 'note')),
          title TEXT NOT NULL,
          summary TEXT,
          status TEXT NOT NULL CHECK (status IN ('ready', 'active', 'blocked', 'done', 'archived')),
          priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
          next_action TEXT,
          claimed_by TEXT REFERENCES actors(id),
          claim_expires_at TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          actor_id TEXT REFERENCES actors(id),
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT UNIQUE,
          created_at TEXT NOT NULL
        );

        INSERT INTO projects (id, name, created_at)
        VALUES ('scrapbook', 'scrapbook', '2026-01-01T00:00:00.000Z');
        INSERT INTO actors (id, name, kind, updated_at)
        VALUES ('legacy-agent', 'Legacy Agent', 'agent', '2026-01-01T00:00:00.000Z');
        INSERT INTO items (
          id, project_id, kind, title, status, priority, claimed_by,
          claim_expires_at, version, created_at, updated_at
        ) VALUES (
          'legacy-item', 'scrapbook', 'task', 'Resume legacy work', 'active', 50,
          'legacy-agent', '2099-01-01T00:00:00.000Z', 4,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO items (
          id, project_id, kind, title, status, priority,
          version, created_at, updated_at
        ) VALUES (
          'legacy-ready', 'scrapbook', 'task', 'Unclaimed legacy work', 'ready', 50,
          1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);
      legacy.close();

      const store = new StensiblyStore(path);
      try {
        const migrated = store.getItem("legacy-item");
        expect(migrated).toMatchObject({
          status: "active",
          claimedBy: legacyAgent.id,
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
          claimGeneration: 1,
          version: 4,
        });
        expect(store.getItem("legacy-ready").claimGeneration).toBe(0);

        const columns = store.db
          .query<{ name: string }, []>("PRAGMA table_info(items)")
          .all();
        expect(columns.map((column) => column.name)).toContain("claim_generation");

        const released = store.releaseItem(
          "legacy-item",
          legacyAgent,
          migrated.claimGeneration,
        );
        expect(released.claimGeneration).toBe(2);
        const reclaimed = store.claimItem("legacy-item", legacyAgent, 900);
        expect(reclaimed.claimGeneration).toBe(3);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
