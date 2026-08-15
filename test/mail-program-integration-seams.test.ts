import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/canonical-json.ts";
import {
  classifyGitHubMailReply,
  type GitHubMailThreadBinding,
} from "../src/github-mail-bridge.ts";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider.ts";
import {
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service.ts";
import {
  createMailThreadHandle,
  type MailThreadHandle,
} from "../src/mail-thread-contract.ts";
import { SqliteMailThreadStore } from "../src/mail-thread-store.ts";
import {
  renderMaterialMailMessage,
  type MailThreadSnapshot,
} from "../src/mail-ux-projection.ts";
import type { MailOutboundEffectRecord } from "../src/mail-provider.ts";

const repository = "teamleaderleo/stensibly";
const revision = "a".repeat(40);
const canonicalLongHandle = createMailThreadHandle("handoff", "23456789ABCD");

function uxThread(handle: string): MailThreadSnapshot {
  return {
    handle,
    attentionClass: "handoff",
    title: "Continue P0 email integration",
    changed: "One compact continuation checkpoint is ready.",
    current: `github:${repository}#1488 at ${revision}`,
    nextAction: "Refresh the exact GitHub state before acting.",
    resolution: "One fresh worker can continue from the newest checkpoint.",
    strongestSource: `github:${repository}#1488`,
    state: "active",
    updatedAt: "2026-08-15T06:30:00.000Z",
    actionableAt: "2026-08-15T06:30:00.000Z",
    resolvedAt: null,
  };
}

function bridgeReply(handle: string) {
  const thread: GitHubMailThreadBinding = {
    version: 1,
    threadId: "mail_thread_1488_integration",
    handle,
    project: "stensibly",
    repository,
    pullRequestNumber: 1497,
    currentHeadRevision: revision,
    continuesFromThreadId: null,
  };
  return {
    thread,
    provider: "gmail" as const,
    mailboxBindingId: "operator_primary",
    providerThreadId: "gmail-thread-1488",
    providerMessageId: "gmail-message-1488",
    inReplyToMessageId: "gmail-message-root",
    replyClass: "mail.handoff" as const,
    body: "Continue from the compact checkpoint.",
    expectedTargetSourceRevision: "issue-revision-1488",
    expectedHeadRevision: revision,
    causal: {
      rootId: "mail-program-integration-root",
      predecessorId: null,
      depth: 0,
      fanOut: 0,
    },
  };
}

function publishCommand(
  overrides: Partial<PublishMailThreadCommand> = {},
): PublishMailThreadCommand {
  return {
    workspace: "workspace_main",
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity: "attention:stensibly:1488:integration",
    canonicalSubject: "Continue P0 email integration",
    sourceFingerprint: sha256("integration-1"),
    whatChanged: "The P0 mail integration checkpoint is ready.",
    attentionReason: "A fresh worker has one bounded continuation to inspect.",
    nextAction: "Refresh issue 1488 and the exact current GitHub revision.",
    sourceObject: `github:${repository}#1488`,
    sourceRevision: revision,
    blocker: null,
    resolutionCondition: "The fresh worker records one exact continuation result.",
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
    ...overrides,
  };
}

describe("P0 email programme integration seams", () => {
  test("uses one eye-safe STN handle grammar across outbound, UX, and GitHub bridge", () => {
    expect(canonicalLongHandle).toBe("STN-HANDOFF:23456789ABCD");

    const material = renderMaterialMailMessage(uxThread(canonicalLongHandle));
    expect(material.launchLine).toBe(`Continue ${canonicalLongHandle}.`);

    expect(() => classifyGitHubMailReply(bridgeReply("STN-HANDOFF:O0O0")))
      .toThrow("STN mail handle is invalid");
  });

  test("keeps the routed checkpoint compact instead of quoting prior material", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const provider = new InMemoryMailProvider("gmail");
    const service = new MailOutboundService({
      store,
      provider,
      now: () => "2026-08-15T06:40:00.000Z",
      threadIdFactory: () => "mail_thread_1488_compact",
      handleFactory: () => "STN-HANDOFF:K8R4" as MailThreadHandle,
    });

    const first = await service.publish(publishCommand());
    expect(first.envelope.launchLine).toBe(
      "In Gmail, continue STN-HANDOFF:K8R4. Then refresh the referenced GitHub state.",
    );

    const second = await service.publish(publishCommand({
      sourceFingerprint: sha256("integration-2"),
      whatChanged: "A newer exact candidate replaced the first checkpoint.",
      sourceRevision: "b".repeat(40),
    }));

    const messages = provider.messagesForThread(first.receipt.providerThreadId!);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.body).toContain("A newer exact candidate replaced the first checkpoint.");
    expect(messages[1]!.body).not.toContain("The P0 mail integration checkpoint is ready.");
    expect(second.receipt.providerThreadId).toBe(first.receipt.providerThreadId);
  });

  test("can recover a delivered provider message identity from durable outbound state after restart", async () => {
    const store = new SqliteMailThreadStore({ path: ":memory:" });
    const provider = new InMemoryMailProvider("gmail");
    const service = new MailOutboundService({
      store,
      provider,
      now: () => "2026-08-15T06:45:00.000Z",
      threadIdFactory: () => "mail_thread_1488_echo",
      handleFactory: () => "STN-HANDOFF:K8R4" as MailThreadHandle,
    });

    const sent = await service.publish(publishCommand({
      sourceIdentity: "attention:stensibly:1488:self-echo",
    }));
    const providerMessageId = sent.receipt.providerMessageId;
    expect(providerMessageId).toBeTruthy();

    type DurableEchoLookup = {
      getDeliveryEffectByProviderMessageId?: (
        provider: string,
        accountBinding: string,
        providerMessageId: string,
      ) => Promise<MailOutboundEffectRecord | null>;
    };
    const durable = store as unknown as DurableEchoLookup;
    expect(typeof durable.getDeliveryEffectByProviderMessageId).toBe("function");

    const effect = await durable.getDeliveryEffectByProviderMessageId!(
      "gmail",
      "operator_primary",
      providerMessageId!,
    );
    expect(effect?.receipt?.providerMessageId).toBe(providerMessageId);
    expect(effect?.receipt?.result).toBe("sent");
  });
});
