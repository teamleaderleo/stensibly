from __future__ import annotations

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement anchor, found {count}")
    target.write_text(text.replace(old, new, 1))


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


write(
    "src/sqlite-idempotency-scope.ts",
    '''import { ConflictError, type StensiblyStore } from "./store.js";

interface IdempotencyEventRow {
  event_id: string;
  item_id: string;
  actor_id: string | null;
  type: string;
  payload_json: string;
  project_id: string;
}

export interface SqliteIdempotencyExpectation {
  project: string;
  operation: string;
  itemId?: string;
  actorId?: string | null;
  payload?: unknown;
  payloadSubset?: Record<string, unknown>;
}

export function requireMatchingSqliteIdempotency(
  store: StensiblyStore,
  key: string | undefined,
  expected: SqliteIdempotencyExpectation,
): IdempotencyEventRow | null {
  if (!key) return null;
  const row = store.db.query<IdempotencyEventRow, [string]>(`
    SELECT
      events.id AS event_id,
      events.item_id,
      events.actor_id,
      events.type,
      events.payload_json,
      items.project_id
    FROM events
    INNER JOIN items ON items.id = events.item_id
    WHERE events.idempotency_key = ?1
    LIMIT 1
  `).get(key);
  if (!row) return null;

  const payload = parsePayload(row.payload_json);
  const mismatch = row.project_id !== expected.project
    || row.type !== expected.operation
    || (expected.itemId !== undefined && row.item_id !== expected.itemId)
    || (Object.hasOwn(expected, "actorId") && row.actor_id !== expected.actorId)
    || (Object.hasOwn(expected, "payload") && stableJson(payload) !== stableJson(expected.payload))
    || (expected.payloadSubset !== undefined && !containsSubset(payload, expected.payloadSubset));
  if (mismatch) {
    throw new ConflictError("Idempotency key was already used for a different operation");
  }
  return row;
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function containsSubset(value: unknown, subset: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(subset).every(([key, expected]) =>
    Object.hasOwn(value, key) && stableJson(value[key]) === stableJson(expected)
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    'import { StensiblyStore } from "./store.js";\n',
    'import { requireMatchingSqliteIdempotency } from "./sqlite-idempotency-scope.js";\nimport { StensiblyStore } from "./store.js";\n',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async attachArtifact(input: AttachWorkArtifactInput) {
    const replay = hasRecordedIdempotencyKey(this.store, input.idempotencyKey);
''',
    '''  async attachArtifact(input: AttachWorkArtifactInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "artifact.attached",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: {
        kind: input.kind,
        label: input.label,
        uri: input.uri,
      },
    });
    const replay = hasRecordedIdempotencyKey(this.store, input.idempotencyKey);
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async createItem(input: CreateWorkInput) {
    const { idempotencyKey, ...item } = input;
    return this.store.createItem(item, idempotencyKey);
  }
''',
    '''  async createItem(input: CreateWorkInput) {
    const { idempotencyKey, ...item } = input;
    requireMatchingSqliteIdempotency(this.store, idempotencyKey, {
      project: item.project,
      operation: "item.created",
      payloadSubset: {
        project: item.project,
        kind: item.kind,
        title: item.title,
      },
    });
    return this.store.createItem(item, idempotencyKey);
  }
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async claimWork(input: ClaimWorkInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
''',
    '''  async claimWork(input: ClaimWorkInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "claim.created",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: { leaseSeconds: input.leaseSeconds },
    });
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async renewClaim(input: RenewClaimInput) {
    return renewClaim(
''',
    '''  async renewClaim(input: RenewClaimInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "claim.renewed",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: {
        leaseSeconds: input.leaseSeconds,
        generation: input.expectedClaimGeneration,
      },
    });
    return renewClaim(
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async handoffWork(input: HandoffWorkInput) {
    return handoffWork(this.store, input);
  }

  async blockWork(input: BlockWorkInput) {
    return blockWork(this.store, input);
  }

  async unblockWork(input: UnblockWorkInput) {
    return unblockWork(this.store, input);
  }
''',
    '''  async handoffWork(input: HandoffWorkInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "work.handed_off",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return handoffWork(this.store, input);
  }

  async blockWork(input: BlockWorkInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "work.blocked",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return blockWork(this.store, input);
  }

  async unblockWork(input: UnblockWorkInput) {
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "work.unblocked",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return unblockWork(this.store, input);
  }
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async releaseWork(input: ClaimActionInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
''',
    '''  async releaseWork(input: ClaimActionInput) {
    reconcileStaleRunItems(this.store);
    expireClaims(this.store);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "claim.released",
      itemId: input.id,
      actorId: input.actor.id,
      payloadSubset: { generation: input.expectedClaimGeneration },
    });
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async recordEvent(input: RecordWorkEventInput) {
    assertPublicRecordableItemEventType(input.type);
    const replay = hasRecordedIdempotencyKey(this.store, input.idempotencyKey);
''',
    '''  async recordEvent(input: RecordWorkEventInput) {
    assertPublicRecordableItemEventType(input.type);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: input.type,
      itemId: input.id,
      actorId: input.actor?.id ?? null,
      payload: input.payload,
    });
    const replay = hasRecordedIdempotencyKey(this.store, input.idempotencyKey);
''',
)

