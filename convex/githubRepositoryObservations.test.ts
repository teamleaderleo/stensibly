import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "../src/idempotency-request-fingerprint";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-repository-observation-service-secret";
const ingestRef = makeFunctionReference<"mutation">(
  "githubRepositoryObservations:ingest",
);
const listRecentRef = makeFunctionReference<"query">(
  "githubRepositoryObservations:listRecent",
);

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted GitHub repository observations", () => {
  test("appends one canonical observation and replays one delivery exactly", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = input();
    const inserted = await t.mutation(ingestRef, first) as any;
    expect(inserted).toMatchObject({
      duplicate: false,
      record: {
        observationId: "github:issues:delivery-1",
        deliveryId: "delivery-1",
        repository: "teamleaderleo/stensibly",
        subjectKind: "issue",
        subjectExternalId: "github:teamleaderleo/stensibly#issue/591",
      },
    });
    expect(await t.mutation(ingestRef, first)).toMatchObject({
      duplicate: true,
      record: { id: inserted.record.id },
    });

    const recent = await t.query(listRecentRef, queryArgs()) as any[];
    expect(recent).toHaveLength(1);
    expect(recent[0].observationJson).not.toContain("secret issue body");
    expect(recent[0].observationJson).not.toContain('"payload":');
    expect(recent[0].observationJson).toContain('"payloadDigest":');
  });

  test("rejects changed content under one delivery identity", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await t.mutation(ingestRef, input());
    await expect(t.mutation(ingestRef, input({
      payloadDigest: `sha256:${"b".repeat(64)}`,
    }))).rejects.toThrow("GITHUB_REPOSITORY_DELIVERY_CONFLICT");
  });

  test("orders bounded repository reads by receipt time", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await t.mutation(ingestRef, input());
    await t.mutation(ingestRef, input({
      deliveryId: "delivery-2",
      payloadDigest: `sha256:${"c".repeat(64)}`,
      sourceTime: "2026-07-31T15:01:00.000Z",
      receivedAt: "2026-07-31T15:01:01.000Z",
      issueNumber: 592,
    }));
    const recent = await t.query(listRecentRef, queryArgs({ limit: 1 })) as any[];
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      deliveryId: "delivery-2",
      subjectExternalId: "github:teamleaderleo/stensibly#issue/592",
    });
  });

  test("recomputes semantic identity before durable acceptance", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const forged = input();
    const decoded = JSON.parse(forged.observationJson);
    decoded.semanticFingerprint = `sha256:${"0".repeat(64)}`;
    await expect(t.mutation(ingestRef, {
      ...forged,
      observationJson: canonicalJsonString(decoded),
    })).rejects.toThrow("semantic fingerprint is invalid");
  });

  test("rejects raw prose hidden in a newly fingerprinted fact", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const forged = input();
    const decoded = JSON.parse(forged.observationJson);
    decoded.facts.rawBody = "secret issue body";
    const {
      observationId: _observationId,
      deliveryId: _deliveryId,
      payloadDigest: _payloadDigest,
      semanticFingerprint: _semanticFingerprint,
      receivedAt: _receivedAt,
      ...canonicalSemantics
    } = decoded;
    decoded.semanticFingerprint = fingerprintCanonicalRequest(canonicalSemantics);

    await expect(t.mutation(ingestRef, {
      ...forged,
      observationJson: canonicalJsonString(decoded),
    })).rejects.toThrow("GitHub issue facts has noncanonical fields");
  });

  test("requires the service boundary", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    await expect(t.mutation(ingestRef, {
      ...input(),
      serviceSecret: "wrong",
    })).rejects.toThrow("Unauthorized");
  });
});

function input(overrides: {
  deliveryId?: string;
  payloadDigest?: string;
  sourceTime?: string;
  receivedAt?: string;
  issueNumber?: number;
} = {}) {
  const deliveryId = overrides.deliveryId ?? "delivery-1";
  const payloadDigest = overrides.payloadDigest ?? `sha256:${"a".repeat(64)}`;
  const sourceTime = overrides.sourceTime ?? "2026-07-31T15:00:00.000Z";
  const receivedAt = overrides.receivedAt ?? "2026-07-31T15:00:01.000Z";
  const issueNumber = overrides.issueNumber ?? 591;
  const canonicalSemantics = {
    version: 1 as const,
    provider: "github" as const,
    sourceSchema: "github-webhook" as const,
    sourceSchemaVersion: "2022-11-28" as const,
    eventType: "issues" as const,
    action: "edited",
    repository: "teamleaderleo/stensibly",
    actor: "teamleaderleo",
    subject: {
      kind: "issue" as const,
      externalId: `github:teamleaderleo/stensibly#issue/${issueNumber}`,
    },
    relationships: {
      repository: "teamleaderleo/stensibly",
      revision: null,
      previousRevision: null,
      baseRevision: null,
      mergeRevision: null,
      ref: null,
      refType: null,
      pullRequestNumber: null,
      issueNumber,
      commentId: null,
    },
    facts: {
      locked: false,
      state: "open",
      stateReason: null,
    },
    contentRevisions: [{
      name: "body" as const,
      present: true,
      byteLength: 17,
      sha256: `sha256:${"d".repeat(64)}`,
    }, {
      name: "title" as const,
      present: true,
      byteLength: 21,
      sha256: `sha256:${"e".repeat(64)}`,
    }],
    sourceTime,
    sourceTimeSource: "provider" as const,
    containsRawContent: false as const,
  };
  const observation = {
    ...canonicalSemantics,
    observationId: `github:issues:${deliveryId}`,
    deliveryId,
    payloadDigest,
    semanticFingerprint: fingerprintCanonicalRequest(canonicalSemantics),
    receivedAt,
  };
  return {
    serviceSecret,
    workspace: "test",
    deliveryId,
    eventType: "issues",
    payloadDigest,
    receivedAt: Date.parse(receivedAt),
    observationJson: canonicalJsonString(observation),
  };
}

function queryArgs(overrides: Record<string, unknown> = {}) {
  return {
    serviceSecret,
    workspace: "test",
    repository: "teamleaderleo/stensibly",
    limit: 50,
    ...overrides,
  };
}

async function seedWorkspace(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: "test",
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
