import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/canonical-json.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import {
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service.ts";
import { createMailThreadHandle } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

function command(
  sourceIdentity: string,
  sourceFingerprint = sha256("retry-self-echo"),
): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity,
    canonicalSubject: "Continue bounded outbound mail",
    sourceFingerprint,
    whatChanged: "One exact continuation is ready.",
    attentionReason: "A fresh worker can continue it.",
    nextAction: "Refresh the exact source and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1497",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "The continuation is accepted.",
    threadState: "open",
    continuationRoute: {
      mailProvider: "Gmail",
      sourceSystem: "GitHub",
    },
    mailbox: {
      provider: "gmail",
      accountBinding: "operator_primary",
      mailboxAddress: "operator@example.com",
    },
  };
}

test("a definite failure can retry the same canonical material with a new attempt", async () => {
  const store = new SqliteMailThreadStore({ path: ":memory:" });
  const provider = new InMemoryMailProvider("gmail");
  const service = new MailOutboundService({
    store,
    provider,
    now: () => "2026-08-15T06:50:00.000Z",
    threadIdFactory: () => "mail_thread_retry",
    handleFactory: () => createMailThreadHandle("handoff", "K8R4"),
  });

  provider.setMode("definite_failure");
  const first = await service.publish(command("attention:retry"));
  expect(first.outcome).toBe("failed");
  expect(first.receipt.attemptNumber).toBe(1);
  expect(first.receipt.recoveryAction).toBe("retry_new_attempt");
  expect(provider.sentMessageCount).toBe(0);

  provider.setMode("normal");
  const second = await service.publish(command("attention:retry"));
  expect(second.outcome).toBe("sent");
  expect(second.receipt.attemptNumber).toBe(2);
  expect(second.receipt.outboundEffectId).not.toBe(first.receipt.outboundEffectId);
  expect(second.receipt.rfcMessageId).not.toBe(first.receipt.rfcMessageId);
  expect(provider.sentMessageCount).toBe(1);

  const replay = await service.publish(command("attention:retry"));
  expect(replay.outcome).toBe("replayed");
  expect(replay.receipt.outboundEffectId).toBe(second.receipt.outboundEffectId);
  expect(replay.receipt.attemptNumber).toBe(2);
  expect(provider.sentMessageCount).toBe(1);
  store.close();
});

test("a delivered provider message identity survives a SQLite store restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stensibly-mail-echo-"));
  const path = join(directory, "mail.db");
  try {
    const provider = new InMemoryMailProvider("gmail");
    const firstStore = new SqliteMailThreadStore({ path });
    const service = new MailOutboundService({
      store: firstStore,
      provider,
      now: () => "2026-08-15T06:51:00.000Z",
      threadIdFactory: () => "mail_thread_echo_restart",
      handleFactory: () => createMailThreadHandle("handoff", "Q7MP"),
    });

    const sent = await service.publish(command("attention:self-echo"));
    expect(sent.outcome).toBe("sent");
    expect(sent.receipt.providerMessageId).toBeTruthy();
    firstStore.close();

    const reopened = new SqliteMailThreadStore({ path });
    const effect = await reopened.getDeliveryEffectByProviderMessageId(
      "gmail",
      "operator_primary",
      sent.receipt.providerMessageId!,
    );
    expect(effect?.outboundEffectId).toBe(sent.receipt.outboundEffectId);
    expect(effect?.state).toBe("sent");
    expect(effect?.receipt?.providerMessageId).toBe(sent.receipt.providerMessageId);
    expect(effect?.receipt?.result).toBe("sent");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
