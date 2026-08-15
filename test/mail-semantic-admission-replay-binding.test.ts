import { describe, expect, test } from "bun:test";
import {
  MailSemanticAdmissionService,
  type CanonicalMailReplyBindingCandidate,
  type MailSemanticAdmissionEvidence,
  type MailSemanticAdmissionStore,
  type PostCommitMaterialMailboxObservation,
} from "../src/mail-semantic-admission.ts";
import type { GmailSemanticMessageSource } from "../src/gmail-semantic-message-client.ts";

const head = "a".repeat(40);
const observation: PostCommitMaterialMailboxObservation = {
  observationId: "mailbox:gmail:history:9201:message:m-replay:scope-added:Label_5",
  semanticFingerprint: `sha256:${"1".repeat(64)}`,
  provider: "gmail",
  eventType: "mail.scope.added",
  providerCursor: "9201",
  providerMessageId: "m-replay",
  providerThreadId: "t-replay",
  observedAt: "2026-08-15T07:20:00.000Z",
  receivedAt: "2026-08-15T07:20:01.000Z",
  wakeEligible: true,
  loopDisposition: "ordinary",
  containsRawContent: false,
  grantsAuthority: false,
};

class Store implements MailSemanticAdmissionStore {
  value: MailSemanticAdmissionEvidence | null = null;
  async get() {
    return this.value;
  }
  async admit(evidence: MailSemanticAdmissionEvidence) {
    if (this.value) return { duplicate: true, evidence: this.value };
    this.value = evidence;
    return { duplicate: false, evidence };
  }
}

describe("mail semantic replay binding", () => {
  test("same provider message conflicts if canonical STN binding moves", async () => {
    let candidate = binding({ threadId: "attn_original" });
    const store = new Store();
    const service = serviceFor(() => candidate, store);
    const first = await admit(service);
    expect(first.replay).toBe(false);

    candidate = binding({ threadId: "attn_other" });
    await expect(admit(service)).rejects.toMatchObject({
      code: "MAIL_SEMANTIC_REPLAY_BINDING_CONFLICT",
    });
  });

  test("same provider message conflicts if durable effect capability changes", async () => {
    let candidate = binding({ effectCapability: "coordination_only" });
    const store = new Store();
    const service = serviceFor(() => candidate, store);
    await admit(service);

    candidate = binding({ effectCapability: "github_conversation_comment" });
    await expect(admit(service)).rejects.toMatchObject({
      code: "MAIL_SEMANTIC_REPLAY_BINDING_CONFLICT",
    });
  });

  test("same provider message conflicts if durable mailbox destination alias changes", async () => {
    let candidate = binding({ expectedMailboxAddress: "leoli.4u@gmail.com" });
    const store = new Store();
    const service = serviceFor(() => candidate, store);
    await admit(service);

    candidate = binding({ expectedMailboxAddress: "leoli.4u+relay@gmail.com" });
    await expect(admit(service)).rejects.toMatchObject({
      code: "MAIL_SEMANTIC_REPLAY_BINDING_CONFLICT",
    });
  });
});

function serviceFor(
  current: () => CanonicalMailReplyBindingCandidate,
  store: Store,
) {
  const messages: GmailSemanticMessageSource = {
    async fetchAdmittedMessage() {
      return gmailMessage();
    },
  };
  return new MailSemanticAdmissionService({
    bindings: {
      async resolve() {
        return [current()];
      },
    },
    messages,
    store,
  });
}

async function admit(service: MailSemanticAdmissionService) {
  return await service.admitMaterialGmailObservation({
    mailboxBindingId: "gmail_operator_primary",
    observation,
  });
}

function binding(input: {
  threadId?: string;
  effectCapability?: CanonicalMailReplyBindingCandidate["effectCapability"];
  expectedMailboxAddress?: string;
} = {}): CanonicalMailReplyBindingCandidate {
  const threadId = input.threadId ?? "attn_original";
  return {
    version: 1,
    provider: "gmail",
    mailboxBindingId: "gmail_operator_primary",
    expectedMailboxAddress: input.expectedMailboxAddress ?? "leoli.4u@gmail.com",
    providerThreadId: "t-replay",
    expectedInReplyToProviderMessageId: "m-root",
    expectedInReplyToRfcMessageId: "<root-replay@stensibly.invalid>",
    thread: {
      version: 1,
      threadId,
      handle: threadId === "attn_original" ? "STN-REVIEW:7K3R" : "STN-REVIEW:8K4R",
      project: "stensibly",
      repository: "teamleaderleo/stensibly",
      pullRequestNumber: 1491,
      currentHeadRevision: head,
      continuesFromThreadId: null,
    },
    expectedTargetSourceRevision: "github:teamleaderleo/stensibly#1491:source:43",
    expectedHeadRevision: head,
    causal: {
      rootId: "attn_original",
      predecessorId: "mail-outbound:m-root",
      depth: 1,
      fanOut: 1,
    },
    effectCapability: input.effectCapability ?? "coordination_only",
    formalReviewVerdict: null,
  };
}

function gmailMessage(): unknown {
  return {
    id: "m-replay",
    threadId: "t-replay",
    payload: {
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "Message-ID", value: "<reply-replay@example.invalid>" },
        { name: "In-Reply-To", value: "<root-replay@stensibly.invalid>" },
        { name: "From", value: "Visible <visible@example.invalid>" },
        { name: "To", value: "leoli.4u@gmail.com" },
        { name: "Subject", value: "Re: replay binding" },
      ],
      body: { data: base64url("ACK") },
    },
  };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}
