import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const secret = "test-service-secret";
const workspace = "test";
const actor = { id: "receipt-agent", name: "Receipt Agent", kind: "agent" as const };

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", secret);
});

describe("hosted operation receipts", () => {
  test("reconciles item, event, and artifact mutations", async () => {
    const t = convexTest(schema, modules);
    const item = await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      kind: "task",
      title: "Reconcile hosted operations",
      priority: 90,
      actor,
      idempotencyKey: "hosted-create",
    }) as any;

    const created = await t.query(convexApi.operationReceipts.get, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      idempotencyKey: "hosted-create",
    }) as any;
    expect(created).toMatchObject({
      status: "recorded",
      operation: "item.created",
      itemId: item.id,
      result: { kind: "item", id: item.id },
      reconciliation: { retry: "do_not_retry", nextAction: "read_item" },
    });

    const event = await t.mutation(convexApi.events.record, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor,
      type: "progress.receipt_test",
      payload: { privateDetail: "omit from receipt" },
      idempotencyKey: "hosted-event",
    }) as any;
    const recordedEvent = await t.query(convexApi.operationReceipts.get, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      idempotencyKey: "hosted-event",
    }) as any;
    expect(recordedEvent).toMatchObject({
      status: "recorded",
      operation: "progress.receipt_test",
      eventId: event.id,
      result: { kind: "event", id: event.id },
    });
    expect(JSON.stringify(recordedEvent)).not.toContain("privateDetail");

    const artifact = await t.mutation(convexApi.artifacts.attach, {
      serviceSecret: secret,
      workspace,
      id: item.id,
      actor,
      kind: "commit",
      label: "Hosted receipt implementation",
      uri: "git:teamleaderleo/stensibly@hosted-receipt",
      metadata: { privateNote: "omit from receipt" },
      idempotencyKey: "hosted-artifact",
    }) as any;
    const recordedArtifact = await t.query(convexApi.operationReceipts.get, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      idempotencyKey: "hosted-artifact",
    }) as any;
    expect(recordedArtifact).toMatchObject({
      status: "recorded",
      operation: "artifact.attached",
      itemId: item.id,
      result: { kind: "artifact", id: artifact.id },
    });
    expect(JSON.stringify(recordedArtifact)).not.toContain("privateNote");
  });

  test("holds missing and cross-project records without exposing key occupancy", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(convexApi.items.create, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      kind: "task",
      title: "Alpha-only operation",
      priority: 50,
      actor,
      idempotencyKey: "hosted-alpha-private",
    });

    const expectedUnknown = {
      status: "unknown",
      reconciliation: {
        retry: "hold",
        nextAction: "verify_project_scope_before_retry",
      },
    };
    const missing = await t.query(convexApi.operationReceipts.get, {
      serviceSecret: secret,
      workspace,
      project: "alpha",
      idempotencyKey: "missing-key",
    }) as any;
    const crossProject = await t.query(convexApi.operationReceipts.get, {
      serviceSecret: secret,
      workspace,
      project: "beta",
      idempotencyKey: "hosted-alpha-private",
    }) as any;
    expect(missing).toMatchObject(expectedUnknown);
    expect(crossProject).toMatchObject(expectedUnknown);
    expect(missing.reconciliation).toEqual(crossProject.reconciliation);
  });
});
