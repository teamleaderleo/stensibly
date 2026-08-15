import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { canonicalJsonString, fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "mail-semantic-service-secret";
const admitRef = makeFunctionReference<"mutation">("mailSemanticAdmission:admit");
const getRef = makeFunctionReference<"query">("mailSemanticAdmission:get");
const listRef = makeFunctionReference<"query">("mailSemanticAdmission:listRecentForThread");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("durable mail semantic admission", () => {
  test("stores one content-minimized admission and replays it exactly", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const evidence = semanticEvidence();
    const request = {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(evidence),
    };
    const first = await t.mutation(admitRef, request) as any;
    const second = await t.mutation(admitRef, request) as any;
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.admissionJson).toBe(first.admissionJson);

    const loaded = await t.query(getRef, {
      ...serviceArgs(),
      provider: "gmail",
      mailboxBindingId: evidence.mailboxBindingId,
      providerMessageId: evidence.providerMessageId,
    }) as string;
    expect(loaded).toBe(canonicalJsonString(evidence));
    expect(loaded).not.toContain("current reply prose");
    expect(loaded).not.toContain("quoted prior prose");
    expect(loaded).toContain('"grantsAuthority":false');
    expect(loaded).toContain('"providerDispatchAuthorized":false');
  });

  test("same provider message with changed content fingerprint conflicts", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = semanticEvidence();
    await t.mutation(admitRef, {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(first),
    });
    const changed = semanticEvidence({
      messageContentFingerprint: `sha256:${"9".repeat(64)}`,
    });
    await expect(t.mutation(admitRef, {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(changed),
    })).rejects.toThrow("MAIL_SEMANTIC_PROVIDER_CONTENT_CONFLICT");
  });

  test("same provider bytes cannot silently move to another canonical thread", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const first = semanticEvidence();
    await t.mutation(admitRef, {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(first),
    });
    const changed = semanticEvidence({
      threadId: "attn_other",
      admissionId: "mail-semantic:other",
    });
    await expect(t.mutation(admitRef, {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(changed),
    })).rejects.toThrow("MAIL_SEMANTIC_ADMISSION_CONFLICT");
  });

  test("forged authority flags fail durable evidence admission", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const forged: any = structuredClone(semanticEvidence());
    forged.grantsAuthority = true;
    const { admissionFingerprint: _old, ...withoutFingerprint } = forged;
    forged.admissionFingerprint = fingerprintCanonicalRequest(withoutFingerprint);
    await expect(t.mutation(admitRef, {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(forged),
    })).rejects.toThrow("grantsAuthority must remain false");
  });

  test("lists bounded semantic admissions by canonical STN thread", async () => {
    const t = convexTest(schema, modules);
    await seedWorkspace(t);
    const evidence = semanticEvidence();
    await t.mutation(admitRef, {
      ...serviceArgs(),
      admissionJson: canonicalJsonString(evidence),
    });
    const rows = await t.query(listRef, {
      ...serviceArgs(),
      threadId: evidence.threadId,
      limit: 10,
    }) as string[];
    expect(rows).toEqual([canonicalJsonString(evidence)]);
  });
});

function semanticEvidence(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = {
    version: 1,
    admissionId: "mail-semantic:abc123",
    sourceObservationId: "mailbox:gmail:history:9101:message:m-reply:label-added:Label_5",
    sourceObservationFingerprint: `sha256:${"1".repeat(64)}`,
    provider: "gmail",
    mailboxBindingId: "gmail_operator_primary",
    providerMessageId: "m-reply",
    providerThreadId: "t-stn",
    threadId: "attn_1521",
    handle: "STN-REVIEW:7K3R",
    project: "stensibly",
    replyClass: "mail.answer",
    semantic: "private_coordination",
    replyId: "stn-mail-reply:abc123",
    replyFingerprint: `sha256:${"2".repeat(64)}`,
    bodySha256: `sha256:${"3".repeat(64)}`,
    bodyByteLength: 42,
    messageContentFingerprint: `sha256:${"4".repeat(64)}`,
    quotedAncestrySha256: `sha256:${"5".repeat(64)}`,
    quotedAncestryByteLength: 128,
    visibleFromSha256: `sha256:${"6".repeat(64)}`,
    recipientCount: 2,
    currentHandleCount: 1,
    quotedHandleCount: 2,
    messageDisposition: "direct_human_reply",
    effectCapability: "coordination_only",
    authorityFingerprint: `sha256:${"7".repeat(64)}`,
    effect: null,
    effectRequestSuppressed: false,
    containsCredentialShapedCurrentReply: false,
    humanIdentityEstablished: false,
    grantsAuthority: false,
    grantsResponsibility: false,
    grantsApproval: false,
    providerDispatchAuthorized: false,
    containsRawMailBody: false,
    containsQuotedMailBody: false,
    attachmentsAdmitted: false,
    ...overrides,
  };
  const { admissionFingerprint: _unused, ...withoutFingerprint } = base as any;
  return {
    ...withoutFingerprint,
    admissionFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  };
}

function serviceArgs() {
  return {
    serviceSecret,
    workspace: "test",
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
