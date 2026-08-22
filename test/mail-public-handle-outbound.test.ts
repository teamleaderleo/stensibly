import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import {
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service.ts";
import { createMailThreadHandle } from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";

const mailbox = Object.freeze({
  provider: "fake",
  accountBinding: "operator_primary",
  mailboxAddress: "operator@example.com",
});

function command(
  overrides: Partial<PublishMailThreadCommand> = {},
): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "quarry",
    threadClass: "handoff",
    sourceIdentity: "github:Coreys-Quarry/quarry#246",
    canonicalSubject: "Quarry mail continuation",
    sourceFingerprint: sha256("quarry-checkpoint-1"),
    whatChanged: "The Quarry candidate reached a material continuation boundary.",
    attentionReason: "A fresh worker has a bounded next action.",
    nextAction: "Refresh the referenced GitHub state and continue the current lane.",
    sourceObject: "github:Coreys-Quarry/quarry#246",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "The current lane is reviewed, reanchored, or resolved.",
    threadState: "open",
    continuationRoute: {
      mailProvider: "Gmail",
      sourceSystem: "GitHub",
    },
    publicProjectCode: "QRY",
    mailbox,
    ...overrides,
  };
}

describe("project-owned public handle outbound rendering", () => {
  test("shows QRY publicly while internal thread and effect identity stay STN", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const provider = new InMemoryMailProvider();
    const service = new MailOutboundService({
      store,
      provider,
      now: () => "2026-08-23T03:30:00.000Z",
      threadIdFactory: () => "mail_thread_quarry_q7r4",
      handleFactory: (threadClass) => createMailThreadHandle(threadClass, "Q7R4"),
    });

    const first = await service.publish(command());

    expect(first.thread.handle).toBe("STN-HANDOFF:Q7R4");
    expect(first.envelope.handle).toBe("STN-HANDOFF:Q7R4");
    expect(first.receipt.handle).toBe("STN-HANDOFF:Q7R4");
    expect(first.envelope.subject).toBe("[QRY-HANDOFF:Q7R4] Quarry mail continuation");
    expect(first.envelope.launchLine).toBe(
      "In Gmail, continue QRY-HANDOFF:Q7R4. Then refresh the referenced GitHub state.",
    );
    expect(first.envelope.body).toContain("\n\nHandle: QRY-HANDOFF:Q7R4\n");

    const providerThreadId = first.receipt.providerThreadId;
    if (providerThreadId === null) throw new Error("Expected provider thread identity");
    const messages = provider.messagesForThread(providerThreadId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.handle).toBe("STN-HANDOFF:Q7R4");
    expect(messages[0]!.subject).toBe(first.envelope.subject);
    expect(messages[0]!.body).toBe(first.envelope.body);

    const replay = await service.publish(command());
    expect(replay.outcome).toBe("replayed");
    expect(replay.receipt.outboundEffectId).toBe(first.receipt.outboundEffectId);
    expect(provider.sentMessageCount).toBe(1);
    store.close();
  });

  test("rejects a confusing project code before provider dispatch", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const provider = new InMemoryMailProvider();
    const service = new MailOutboundService({
      store,
      provider,
      now: () => "2026-08-23T03:30:00.000Z",
      threadIdFactory: () => "mail_thread_quarry_invalid",
      handleFactory: (threadClass) => createMailThreadHandle(threadClass, "Q7R4"),
    });

    await expect(service.publish(command({ publicProjectCode: "Q0I" }))).rejects.toThrow(
      "Mail project code is invalid",
    );
    expect(provider.sentMessageCount).toBe(0);
    store.close();
  });
});