replace_once(
    "src/sqlite-ledger.ts",
    '''  async completeWork(input: CompleteWorkInput) {
    reconcileStaleRunItems(this.store);
    return completeFencedWork(this.store, input);
  }
''',
    '''  async completeWork(input: CompleteWorkInput) {
    reconcileStaleRunItems(this.store);
    const item = this.store.getItem(input.id);
    requireMatchingSqliteIdempotency(this.store, input.idempotencyKey, {
      project: item.project,
      operation: "item.completed",
      itemId: input.id,
      actorId: input.actor.id,
    });
    return completeFencedWork(this.store, input);
  }
''',
)

replace_once(
    "convex/lib/domain.ts",
    '''export async function requireMatchingIdempotency(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  key: string | undefined,
  expectedType: string,
) {
  const existing = await findIdempotentEvent(ctx, workspaceId, key);
  if (!existing) return null;
  if (existing.type !== expectedType) {
    throw new Error("Idempotency key already belongs to another operation");
  }
  return existing;
}
''',
    '''export async function requireMatchingIdempotency(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  key: string | undefined,
  expectedType: string,
) {
  const existing = await findIdempotentEvent(ctx, workspaceId, key);
  if (!existing) return null;
  if (existing.type !== expectedType) {
    throw new Error("Idempotency key already belongs to another operation");
  }
  return existing;
}

export async function requireSameIdempotentItem(
  ctx: QueryContext,
  event: any,
  expected: {
    projectSlug?: string;
    itemExternalId?: string;
    actorExternalId?: string | null;
    payload?: unknown;
    payloadSubset?: Record<string, unknown>;
  },
) {
  const item = await ctx.db.get("items", event.itemId);
  if (!item) throw new Error("Idempotent item no longer exists");
  const project = await ctx.db.get("projects", item.projectId);
  const mismatch = !project
    || (expected.projectSlug !== undefined && project.slug !== expected.projectSlug)
    || (expected.itemExternalId !== undefined && item.externalId !== expected.itemExternalId)
    || (Object.hasOwn(expected, "actorExternalId")
      && (event.actorExternalId ?? null) !== expected.actorExternalId)
    || (Object.hasOwn(expected, "payload")
      && stableJson(event.payload) !== stableJson(expected.payload))
    || (expected.payloadSubset !== undefined
      && !containsRecordSubset(event.payload, expected.payloadSubset));
  if (mismatch) {
    throw new Error("Idempotency key already belongs to another operation");
  }
  return item;
}

function containsRecordSubset(value: unknown, subset: Record<string, unknown>): boolean {
  if (!isPlainRecord(value)) return false;
  return Object.entries(subset).every(([key, expected]) =>
    Object.hasOwn(value, key) && stableJson(value[key]) === stableJson(expected)
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
''',
)

replace_once(
    "convex/items.ts",
    '''  requireMatchingIdempotency,
  requireServiceSecret,
''',
    '''  requireMatchingIdempotency,
  requireSameIdempotentItem,
  requireServiceSecret,
''',
)
replace_once(
    "convex/items.ts",
    '''    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "item.created",
    );
    if (existing) {
      const item = await ctx.db.get("items", existing.itemId);
      if (!item) throw new Error("Idempotent item no longer exists");
      return await publicItem(ctx, item);
    }

    const projectSlug = assertSlug(args.project, "Project");
''',
    '''    const projectSlug = assertSlug(args.project, "Project");
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "item.created",
    );
    if (existing) {
      const item = await requireSameIdempotentItem(ctx, existing, {
        projectSlug,
        actorExternalId: args.actor?.id ?? null,
        payloadSubset: {
          project: projectSlug,
          kind: args.kind,
          title: args.title.trim(),
        },
      });
      return await publicItem(ctx, item);
    }

''',
)

