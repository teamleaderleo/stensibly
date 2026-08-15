import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import { HostedMailboxIntakeService } from "../src/mailbox-intake-convex-service.ts";

class FakeClient implements ConvexCaller {
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  queryResult: unknown;

  async mutation(
    _reference: FunctionReference<"mutation">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error("unexpected mutation");
  }

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: String(reference), args });
    return this.queryResult;
  }
}

test("reads only durable wake-eligible ordinary mailbox observations for downstream drain", async () => {
  const client = new FakeClient();
  client.queryResult = [
    observation("material", true, "ordinary"),
    observation("self-echo", false, "self_echo"),
    observation("routine", false, "ordinary"),
  ];
  const service = new HostedMailboxIntakeService({
    client,
    serviceSecret: "service-secret",
    workspace: "default",
  });

  const result = await service.listRecentMaterialObservations("gmail_operator_primary", 20);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    observationId: "material",
    providerMessageId: "message-material",
    wakeEligible: true,
    loopDisposition: "ordinary",
    containsRawContent: false,
    grantsAuthority: false,
  });
  expect(client.queries[0]?.args).toEqual({
    mailboxBindingId: "gmail_operator_primary",
    limit: 20,
    serviceSecret: "service-secret",
    workspace: "default",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
});

function observation(
  id: string,
  wakeEligible: boolean,
  loopDisposition: "ordinary" | "self_echo",
): Record<string, unknown> {
  return {
    observationId: id,
    semanticFingerprint: `sha256:${"a".repeat(64)}`,
    provider: "gmail",
    eventType: "mail.message.created",
    providerCursor: "101",
    providerMessageId: `message-${id}`,
    providerThreadId: `thread-${id}`,
    providerLabelId: null,
    observedAt: "2026-08-15T06:45:30.000Z",
    receivedAt: "2026-08-15T06:45:31.000Z",
    wakeEligible,
    loopDisposition,
    containsRawContent: false,
    grantsAuthority: false,
  };
}
