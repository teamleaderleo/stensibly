import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/canonical-json.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import {
  MailDeliveryPendingReconciliationError,
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service.ts";
import {
  createMailThreadHandle,
  type MailThreadClass,
} from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const mailbox = Object.freeze({
  provider: "fake",
  accountBinding: "operator_primary",
  mailboxAddress: "operator@example.com",
});

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 15, 6, 0, tick++)).toISOString();
}

function factories(tokens: string[]) {
  let thread = 0;
  let token = 0;
  return {
    threadIdFactory: () => `mail_thread_test_${++thread}`,
    handleFactory: (threadClass: MailThreadClass) => {
      const next = tokens[token++];
      if (!next) throw new Error("test handle sequence exhausted");
      return createMailThreadHandle(threadClass, next);
    },
  };
}

function command(
  overrides: Partial<PublishMailThreadCommand> = {},
): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity: "attention:stensibly:1492",
    canonicalSubject: "Continue outbound mail threads",
    sourceFingerprint: sha256("attention-1"),
    whatChanged: "The first outbound mail candidate is ready.",
    attentionReason: "A fresh worker can continue from the durable handoff.",
    nextAction: "Inspect exact revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.",
    sourceObject: "github:teamleaderleo/stensibly#1492",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "Exact candidate is accepted or one repair is recorded.",
    threadState: "open",
    references: [{
      label: "Issue",
      reference: "https://github.com/teamleaderleo/stensibly/issues/1492",
    }],
    mailbox,
    ...overrides,
  };
}

describe("outbound mail service", () => {
  test("creates once, suppresses exact replay, replies on material change, resolves, and splits with ancestry", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const provider = new InMemoryMailProvider();
    const service = new MailOutboundService({
      store,
      provider,
      now: clock(),
      ...factories(["7K3Q", "4PF2"]),
    });

    const first = await service.publish(command());
    expect(first.outcome).toBe("sent");
    expect(first.thread.handle).toBe("STN-HANDOFF:7K3Q");
    expect(first.receipt.providerThreadId).toBeTruthy();
    expect(first.thread.threadId).not.toBe(first.receipt.providerThreadId);
    expect(provider.sentMessageCount).toBe(1);

    const replay = await service.publish(command());
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt.outboundEffectId).toBe(first.receipt.outboundEffectId);
    expect(replay.receipt.providerMessageId).toBe(first.receipt.providerMessageId);
    expect(provider.sentMessageCount).toBe(1);

    const changed = await service.publish(command({
      sourceFingerprint: sha256("attention-2"),
      whatChanged: "A repaired exact candidate is ready.",
      nextAction: "Inspect exact revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.",
      sourceRevision: "b".repeat(40),
    }));
    expect(changed.outcome).toBe("sent");
    expect(changed.thread.threadId).toBe(first.thread.threadId);
    expect(changed.thread.handle).toBe(first.thread.handle);
    expect(changed.receipt.providerThreadId).toBe(first.receipt.providerThreadId);
    expect(changed.receipt.outboundEffectId).not.toBe(first.receipt.outboundEffectId);
    expect(provider.sentMessageCount).toBe(2);

    const messages = provider.messagesForThread(first.receipt.providerThreadId!);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.inReplyTo).toBe(messages[0]!.rfcMessageId);
    expect(messages[1]!.references).toEqual([messages[0]!.rfcMessageId]);

    const resolved = await service.publish(command({
      sourceFingerprint: sha256("attention-3"),
      whatChanged: "The exact candidate was accepted.",
      attentionReason: "This terminal update closes the continuation.",
      nextAction: "Archive the resolved handoff.",
      sourceRevision: "b".repeat(40),
      resolutionCondition: "Accepted candidate recorded.",
      threadState: "resolved",
    }));
    expect(resolved.outcome).toBe("sent");
    expect(resolved.thread.state).toBe("resolved");
    expect(resolved.thread.resolvedAt).toBeTruthy();
    expect(resolved.receipt.providerThreadId).toBe(first.receipt.providerThreadId);
    expect(provider.sentMessageCount).toBe(3);

    const child = await service.publish(command({
      threadClass: "decision",
      sourceIdentity: "attention:stensibly:1492:deployment",
      canonicalSubject: "Decide deployment follow-up",
      sourceFingerprint: sha256("decision-1"),
      whatChanged: "Deployment became a separate decision.",
      attentionReason: "The question is independent from the completed implementation handoff.",
      nextAction: "Choose the deployment window.",
      sourceRevision: "b".repeat(40),
      resolutionCondition: "Deployment window recorded.",
      continuesFromHandle: first.thread.handle,
    }));
    expect(child.thread.handle).toBe("STN-DECISION:4PF2");
    expect(child.thread.continuesFromThreadId).toBe(first.thread.threadId);
    expect(child.receipt.providerThreadId).not.toBe(first.receipt.providerThreadId);
    expect(provider.sentMessageCount).toBe(4);
    store.close();
  });

  test("holds an ambiguous provider success for reconciliation before any resend", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const provider = new InMemoryMailProvider();
    provider.setMode("ambiguous_after_send");
    const service = new MailOutboundService({
      store,
      provider,
      now: clock(),
      ...factories(["7K3Q"]),
    });

    let pending: MailDeliveryPendingReconciliationError | null = null;
    try {
      await service.publish(command());
    } catch (error) {
      if (error instanceof MailDeliveryPendingReconciliationError) pending = error;
      else throw error;
    }
    expect(pending).not.toBeNull();
    expect(pending!.effect.state).toBe("ambiguous");
    expect(pending!.effect.receipt?.recoveryAction).toBe("reconcile_before_retry");
    expect(provider.sentMessageCount).toBe(1);

    await expect(service.publish(command())).rejects.toBeInstanceOf(
      MailDeliveryPendingReconciliationError,
    );
    expect(provider.sentMessageCount).toBe(1);

    provider.setMode("normal");
    const reconciled = await service.reconcile({
      outboundEffectId: pending!.effect.outboundEffectId,
      mailbox,
    });
    expect(reconciled?.outcome).toBe("reconciled");
    expect(reconciled?.receipt.result).toBe("reconciled");
    expect(reconciled?.receipt.providerThreadId).toBeTruthy();
    expect(provider.sentMessageCount).toBe(1);

    const replay = await service.publish(command());
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt.result).toBe("reconciled");
    expect(provider.sentMessageCount).toBe(1);
    store.close();
  });

  test("persists canonical handle, provider projection, and replay receipt across store instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stensibly-mail-store-"));
    const path = join(directory, "mail.sqlite");
    try {
      const provider = new InMemoryMailProvider();
      const firstStore = new SqliteMailThreadStore({ path });
      const firstService = new MailOutboundService({
        store: firstStore,
        provider,
        now: clock(),
        ...factories(["7K3Q"]),
      });
      const first = await firstService.publish(command());
      firstStore.close();
      expect(provider.sentMessageCount).toBe(1);

      const secondStore = new SqliteMailThreadStore({ path });
      const secondService = new MailOutboundService({
        store: secondStore,
        provider,
        now: clock(),
        ...factories(["9MNP"]),
      });
      const replay = await secondService.publish(command());
      expect(replay.outcome).toBe("replayed");
      expect(replay.thread.threadId).toBe(first.thread.threadId);
      expect(replay.thread.handle).toBe("STN-HANDOFF:7K3Q");
      expect(replay.receipt.outboundEffectId).toBe(first.receipt.outboundEffectId);
      expect(provider.sentMessageCount).toBe(1);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