replace_once(
    "convex/claims.ts",
    '''  requireMatchingIdempotency,
  requireServiceSecret,
''',
    '''  requireMatchingIdempotency,
  requireSameIdempotentItem,
  requireServiceSecret,
''',
)
for event_type, marker, payload in [
    ("claim.created", "acquire", '''        itemExternalId: args.id,
        actorExternalId: args.actor.id,
        payloadSubset: { leaseSeconds: args.leaseSeconds },'''),
    ("claim.renewed", "renew", '''        itemExternalId: args.id,
        actorExternalId: args.actor.id,
        payloadSubset: {
          leaseSeconds: args.leaseSeconds,
          generation: args.expectedClaimGeneration,
        },'''),
    ("claim.released", "release", '''        itemExternalId: args.id,
        actorExternalId: args.actor.id,
        payloadSubset: { generation: args.expectedClaimGeneration },'''),
]:
    old = f'''    if (existing) {{
      const item = await ctx.db.get("items", existing.itemId);
      if (!item) throw new Error("Idempotent item no longer exists");
      return await publicItem(ctx, item);
    }}
'''
    new = f'''    if (existing) {{
      const item = await requireSameIdempotentItem(ctx, existing, {{
{payload}
      }});
      return await publicItem(ctx, item);
    }}
'''
    # The same anchor occurs three times. Replace sequentially in source order.
    replace_once("convex/claims.ts", old, new)

replace_once(
    "convex/events.ts",
    '''  requireMatchingIdempotency,
  requireServiceSecret,
''',
    '''  requireMatchingIdempotency,
  requireSameIdempotentItem,
  requireServiceSecret,
''',
)
replace_once(
    "convex/events.ts",
    '''    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      type,
    );
    if (existing) return { ...publicEvent(existing), itemId: args.id };

    const item = await getItemByExternalId(ctx, workspace._id, args.id);
''',
    '''    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      type,
    );
    if (existing) {
      const item = await requireSameIdempotentItem(ctx, existing, {
        itemExternalId: args.id,
        actorExternalId: args.actor?.id ?? null,
        payload: args.payload,
      });
      return { ...publicEvent(existing), itemId: item.externalId };
    }

    const item = await getItemByExternalId(ctx, workspace._id, args.id);
''',
)

replace_once(
    "convex/artifacts.ts",
    '''  requireMatchingIdempotency,
  requireServiceSecret,
''',
    '''  requireMatchingIdempotency,
  requireSameIdempotentItem,
  requireServiceSecret,
''',
)
replace_once(
    "convex/artifacts.ts",
    '''    if (existing) {
      const artifactExternalId = (existing.payload as { artifactId?: unknown }).artifactId;
''',
    '''    if (existing) {
      const item = await requireSameIdempotentItem(ctx, existing, {
        itemExternalId: args.id,
        actorExternalId: args.actor.id,
        payloadSubset: {
          kind: args.kind,
          label: args.label.trim(),
          uri: args.uri.trim(),
        },
      });
      const artifactExternalId = (existing.payload as { artifactId?: unknown }).artifactId;
''',
)
replace_once(
    "convex/artifacts.ts",
    '''      if (!artifact) throw new Error("Idempotent artifact no longer exists");
      return { ...publicArtifact(artifact), itemId: args.id };
''',
    '''      if (!artifact || artifact.itemId !== item._id) {
        throw new Error("Idempotent artifact no longer exists");
      }
      return { ...publicArtifact(artifact), itemId: item.externalId };
''',
)

