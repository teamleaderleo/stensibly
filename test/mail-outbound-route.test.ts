import { expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import {
  type MailContinuationRoute,
} from "../src/mail-outbound-envelope.ts";
import { MailOutboundService } from "../src/mail-outbound-service.ts";
import { createMailThreadHandle } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const mailbox = {
  provider: "fake",
  accountBinding: "operator_primary",
  mailboxAddress: "operator@example.com",
};

function command(
  sourceIdentity: string,
  continuationRoute?: MailContinuationRoute | null,
) {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff" as const,
    sourceIdentity,
    canonicalSubject: "Continue outbound mail route",
    sourceFingerprint: sha256(sourceIdentity),
    whatChanged: "A continuation is ready.",
    attentionReason: "A fresh worker can continue it.",
    nextAction: "Refresh the source and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1492",
    resolutionCondition: "Continuation is accepted.",
    threadState: "open" as const,
    continuationRoute,
    mailbox,
  };
}

test("service keeps the pure envelope route neutral unless the caller chooses a provider route", async () => {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const provider = new InMemoryMailProvider();
  let handle = 0;
  const handles = ["7K3Q", "4PF2"];
  const service = new MailOutboundService({
    store,
    provider,
    now: () => "2026-08-15T06:45:00.000Z",
    threadIdFactory: () => `mail_thread_route_${handle + 1}`,
    handleFactory: () => createMailThreadHandle("handoff", handles[handle++]!),
  });

  const neutral = await service.publish(command("attention:route:neutral"));
  const neutralMessage = provider.messagesForThread(neutral.receipt.providerThreadId!)[0]!;
  expect(neutralMessage.body).toStartWith(`Continue ${neutral.thread.handle}.\n`);

  const routed = await service.publish(command(
    "attention:route:gmail",
    { mailProvider: "Gmail", sourceSystem: "GitHub" },
  ));
  const routedMessage = provider.messagesForThread(routed.receipt.providerThreadId!)[0]!;
  expect(routedMessage.body).toStartWith(
    `In Gmail, continue ${routed.thread.handle}. Then refresh the referenced GitHub state.\n`,
  );
  store.close();
});