write(
    "test/idempotency-scope.test.ts",
    '''import { describe, expect, test } from "bun:test";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "scope-agent", name: "Scope Agent", kind: "agent" as const };

describe("SQLite idempotency scope", () => {
  test("rejects a create replay across projects without exposing the foreign item", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const alpha = await ledger.createItem({
        project: "alpha",
        kind: "task",
        title: "Alpha item",
        priority: 50,
        actor,
        idempotencyKey: "shared-create-key",
      });
      await expect(ledger.createItem({
        project: "beta",
        kind: "task",
        title: "Beta item",
        priority: 50,
        actor,
        idempotencyKey: "shared-create-key",
      })).rejects.toThrow("different operation");
      expect((await ledger.getOperationReceipt({
        project: "beta",
        idempotencyKey: "shared-create-key",
      })).status).toBe("unknown");
      expect(store.listItems({ project: "beta" })).toEqual([]);
      expect(store.getItem(alpha.id).project).toBe("alpha");
    } finally {
      store.close();
    }
  });

  test("rejects cross-item event, claim, and artifact replay", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const alpha = await ledger.createItem({
        project: "alpha", kind: "task", title: "Alpha", priority: 50, actor,
        idempotencyKey: "alpha-create",
      });
      const beta = await ledger.createItem({
        project: "beta", kind: "task", title: "Beta", priority: 50, actor,
        idempotencyKey: "beta-create",
      });
      await ledger.recordEvent({
        id: alpha.id, actor, type: "progress.scope", payload: { step: 1 },
        idempotencyKey: "event-scope-key",
      });
      await expect(ledger.recordEvent({
        id: beta.id, actor, type: "progress.scope", payload: { step: 1 },
        idempotencyKey: "event-scope-key",
      })).rejects.toThrow("different operation");

      await ledger.claimWork({
        id: alpha.id, actor, leaseSeconds: 300, idempotencyKey: "claim-scope-key",
      });
      await expect(ledger.claimWork({
        id: beta.id, actor, leaseSeconds: 300, idempotencyKey: "claim-scope-key",
      })).rejects.toThrow("different operation");

      await ledger.attachArtifact({
        id: alpha.id, actor, kind: "commit", label: "Alpha commit",
        uri: "git:alpha", metadata: {}, idempotencyKey: "artifact-scope-key",
      });
      await expect(ledger.attachArtifact({
        id: beta.id, actor, kind: "commit", label: "Alpha commit",
        uri: "git:alpha", metadata: {}, idempotencyKey: "artifact-scope-key",
      })).rejects.toThrow("different operation");
    } finally {
      store.close();
    }
  });
});
''',
)

write(
    "convex/idempotencyScope.test.ts",
    '''import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "scope-test";
const actor = { id: "scope-agent", name: "Scope Agent", kind: "agent" as const };

beforeEach(() => vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret));

describe("hosted idempotency scope", () => {
  test("rejects create replay across projects", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "alpha", kind: "task",
      title: "Alpha item", priority: 50, actor, idempotencyKey: "shared-create-key",
    });
    await expect(t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "beta", kind: "task",
      title: "Beta item", priority: 50, actor, idempotencyKey: "shared-create-key",
    })).rejects.toThrow("another operation");
  });

  test("rejects cross-item event, claim, and artifact replay", async () => {
    const t = convexTest(schema, modules);
    const alpha = await t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "alpha", kind: "task",
      title: "Alpha", priority: 50, actor, idempotencyKey: "alpha-create",
    }) as any;
    const beta = await t.mutation(convexApi.items.create, {
      serviceSecret: secret, workspace, project: "beta", kind: "task",
      title: "Beta", priority: 50, actor, idempotencyKey: "beta-create",
    }) as any;

    await t.mutation(convexApi.events.record, {
      serviceSecret: secret, workspace, id: alpha.id, actor,
      type: "progress.scope", payload: { step: 1 }, idempotencyKey: "event-scope-key",
    });
    await expect(t.mutation(convexApi.events.record, {
      serviceSecret: secret, workspace, id: beta.id, actor,
      type: "progress.scope", payload: { step: 1 }, idempotencyKey: "event-scope-key",
    })).rejects.toThrow("another operation");

    await t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret, workspace, id: alpha.id, actor,
      leaseSeconds: 300, idempotencyKey: "claim-scope-key",
    });
    await expect(t.mutation(convexApi.claims.acquire, {
      serviceSecret: secret, workspace, id: beta.id, actor,
      leaseSeconds: 300, idempotencyKey: "claim-scope-key",
    })).rejects.toThrow("another operation");

    await t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret, workspace, id: alpha.id, actor, kind: "commit",
      label: "Alpha commit", uri: "git:alpha", metadata: {},
      idempotencyKey: "artifact-scope-key",
    });
    await expect(t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret, workspace, id: beta.id, actor, kind: "commit",
      label: "Alpha commit", uri: "git:alpha", metadata: {},
      idempotencyKey: "artifact-scope-key",
    })).rejects.toThrow("another operation");
  });
});
''',
)

print("idempotency scope repair applied")
